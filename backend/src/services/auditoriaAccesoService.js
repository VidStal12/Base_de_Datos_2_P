const prisma = require('../config/prisma');
const AuditoriaAcceso = require('../models/mongo/AuditoriaAcceso');
const { conectar } = require('../config/mongo');
const { registrarFallo } = require('../utils/resiliencia');

// El registro de quién cambió qué permiso y de los accesos que se denegaron (IA/ADR-007 §9), en la colección de
// MongoDB `auditoria_acceso`, que el servidor web solo puede leer e insertar. Es de MEJOR ESFUERZO: no registrar no
// debe impedir ni un cambio de permisos (si Mongo está apagado y hay que revocar un acceso, se revoca) ni una
// respuesta 403. La tabla acl_regla guarda aparte, en MySQL, quién cambió cada regla y cuándo.

const FILTRO_CAMBIOS = { $ne: 'denegacion' };
const TOPE_CSV = 5000;
const TAMANO_MAXIMO = 100;

async function registrarVarios(eventos) {
  if (eventos.length === 0) return true;
  try {
    await conectar();
    await AuditoriaAcceso.insertMany(eventos, { ordered: false });
    return true;
  } catch (err) {
    registrarFallo('No se pudo registrar en la auditoría de accesos', err);
    return false;
  }
}

const registrar = (evento) => registrarVarios([evento]);

// Un rol sin permiso que insiste (un botón que se pulsa diez veces, un script) llenaría el registro: la misma
// cuenta en la misma ruta se anota una vez por minuto. Se escribe en segundo plano: la respuesta 403 no espera.
const VENTANA_DENEGACION_MS = 60000;
const MAXIMO_VISTAS = 500;
const vistas = new Map();

function registrarDenegacion(usuario, ruta, rolVigente) {
  const ahora = Date.now();
  const clave = `${usuario?.id_usuario}|${ruta}`;
  const ultima = vistas.get(clave);
  if (ultima !== undefined && ahora - ultima < VENTANA_DENEGACION_MS) return false;
  vistas.set(clave, ahora);
  if (vistas.size > MAXIMO_VISTAS) {
    for (const [k, t] of vistas) if (ahora - t >= VENTANA_DENEGACION_MS) vistas.delete(k);
    for (const k of [...vistas.keys()].slice(0, Math.max(0, vistas.size - MAXIMO_VISTAS))) vistas.delete(k);
  }
  registrar({
    tipo: 'denegacion',
    actor: { id: usuario?.id_usuario, rol: rolVigente ?? usuario?.rol },
    objetivo: { tipo: 'ruta', id: ruta },
    detalle: 'ACL_DENEGADO',
  });
  return true;
}

// ---------- Lectura ----------

function errorDeFiltro(mensaje) {
  return Object.assign(new Error(mensaje), { status: 400 });
}

// Las fechas del filtro son días de Guatemala (UTC−6), como el panel de ventas.
function limitesDelDia(texto, fin) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(texto)) throw errorDeFiltro('Las fechas se escriben AAAA-MM-DD');
  const inicio = new Date(`${texto}T06:00:00.000Z`);
  if (Number.isNaN(inicio.getTime())) throw errorDeFiltro('La fecha no es válida');
  return fin ? new Date(inicio.getTime() + 86400000 - 1) : inicio;
}

async function idsDeActor(texto) {
  if (/^\d+$/.test(texto)) return [Number(texto)];
  const filas = await prisma.usuarios.findMany({
    where: { OR: [{ correo: { contains: texto } }, { nombres: { contains: texto } }, { apellidos: { contains: texto } }] },
    select: { id_usuario: true },
    take: 100,
  });
  return filas.map((f) => f.id_usuario);
}

async function construirFiltro({ tipo, actor, desde, hasta } = {}) {
  const filtro = {};
  if (tipo === 'cambios') filtro.tipo = FILTRO_CAMBIOS;
  else if (tipo) {
    if (!AuditoriaAcceso.TIPOS.includes(tipo)) throw errorDeFiltro(`Tipo de registro desconocido: «${tipo}»`);
    filtro.tipo = tipo;
  }
  if (actor && String(actor).trim()) filtro['actor.id'] = { $in: await idsDeActor(String(actor).trim()) };
  if (desde || hasta) {
    filtro.fecha = {};
    if (desde) filtro.fecha.$gte = limitesDelDia(String(desde), false);
    if (hasta) filtro.fecha.$lte = limitesDelDia(String(hasta), true);
  }
  return filtro;
}

async function resolverPersonas(ids) {
  const unicos = [...new Set(ids.filter(Number.isInteger))];
  if (unicos.length === 0) return new Map();
  try {
    const filas = await prisma.usuarios.findMany({
      where: { id_usuario: { in: unicos } },
      select: { id_usuario: true, nombres: true, apellidos: true, correo: true },
    });
    return new Map(filas.map((f) => [f.id_usuario, { nombre: `${f.nombres} ${f.apellidos}`.trim(), correo: f.correo }]));
  } catch (err) {
    registrarFallo('No se pudieron resolver los nombres del registro de auditoría', err);
    return new Map();
  }
}

// El documento de Mongo, más el nombre y el correo de las cuentas que nombra (si todavía existen).
async function enriquecer(docs) {
  const ids = docs.flatMap((d) => [d.actor?.id, d.objetivo?.tipo === 'usuario' ? Number(d.objetivo.id) : undefined]);
  const personas = await resolverPersonas(ids);
  return docs.map((d) => {
    const actor = personas.get(d.actor?.id);
    const objetivo = d.objetivo?.tipo === 'usuario' ? personas.get(Number(d.objetivo.id)) : undefined;
    return {
      id: String(d._id),
      tipo: d.tipo,
      fecha: d.fecha,
      actor: { ...d.actor, ...(actor ?? { eliminada: Number.isInteger(d.actor?.id) }) },
      objetivo: { ...d.objetivo, ...(objetivo ?? {}) },
      antes: d.antes ?? null,
      despues: d.despues ?? null,
      detalle: d.detalle ?? null,
    };
  });
}

async function listar(consulta = {}) {
  const filtro = await construirFiltro(consulta);
  const tamano = Math.min(TAMANO_MAXIMO, Math.max(1, Math.trunc(Number(consulta.tamano)) || 25));
  const pagina = Math.max(1, Math.trunc(Number(consulta.pagina)) || 1);
  await conectar();
  const [total, docs] = await Promise.all([
    AuditoriaAcceso.countDocuments(filtro),
    AuditoriaAcceso.find(filtro).sort({ fecha: -1, _id: -1 }).skip((pagina - 1) * tamano).limit(tamano).lean(),
  ]);
  return { total, pagina, tamano, paginas: Math.max(1, Math.ceil(total / tamano)), registros: await enriquecer(docs) };
}

// ---------- CSV ----------

// Una celda que empieza con = + - @ (o con tabulación o retorno) la ejecutaría una hoja de cálculo como fórmula:
// se antepone un apóstrofo (OWASP, «CSV injection»).
function celdaCsv(valor) {
  let texto = valor === null || valor === undefined ? '' : typeof valor === 'object' ? JSON.stringify(valor) : String(valor);
  if (/^[=+\-@\t\r]/.test(texto)) texto = `'${texto}`;
  return /[",\n\r]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
}

const COLUMNAS_CSV = ['fecha', 'tipo', 'actor_id', 'actor_nombre', 'actor_correo', 'actor_rol', 'objetivo_tipo', 'objetivo', 'objetivo_nombre', 'antes', 'despues', 'detalle'];

function aCsv(registros) {
  const filas = registros.map((r) => [
    new Date(r.fecha).toISOString(), r.tipo, r.actor?.id, r.actor?.nombre, r.actor?.correo, r.actor?.rol,
    r.objetivo?.tipo, r.objetivo?.id, r.objetivo?.nombre ?? r.objetivo?.correo, r.antes, r.despues, r.detalle,
  ]);
  return [COLUMNAS_CSV, ...filas].map((fila) => fila.map(celdaCsv).join(',')).join('\r\n');
}

async function exportarCsv(consulta = {}) {
  const filtro = await construirFiltro(consulta);
  await conectar();
  const docs = await AuditoriaAcceso.find(filtro).sort({ fecha: -1, _id: -1 }).limit(TOPE_CSV).lean();
  return aCsv(await enriquecer(docs));
}

module.exports = { registrar, registrarVarios, registrarDenegacion, listar, exportarCsv, aCsv, celdaCsv, limitesDelDia, TOPE_CSV };
