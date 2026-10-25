const prisma = require('../config/prisma');
const { RUTAS, ROLES, clave: claveDe, rutaPorClave } = require('../config/politicaRutas');
const auditoria = require('./auditoriaAccesoService');

// La política de acceso a la API que un administrador puede ajustar desde /admin/permisos (IA/ADR-007 §9).
//
// La BASE es el código: config/politicaRutas.js declara, ruta por ruta, qué roles entran (la lista blanca que prueba
// tests/accesoRutas.test.js). Esta tabla de acl_regla guarda solo las DIFERENCIAS («el rol X sí/no en la ruta Y»), y
// lo que no figura vale lo que declara el código: una ruta nueva funciona desde el primer día y «restaurar» es borrar
// filas. Tres límites, comprobados al decidir y no solo al escribir (una fila metida a mano en MySQL no los salta):
//   - solo cuentan las reglas de rutas declaradas `editable` (lo editable se declara a propósito, lo demás es fijo);
//   - el administrador conserva todas las rutas: ninguna regla lo toca, así nadie puede quedarse sin acceso;
//   - sin regla ni declaración, se niega.
//
// Rendimiento y fallas: la política se lee de MySQL a lo sumo cada TTL_MS por proceso y se invalida al instante en el
// proceso que escribe (con varios procesos, un cambio llega en ≤ 5 s). Si MySQL no responde se conserva la última
// copia; sin copia (arranque en frío con MySQL apagado) rige lo que declara el código y se avisa en el log. Costo
// declarado: en ese caso una revocación hecha desde la pantalla no se aplica hasta que MySQL vuelva.

const ADMINISTRADOR = 'administrador';
const TTL_MS = 5000;
const REINTENTO_MS = 2000;
const ESPERA_MS = 1500;
const TOPE_CAMBIOS = 200;
const TOPE_ROLES_EN_MEMORIA = 2000;

const error = (status, mensaje) => Object.assign(new Error(mensaje), { status });
const clavePar = (rol, ruta) => `${rol}\u0000${ruta}`;
const rutasPorRoles = () => RUTAS.filter((r) => r.acceso === 'roles');
const esRolDelSistema = (nombre) => ROLES.includes(nombre);

let ultimoAviso = 0;
function avisarFallo(err) {
  if (Date.now() - ultimoAviso < 30000) return;
  ultimoAviso = Date.now();
  console.error('No se pudo leer la política de permisos de MySQL (rige la última copia o, sin ella, lo que declara el código):', err.message);
}

// ---------- La copia de las reglas ----------

const SIN_REGLAS = Object.freeze({ en: 0, reglas: new Map(), roles: [], degradada: true });
let copia = null;
let proximoIntento = 0;
let pendiente = null;

async function cargarDesdeLaBase() {
  const [filas, roles] = await Promise.all([
    prisma.acl_regla.findMany({ select: { rol_id: true, ruta: true, permitido: true, actualizado_por: true, actualizado_en: true } }),
    prisma.rol_usuario.findMany({ select: { id: true, tipo_rol: true }, orderBy: { id: 'asc' } }),
  ]);
  const nombreDe = new Map(roles.map((r) => [r.id, r.tipo_rol]));
  const reglas = new Map();
  for (const f of filas) {
    const nombre = nombreDe.get(f.rol_id);
    if (nombre) reglas.set(clavePar(nombre, f.ruta), { permitido: f.permitido, porId: f.actualizado_por, en: f.actualizado_en });
  }
  return { en: Date.now(), reglas, roles: roles.map((r) => ({ id: r.id, nombre: r.tipo_rol })), degradada: false };
}

// Para quien decide en cada petición: nunca lanza, nunca espera más de ESPERA_MS (un MySQL colgado no cuelga la API),
// y a lo sumo una lectura por TTL_MS.
async function leer() {
  const ahora = Date.now();
  if (copia && ahora - copia.en < TTL_MS) return copia;
  if (ahora < proximoIntento) return copia ?? SIN_REGLAS;
  if (!pendiente) {
    pendiente = conTiempo(cargarDesdeLaBase(), ESPERA_MS)
      .then((nueva) => {
        copia = nueva;
        return nueva;
      })
      .catch((err) => {
        proximoIntento = Date.now() + REINTENTO_MS;
        avisarFallo(err);
        return copia ?? SIN_REGLAS;
      })
      .finally(() => {
        pendiente = null;
      });
  }
  return pendiente;
}

// Para la pantalla: lo que hay AHORA en la base, o el error (mejor «no disponible» que mostrar una copia vieja).
async function leerFresca() {
  const nueva = await cargarDesdeLaBase();
  copia = nueva;
  return nueva;
}

function invalidar() {
  if (copia) copia.en = 0;
  proximoIntento = 0;
}

// ---------- El rol vigente de una cuenta ----------
//
// El token (2 h) dice qué rol tenía la cuenta cuando inició sesión. Para decidir se mira el rol de HOY (a lo sumo
// cada TTL_MS): un administrador al que se le quitó el rol pierde las rutas de roles en segundos, no al vencer el
// token. Si MySQL no responde se usa lo que dice el token.
const rolesDeCuentas = new Map();
let rolesCaidosHasta = 0;

function recordarRol(id, rol) {
  rolesDeCuentas.set(id, { rol, en: Date.now() });
  if (rolesDeCuentas.size > TOPE_ROLES_EN_MEMORIA) {
    for (const k of [...rolesDeCuentas.keys()].slice(0, TOPE_ROLES_EN_MEMORIA / 2)) rolesDeCuentas.delete(k);
  }
}

function conTiempo(promesa, ms) {
  let temporizador;
  const limite = new Promise((_, rechazar) => {
    temporizador = setTimeout(() => rechazar(new Error('tiempo de espera agotado')), ms);
  });
  return Promise.race([promesa, limite]).finally(() => clearTimeout(temporizador));
}

async function rolVigente(usuario) {
  const id = usuario?.id_usuario;
  if (!Number.isInteger(id)) return usuario?.rol ?? null;
  const guardado = rolesDeCuentas.get(id);
  if (guardado && Date.now() - guardado.en < TTL_MS) return guardado.rol;
  // MySQL no respondió hace un momento: no se insiste en cada petición; rige lo que dice el token.
  if (Date.now() < rolesCaidosHasta) return usuario.rol ?? null;
  try {
    const fila = await conTiempo(
      prisma.usuarios.findUnique({ where: { id_usuario: id }, select: { rol: { select: { tipo_rol: true } } } }),
      ESPERA_MS
    );
    const rol = fila?.rol?.tipo_rol ?? null; // null: la cuenta ya no existe
    recordarRol(id, rol);
    return rol;
  } catch (err) {
    rolesCaidosHasta = Date.now() + REINTENTO_MS;
    avisarFallo(err);
    return usuario.rol ?? null;
  }
}

function olvidarRol(id) {
  rolesDeCuentas.delete(id);
}

// ---------- La decisión ----------

// Función pura: la misma que usa el middleware, el simulador y la matriz, así que lo que la pantalla muestra es lo
// que la API aplica. `porDefecto`: los roles que declara el código para esa ruta.
function decidir(c, rol, claveRuta, porDefecto) {
  const ruta = rutaPorClave(claveRuta);
  const base = porDefecto ?? ruta?.roles ?? [];
  if (!rol) return { permitido: false, origen: 'sin-rol' };
  if (rol === ADMINISTRADOR) return { permitido: base.includes(ADMINISTRADOR), origen: 'administrador' };
  if (!ruta?.editable) return { permitido: base.includes(rol), origen: 'codigo' };
  const regla = c.reglas.get(clavePar(rol, claveRuta));
  if (regla) return { permitido: regla.permitido, origen: 'regla', regla };
  return { permitido: base.includes(rol), origen: 'codigo' };
}

// `usuario` es el del token ({ id_usuario, rol }). Devuelve la decisión y el rol con el que se tomó.
async function permite(usuario, claveRuta, porDefecto) {
  const rol = await rolVigente(usuario);
  const c = rutaPorClave(claveRuta)?.editable ? await leer() : SIN_REGLAS;
  return { ...decidir(c, rol, claveRuta, porDefecto), rol };
}

// Las rutas de roles que un rol puede usar, para que la interfaz sepa qué mostrar (GET /api/auth/me).
async function permisosDe(rol) {
  const c = await leer();
  return rutasPorRoles().filter((r) => decidir(c, rol, claveDe(r), r.roles).permitido).map(claveDe);
}

// ---------- La matriz (lo que muestra la pantalla) ----------

async function nombresDe(ids) {
  const unicos = [...new Set(ids.filter(Number.isInteger))];
  if (unicos.length === 0) return new Map();
  const filas = await prisma.usuarios.findMany({ where: { id_usuario: { in: unicos } }, select: { id_usuario: true, nombres: true, apellidos: true } });
  return new Map(filas.map((f) => [f.id_usuario, `${f.nombres} ${f.apellidos}`.trim()]));
}

async function matriz() {
  const c = await leerFresca();
  const [cuentas, autores] = await Promise.all([
    prisma.usuarios.groupBy({ by: ['rol_id'], _count: { _all: true } }),
    nombresDe([...c.reglas.values()].map((r) => r.porId)),
  ]);
  const porRol = new Map(cuentas.map((g) => [g.rol_id, g._count._all]));
  const roles = c.roles.map((r) => ({ id: r.id, nombre: r.nombre, sistema: esRolDelSistema(r.nombre), usuarios: porRol.get(r.id) ?? 0 }));
  const rutas = rutasPorRoles().map((r) => {
    const celdas = {};
    for (const rol of roles) {
      const d = decidir(c, rol.nombre, claveDe(r), r.roles);
      celdas[rol.nombre] = {
        permitido: d.permitido,
        origen: d.origen,
        porDefecto: r.roles.includes(rol.nombre),
        bloqueada: !r.editable || rol.nombre === ADMINISTRADOR,
        ...(d.regla && { modificadoPor: autores.get(d.regla.porId) ?? null, modificadoEn: d.regla.en }),
      };
    }
    return {
      clave: claveDe(r), metodo: r.metodo, ruta: r.ruta, grupo: r.grupo, nota: r.nota,
      editable: Boolean(r.editable), fija: r.fija ?? null, propios: Boolean(r.propios), porDefecto: r.roles, celdas,
    };
  });
  return { generadaEn: new Date().toISOString(), roles, rutas, reglas: c.reglas.size };
}

// ---------- Cambios ----------

const actorDe = (u) => ({ id: u.id_usuario, rol: u.rol });

function validarCambio(cambio, roles) {
  if (!cambio || typeof cambio.clave !== 'string' || typeof cambio.rol !== 'string' || typeof cambio.permitido !== 'boolean') {
    throw error(400, 'Cada cambio necesita clave, rol y permitido (verdadero o falso).');
  }
  const ruta = rutaPorClave(cambio.clave);
  if (!ruta || ruta.acceso !== 'roles') throw error(400, `«${cambio.clave}» no es una ruta por roles de la lista blanca.`);
  if (!ruta.editable) throw error(400, `«${cambio.clave}» no se puede cambiar desde la pantalla: ${ruta.fija}`);
  if (cambio.rol === ADMINISTRADOR) throw error(400, 'El administrador conserva todas las rutas: no se le puede quitar ninguna.');
  const rol = roles.find((r) => r.nombre === cambio.rol);
  if (!rol) throw error(404, `El rol «${cambio.rol}» no existe.`);
  return { ruta, rol };
}

// Todo o nada: un lote con un cambio inválido no aplica ninguno. Un cambio que deja la celda igual a lo que
// declara el código borra la regla (no se guardan filas que no cambian nada).
async function aplicarCambios(actor, cambios) {
  if (!Array.isArray(cambios) || cambios.length === 0) throw error(400, 'No hay cambios que aplicar.');
  if (cambios.length > TOPE_CAMBIOS) throw error(400, `Son demasiados cambios de una vez (máximo ${TOPE_CAMBIOS}).`);
  const c = await leerFresca();
  const vistos = new Set();
  const efectivos = [];
  for (const cambio of cambios) {
    const { ruta, rol } = validarCambio(cambio, c.roles);
    const par = clavePar(cambio.rol, cambio.clave);
    if (vistos.has(par)) throw error(400, `El cambio de «${cambio.rol}» en «${cambio.clave}» viene repetido.`);
    vistos.add(par);
    const actual = decidir(c, cambio.rol, cambio.clave, ruta.roles);
    if (actual.permitido === cambio.permitido) continue;
    efectivos.push({ ...cambio, rolId: rol.id, ruta, antes: actual.permitido, vuelveAlCodigo: ruta.roles.includes(cambio.rol) === cambio.permitido });
  }
  if (efectivos.length > 0) {
    await prisma.$transaction(async (tx) => {
      for (const e of efectivos) {
        if (e.vuelveAlCodigo) {
          await tx.acl_regla.deleteMany({ where: { rol_id: e.rolId, ruta: e.clave } });
        } else {
          const datos = { permitido: e.permitido, actualizado_por: actor.id_usuario, actualizado_en: new Date() };
          await tx.acl_regla.upsert({
            where: { rol_id_ruta: { rol_id: e.rolId, ruta: e.clave } },
            update: datos,
            create: { rol_id: e.rolId, ruta: e.clave, ...datos },
          });
        }
      }
    });
    invalidar();
  }
  const auditado = await auditoria.registrarVarios(
    efectivos.map((e) => ({
      tipo: 'regla',
      actor: actorDe(actor),
      objetivo: { tipo: 'ruta', id: e.clave, nombre: e.ruta.nota },
      antes: { rol: e.rol, permitido: e.antes },
      despues: { rol: e.rol, permitido: e.permitido },
    }))
  );
  return {
    aplicados: efectivos.map((e) => ({ clave: e.clave, rol: e.rol, antes: e.antes, despues: e.permitido })),
    sinCambios: cambios.length - efectivos.length,
    auditado,
  };
}

// Vuelve a lo que declara el código: una ruta, un rol, o todo (sin filtros).
async function restaurar(actor, { clave: claveRuta, rol } = {}) {
  const c = await leerFresca();
  if (claveRuta !== undefined) {
    const ruta = rutaPorClave(claveRuta);
    if (!ruta || ruta.acceso !== 'roles') throw error(400, `«${claveRuta}» no es una ruta por roles de la lista blanca.`);
  }
  let rolId;
  if (rol !== undefined) {
    const encontrado = c.roles.find((r) => r.nombre === rol);
    if (!encontrado) throw error(404, `El rol «${rol}» no existe.`);
    rolId = encontrado.id;
  }
  const nombreDe = new Map(c.roles.map((r) => [r.id, r.nombre]));
  const borradas = await prisma.$transaction(async (tx) => {
    const donde = { ...(rolId !== undefined && { rol_id: rolId }), ...(claveRuta !== undefined && { ruta: claveRuta }) };
    const antes = await tx.acl_regla.findMany({ where: donde, select: { rol_id: true, ruta: true, permitido: true } });
    if (antes.length > 0) await tx.acl_regla.deleteMany({ where: donde });
    return antes;
  });
  if (borradas.length > 0) invalidar();
  const alcance = claveRuta !== undefined ? `la ruta ${claveRuta}` : rol !== undefined ? `el rol ${rol}` : 'toda la política';
  const auditado = borradas.length === 0 || (await auditoria.registrar({
    tipo: 'restaurar',
    actor: actorDe(actor),
    objetivo: { tipo: claveRuta !== undefined ? 'ruta' : rol !== undefined ? 'rol' : 'politica', id: claveRuta ?? rol ?? 'todo' },
    antes: borradas.map((b) => ({ rol: nombreDe.get(b.rol_id), clave: b.ruta, permitido: b.permitido })),
    detalle: `Se volvió a lo que declara el código en ${alcance}`,
  }));
  return { restauradas: borradas.length, auditado };
}

// ---------- El simulador ----------

const fecha = (d) => new Date(d).toLocaleString('es-GT', { timeZone: 'America/Guatemala', dateStyle: 'long', timeStyle: 'short' });
const lista = (roles) => roles.map((r) => `«${r}»`).join(', ');

function explicar(ruta, rol, d, autores) {
  if (ruta.acceso === 'publica') return 'Ruta pública: no pide sesión, la usa cualquiera.';
  if (ruta.acceso === 'opcional') return 'Ruta pública: la usa cualquiera; con sesión la respuesta puede cambiar.';
  if (ruta.acceso === 'sesion') return 'Pide sesión y nada más: la usa cualquier cuenta con sesión, sea cual sea su rol (una cuenta suspendida se rechaza aparte).';
  if (d.origen === 'sin-rol') return 'La cuenta ya no existe o no tiene rol: sin rol no hay nada permitido.';
  if (d.origen === 'administrador') return 'El administrador conserva todas las rutas: ninguna regla lo toca, así nadie puede quedarse sin acceso.';
  const declarado = ruta.roles.includes(rol) ? `el código sí permite a «${rol}» esta ruta` : `el código no incluye a «${rol}» en esta ruta (lista blanca: ${lista(ruta.roles)})`;
  if (d.origen === 'regla') {
    const quien = d.regla.porId && autores.get(d.regla.porId) ? ` (${autores.get(d.regla.porId)})` : '';
    return `Un administrador lo ${d.regla.permitido ? 'permitió' : 'negó'} el ${fecha(d.regla.en)}${quien}; ${declarado}.`;
  }
  if (!ruta.editable) return `Ruta fija: ${ruta.fija} Por el código, ${declarado}.`;
  return d.permitido ? `Lo permite el código: ${declarado}. Nadie lo cambió.` : `Se niega: ${declarado}. Lo que no figura en la lista blanca se niega por defecto.`;
}

async function simular({ rol, usuarioId, clave: claveRuta }) {
  const ruta = rutaPorClave(claveRuta);
  if (!ruta) throw error(404, `«${claveRuta}» no está en la lista blanca de la API.`);
  const c = await leerFresca();
  let nombreRol = rol;
  let cuenta = null;
  if (usuarioId !== undefined) {
    const id = Number(usuarioId);
    if (!Number.isInteger(id) || id <= 0) throw error(400, 'El id de cuenta no es válido.');
    const fila = await prisma.usuarios.findUnique({ where: { id_usuario: id }, select: { id_usuario: true, nombres: true, apellidos: true, correo: true, rol: { select: { tipo_rol: true } } } });
    if (!fila) throw error(404, 'Esa cuenta no existe.');
    cuenta = { id: fila.id_usuario, nombre: `${fila.nombres} ${fila.apellidos}`.trim(), correo: fila.correo };
    nombreRol = fila.rol.tipo_rol;
  }
  if (!nombreRol) throw error(400, 'Indicá un rol o una cuenta.');
  if (!c.roles.some((r) => r.nombre === nombreRol)) throw error(404, `El rol «${nombreRol}» no existe.`);

  const d = ruta.acceso === 'roles' ? decidir(c, nombreRol, claveRuta, ruta.roles) : { permitido: true, origen: ruta.acceso };
  const autores = d.regla ? await nombresDe([d.regla.porId]) : new Map();
  const detalles = [];
  if (ruta.propios) detalles.push('Además, el servicio comprueba que el recurso sea de quien pregunta (o que sea administrador): permitir la ruta no abre lo ajeno.');
  if (ruta.acceso === 'roles' && ruta.editable) detalles.push('Se puede cambiar desde la matriz.');
  return {
    permitido: d.permitido,
    origen: d.origen,
    rol: nombreRol,
    cuenta,
    motivo: explicar(ruta, nombreRol, d, autores),
    detalles,
    ruta: { clave: claveRuta, metodo: ruta.metodo, ruta: ruta.ruta, acceso: ruta.acceso, grupo: ruta.grupo ?? null, nota: ruta.nota, editable: Boolean(ruta.editable), fija: ruta.fija ?? null, propios: Boolean(ruta.propios) },
    regla: d.regla ? { permitido: d.regla.permitido, modificadoEn: d.regla.en, modificadoPor: autores.get(d.regla.porId) ?? null } : null,
  };
}

module.exports = {
  ADMINISTRADOR,
  TTL_MS,
  decidir,
  permite,
  permisosDe,
  rolVigente,
  olvidarRol,
  invalidar,
  matriz,
  aplicarCambios,
  restaurar,
  simular,
  esRolDelSistema,
};
