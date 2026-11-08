const prisma = require('../config/prisma');
const suspension = require('./suspensionService');
const restriccion = require('./restriccionService');
const exencionesFlash = require('./fraudeExencionesFlashService');
const { consultarFraude, enriquecerUsuarios } = require('./fraudeService');
const { registrarFallo } = require('../utils/resiliencia');

// Respuesta escalonada a las señales de fraude (ver IA/PLAN-NEO4J-DETECCION-FRAUDE.md
// §20 y §21): lo que se hace con una cuenta depende de CUÁNTO confía el detector.
//
//   confianza «alta»    SUSPENSIÓN temporal: la cuenta no puede entrar (candado
//                       `bloqueo:{id}`), y sus productos dejan de mostrarse mientras
//                       dure (suspensionService.vendedoresSuspendidos).
//   confianza «posible» RESTRICCIÓN suave: la cuenta sigue comprando con límites
//                       (restriccionService.js: tope por pedido, menos pedidos por hora
//                       y contraseña en cada pedido) en vez de nada.
//
// Dos almacenes, cada uno con su trabajo, para los dos niveles:
//   Redis  el candado (`bloqueo:{id}` / `restriccion:{id}`). Su TTL es lo que falta
//          para que se levante SOLO: el vencimiento lo hace Redis, no un proceso que
//          tenga que acordarse.
//   MySQL  `bloqueo_cuenta` (este módulo) — el REGISTRO durable de cada caso: qué
//          hallazgo, cuándo, quién lo revisó y qué decidió. Redis es volátil; si se
//          pierde, reconciliar() lo reconstruye desde acá.
//
// Cómo se llega a un caso: evaluar() corre las siete señales de fraude
// (fraudeService.consultarFraude — la MISMA fuente de verdad que el panel), toma las
// cuentas de los hallazgos de nivel «alta» y «posible» y abre un caso por cada (cuenta,
// hallazgo, tipo). Un administrador revisa cada caso en /admin/bloqueos: levanta la
// suspensión (o la restricción) si era un falso positivo, o extiende la suspensión.
//
// Un hallazgo suspende o restringe a una cuenta UNA vez (único (id_usuario, huella,
// tipo)): el grafo no olvida, así que sin eso el barrido volvería a actuar cada minuto
// sobre quien ya cumplió su plazo o a quien un administrador ya liberó. Y como los
// niveles solo suben: un «posible» ya revisado no vuelve a restringir (hay un caso, de
// cualquier tipo, para ese hallazgo), pero un «alta» sí suspende aunque ya haya una
// restricción — es evidencia nueva.

const HORA_MS = 3600000;
const HORAS_POR_DEFECTO = 24;
const MAXIMO_HORAS = 720; // 30 días
const NOTA_MAXIMA = 500;
const LIMITE_HISTORIAL = 50;
// Cuánto puede quedarse corto el TTL de Redis frente a lo que dice MySQL antes de
// corregirlo: entre medir uno y otro pasan unos milisegundos.
const TOLERANCIA_MS = 5000;
const TIPOS = ['suspension', 'restriccion'];

const SENALES = {
  cuentas_relacionadas: 'Cuentas de una misma persona',
  autocompra: 'Autocompra',
  reventa: 'Reventa de lo comprado',
  rafaga_gasto: 'Ráfaga de gasto',
  gasto_anomalo: 'Gasto anómalo',
  categoria_inusual: 'Categoría inusual',
};

// Cada tipo de caso tiene su candado en Redis, con las mismas cuatro operaciones. La
// suspensión pasa por suspensionService (que además invalida el memo con el que se
// ocultan los productos de un vendedor suspendido).
const CANDADOS = {
  suspension: {
    bloquear: (id, ms) => suspension.bloquear(id, ms),
    levantar: (id) => suspension.levantar(id),
    restantes: (ids) => suspension.restantes(ids),
    usuarios: () => suspension.usuariosBloqueados(),
  },
  restriccion: {
    bloquear: (id, ms) => restriccion.candado.bloquear(id, ms),
    levantar: (id) => restriccion.candado.levantar(id),
    restantes: (ids) => restriccion.candado.restantes(ids),
    usuarios: () => restriccion.candado.usuarios(),
  },
};

function errorHttp(status, mensaje) {
  const err = new Error(mensaje);
  err.status = status;
  return err;
}

// FRAUDE_BLOQUEO_ENABLED (true), FRAUDE_BLOQUEO_HORAS (24, admite decimales: 0.5 son
// 30 minutos) y FRAUDE_BLOQUEO_INTERVALO_MS (60000). Un valor mal escrito se
// rechaza en vez de caer en el defecto sin avisar. (Los de la restricción suave,
// en restriccionService.configuracion.)
function configuracion(env = process.env) {
  const horas = Number(env.FRAUDE_BLOQUEO_HORAS || HORAS_POR_DEFECTO);
  if (!Number.isFinite(horas) || horas <= 0 || horas > MAXIMO_HORAS) {
    throw new Error(`FRAUDE_BLOQUEO_HORAS debe ser un número mayor que 0 y de a lo sumo ${MAXIMO_HORAS}`);
  }
  const intervaloMs = Number(env.FRAUDE_BLOQUEO_INTERVALO_MS || 60000);
  if (!Number.isInteger(intervaloMs) || intervaloMs < 1000 || intervaloMs > 2147483647) {
    throw new Error('FRAUDE_BLOQUEO_INTERVALO_MS debe ser un entero entre 1000 y 2147483647');
  }
  return {
    habilitado: !['false', '0'].includes(String(env.FRAUDE_BLOQUEO_ENABLED || 'true').toLowerCase()),
    horas,
    duracionMs: Math.round(horas * HORA_MS),
    intervaloMs,
  };
}

// Las operaciones que escriben (barrido, reconciliación, liberar, extender) corren
// de una en una dentro de este proceso: una liberación no puede cruzarse con una
// reconstrucción que "arreglaría" lo que acaba de pasar.
let cola = Promise.resolve();
function enSerie(tarea) {
  const resultado = cola.then(tarea);
  cola = resultado.catch(() => {});
  return resultado;
}

// ---------- De hallazgos a cuentas ----------

const tieneNivel = (hallazgo) => hallazgo?.nivelConfianza === 'alta' || hallazgo?.nivelConfianza === 'posible';
const involucrada = (id, nombre, ficha, papel) => ({ id, nombre, rol: ficha?.rol ?? null, papel });

// Qué cuentas son responsables de cada hallazgo, la HUELLA que lo identifica (señal
// + cuentas + lo que lo hace único) y su NIVEL de confianza (de él sale el tipo de
// caso: «alta» suspende, «posible» restringe):
//   - cuentas de una misma persona: todas las del grupo (son la misma persona).
//   - autocompra: comprador y vendedor si son cuentas distintas; la cuenta, si es una sola.
//   - reventa: solo quien revende — el vendedor original es la víctima.
//   - ráfaga, gasto anómalo y categoría inusual: la cuenta que hizo el gasto.
// Las reseñas coordinadas no traen nivel de confianza (no están clasificadas), así que
// no suspenden ni restringen a nadie. Es una función pura: la prueba aislada la
// recorre con hallazgos armados a mano.
function candidatosDeHallazgos(datos) {
  const candidatos = [];
  const agregar = ({ cuentas, senal, huella, hallazgo, involucradas, datosClave }) => {
    const evidencia = {
      nivel: hallazgo.nivelConfianza,
      corroboradores: (hallazgo.corroboradores ?? []).map(({ tipo, detalle }) => ({ tipo, detalle })),
      involucradas,
      datos: datosClave,
    };
    for (const usuarioId of new Set(cuentas)) {
      candidatos.push({ usuarioId, senal, huella, nivel: hallazgo.nivelConfianza, motivo: hallazgo.motivo, evidencia });
    }
  };

  for (const h of datos.cuentasRelacionadas ?? []) {
    if (!tieneNivel(h)) continue;
    agregar({
      cuentas: h.miembros.map((m) => m.id),
      senal: 'cuentas_relacionadas',
      huella: `cuentas_relacionadas:${h.clave}`,
      hallazgo: h,
      involucradas: h.miembros.map((m) => involucrada(m.id, m.nombre, m.ficha, 'misma persona')),
      datosClave: { vinculos: h.vinculos.map((v) => ({ tipo: v.tipo, cuentas: v.ids })), totalOrdenes: h.totalOrdenes, totalGastado: h.totalGastado },
    });
  }

  for (const f of datos.autocompra ?? []) {
    if (!tieneNivel(f)) continue;
    agregar({
      cuentas: f.mismaCuenta ? [f.comprador.id] : [f.comprador.id, f.vendedor.id],
      senal: 'autocompra',
      huella: `autocompra:${f.comprador.id}>${f.vendedor.id}`,
      hallazgo: f,
      involucradas: f.mismaCuenta
        ? [involucrada(f.comprador.id, f.comprador.nombre, f.comprador.ficha, 'compra y vende')]
        : [involucrada(f.comprador.id, f.comprador.nombre, f.comprador.ficha, 'comprador'), involucrada(f.vendedor.id, f.vendedor.nombre, f.vendedor.ficha, 'vendedor')],
      datosClave: { mismaCuenta: f.mismaCuenta, mismoDispositivo: f.mismoDispositivo, mismoPerfil: f.mismoPerfil, mismoBuzon: f.mismoBuzon, pedidos: f.pedidos, total: f.total },
    });
  }

  for (const r of datos.reventa ?? []) {
    if (!tieneNivel(r)) continue;
    agregar({
      cuentas: [r.vendedor.id],
      senal: 'reventa',
      huella: `reventa:${r.vendedor.id}:${r.publicacion.id}`,
      hallazgo: r,
      involucradas: [
        involucrada(r.vendedor.id, r.vendedor.nombre, r.vendedor.ficha, 'revende'),
        ...r.originales.map((o) => involucrada(o.vendedor.id, o.vendedor.nombre, o.vendedor.ficha, 'vendedor original')),
      ],
      datosClave: {
        publicacion: { id: r.publicacion.id, nombre: r.publicacion.nombre },
        originales: r.originales.map((o) => ({ producto: { id: o.producto.id, nombre: o.producto.nombre }, vendedor: { id: o.vendedor.id, nombre: o.vendedor.nombre } })),
        listadaDespues: r.listadaDespues,
        mismosAtributos: r.mismosAtributos,
      },
    });
  }

  for (const r of datos.rafagaGasto ?? []) {
    if (!tieneNivel(r)) continue;
    agregar({
      cuentas: [r.usuario.id],
      senal: 'rafaga_gasto',
      huella: `rafaga_gasto:${r.usuario.id}:${r.dia}`,
      hallazgo: r,
      involucradas: [involucrada(r.usuario.id, r.usuario.nombre, r.usuario.ficha, 'cuenta')],
      datosClave: { dia: r.dia, pedidos: r.pedidos, gastado: r.gastado },
    });
  }

  for (const g of datos.gastoAnomalo ?? []) {
    if (!tieneNivel(g)) continue;
    agregar({
      cuentas: [g.usuario.id],
      senal: 'gasto_anomalo',
      huella: `gasto_anomalo:${g.usuario.id}:${g.compraId}`,
      hallazgo: g,
      involucradas: [involucrada(g.usuario.id, g.usuario.nombre, g.usuario.ficha, 'cuenta')],
      datosClave: { compraId: g.compraId, total: g.total, promedio: g.promedio, vecesPromedio: g.vecesPromedio },
    });
  }

  for (const c of datos.categoriaInusual ?? []) {
    if (!tieneNivel(c)) continue;
    agregar({
      cuentas: [c.usuario.id],
      senal: 'categoria_inusual',
      huella: `categoria_inusual:${c.usuario.id}:${c.compraId}`,
      hallazgo: c,
      involucradas: [involucrada(c.usuario.id, c.usuario.nombre, c.usuario.ficha, 'cuenta')],
      datosClave: { compraId: c.compraId, categoria: c.categoria, ordenesPrevias: c.ordenesPrevias },
    });
  }

  return candidatos;
}

// ---------- Abrir casos ----------

// Escribe el candado en Redis; si Redis falla el caso ya quedó en MySQL y el
// próximo barrido lo reconstruye (reconciliar), así que no se propaga el error.
async function aplicarCandado(tipo, usuarioId, expiraEn) {
  try {
    await CANDADOS[tipo].bloquear(usuarioId, Math.max(1, expiraEn.getTime() - Date.now()));
    return true;
  } catch (err) {
    console.error(`No se pudo escribir en Redis el candado (${tipo}) de la cuenta #${usuarioId} (se reconstruye en el próximo barrido):`, err.message);
    return false;
  }
}

async function abrirCasoSinCola({ usuarioId, huella, senal, motivo, evidencia = null, origen = 'automatico', tipo = 'suspension', duracionMs, ahora = new Date() }) {
  const expiraEn = new Date(ahora.getTime() + duracionMs);
  let caso;
  try {
    caso = await prisma.bloqueo_cuenta.create({
      data: { id_usuario: usuarioId, huella, senal, tipo, origen, motivo, evidencia, expira_en: expiraEn },
    });
  } catch (err) {
    // P2002 = (id_usuario, huella, tipo) ya existe: otro barrido abrió este mismo caso.
    if (err.code === 'P2002') return { creado: false };
    throw err;
  }
  await aplicarCandado(tipo, usuarioId, expiraEn);
  return { creado: true, caso };
}

function abrirCaso(datos) {
  return enSerie(() => abrirCasoSinCola(datos));
}

// ---------- Reconciliar Redis con MySQL ----------

// MySQL es la verdad; Redis, la copia que se consulta en cada petición. Tres
// correcciones, todas idempotentes, para cada uno de los dos candados:
//   1. los casos activos cuya hora ya pasó se marcan 'expirado' (Redis ya los
//      soltó solo, por TTL);
//   2. un caso activo sin candado en Redis (Redis se reinició, o falló la
//      escritura) lo recupera, con lo que falta de su vencimiento;
//   3. un candado en Redis sin ningún caso activo (se liberó pero Redis falló, o lo
//      escribió alguien a mano) se quita.
async function reconciliarAhora(ahora = new Date()) {
  try {
    await exencionesFlash.liberarExistentes({ prisma, suspension, restriccion }, process.env);
  } catch (err) {
    // Una limpieza de pruebas fallida no debe detener el antifraude de las demás cuentas.
    registrarFallo('No se pudo liberar la excepción local de oferta flash', err);
  }
  const { count: vencidos } = await prisma.bloqueo_cuenta.updateMany({
    where: { estado: 'activo', expira_en: { lte: ahora } },
    data: { estado: 'expirado' },
  });
  const activos = await prisma.bloqueo_cuenta.findMany({ where: { estado: 'activo' }, select: { id_usuario: true, expira_en: true, tipo: true } });

  let reconstruidos = 0;
  let huerfanos = 0;
  for (const tipo of TIPOS) {
    const hastaPorUsuario = new Map();
    for (const c of activos) {
      if (c.tipo === tipo) hastaPorUsuario.set(c.id_usuario, Math.max(hastaPorUsuario.get(c.id_usuario) ?? 0, c.expira_en.getTime()));
    }
    const candado = CANDADOS[tipo];
    try {
      const enRedis = await candado.restantes([...hastaPorUsuario.keys()]);
      for (const [id, hasta] of hastaPorUsuario) {
        const falta = Math.max(1, hasta - Date.now());
        const actual = enRedis.get(id); // undefined: no existe; null: sin vencimiento; número: ms
        if (actual === undefined || (actual !== null && actual + TOLERANCIA_MS < falta)) {
          if (await candado.bloquear(id, falta)) reconstruidos += 1;
        }
      }
      for (const id of await candado.usuarios()) {
        if (!hastaPorUsuario.has(id) && (await candado.levantar(id))) huerfanos += 1;
      }
    } catch (err) {
      console.error(`No se pudo reconciliar el candado (${tipo}) con Redis:`, err.message);
    }
  }
  return { vencidos, reconstruidos, huerfanos };
}

function reconciliar(opciones) {
  return enSerie(() => reconciliarAhora(opciones?.ahora));
}

// ---------- El barrido ----------

async function evaluarAhora({ duracionMs, ahora = new Date() } = {}) {
  await reconciliarAhora(ahora);

  const advertenciasLocales = [];
  const duracionSuspension = duracionMs ?? configuracion().duracionMs;
  // Una restricción mal configurada o apagada no debe impedir las suspensiones:
  // simplemente no se abren casos de restricción en este barrido.
  let duracionRestriccion = null;
  try {
    const cfg = restriccion.configuracion();
    if (cfg.habilitado) duracionRestriccion = cfg.duracionMs;
  } catch (err) {
    advertenciasLocales.push(`Los límites suaves no se aplicaron: ${err.message}`);
  }

  const datos = await consultarFraude();
  const candidatos = candidatosDeHallazgos(datos);
  const resumen = {
    candidatas: candidatos.length,
    casosNuevos: 0,
    restriccionesNuevas: 0,
    cuentas: [],
    restringidas: [],
    omitidosAdministrador: 0,
    omitidosPruebaFlash: 0,
    yaConocidos: 0,
    advertencias: [...(datos.advertencias ?? []), ...advertenciasLocales],
  };
  if (candidatos.length === 0) return resumen;

  const ids = [...new Set(candidatos.map((c) => c.usuarioId))];
  const [usuarios, existentes] = await Promise.all([
    prisma.usuarios.findMany({
      where: { id_usuario: { in: ids } },
      select: { id_usuario: true, nombres: true, apellidos: true, correo: true, rol: { select: { tipo_rol: true } } },
    }),
    prisma.bloqueo_cuenta.findMany({ where: { id_usuario: { in: ids } }, select: { id_usuario: true, huella: true, tipo: true } }),
  ]);
  const usuarioPorId = new Map(usuarios.map((u) => [u.id_usuario, u]));
  const conocidos = new Set(existentes.map((e) => `${e.id_usuario}|${e.huella}|${e.tipo}`));
  const conCaso = new Set(existentes.map((e) => `${e.id_usuario}|${e.huella}`)); // de cualquier tipo

  const resultados = { suspension: new Map(), restriccion: new Map() };
  for (const c of candidatos) {
    const tipo = c.nivel === 'alta' ? 'suspension' : 'restriccion';
    if (tipo === 'restriccion' && duracionRestriccion === null) continue;
    const usuario = usuarioPorId.get(c.usuarioId);
    if (!usuario) continue; // la cuenta ya no existe
    if (suspension.ROLES_EXENTOS.has(usuario.rol.tipo_rol)) {
      resumen.omitidosAdministrador += 1;
      continue;
    }
    if (exencionesFlash.esCorreoExento(usuario.correo, process.env)) {
      resumen.omitidosPruebaFlash += 1;
      continue;
    }
    // «alta»: basta con que ya haya una SUSPENSIÓN para ese hallazgo. «posible»: no se
    // restringe si ya hay un caso de cualquier tipo — ya se revisó, o ya es «alta».
    const clave = `${c.usuarioId}|${c.huella}`;
    if (tipo === 'suspension' ? conocidos.has(`${clave}|suspension`) : conCaso.has(clave)) {
      resumen.yaConocidos += 1;
      continue;
    }
    const { creado } = await abrirCasoSinCola({ ...c, tipo, duracionMs: tipo === 'suspension' ? duracionSuspension : duracionRestriccion, ahora });
    if (!creado) {
      resumen.yaConocidos += 1;
      continue;
    }
    if (tipo === 'suspension') resumen.casosNuevos += 1;
    else resumen.restriccionesNuevas += 1;
    const porCuenta = resultados[tipo];
    if (!porCuenta.has(c.usuarioId)) porCuenta.set(c.usuarioId, { usuarioId: c.usuarioId, nombre: `${usuario.nombres} ${usuario.apellidos}`, senales: [] });
    porCuenta.get(c.usuarioId).senales.push(c.senal);
  }
  resumen.cuentas = [...resultados.suspension.values()];
  resumen.restringidas = [...resultados.restriccion.values()];
  const detalle = (lista) => lista.map((c) => `#${c.usuarioId} (${c.senales.join(', ')})`).join('; ');
  if (resumen.cuentas.length > 0) console.log(`Bloqueo automático: ${resumen.cuentas.length} cuenta(s) suspendida(s) — ${detalle(resumen.cuentas)}`);
  if (resumen.restringidas.length > 0) console.log(`Bloqueo automático: ${resumen.restringidas.length} cuenta(s) con límites suaves — ${detalle(resumen.restringidas)}`);
  return resumen;
}

// Un barrido a la vez: si el temporizador y el botón "Revisar ahora" coinciden,
// el segundo recibe el resultado del que ya corre en vez de repetir las siete
// consultas.
let evaluacion = null;
function evaluar(opciones) {
  if (!evaluacion) {
    evaluacion = enSerie(() => evaluarAhora(opciones)).finally(() => {
      evaluacion = null;
    });
  }
  return evaluacion;
}

// ---------- Decisiones de un administrador ----------

function normalizarNota(nota) {
  if (nota === undefined || nota === null) return '';
  if (typeof nota !== 'string') throw errorHttp(400, 'La nota debe ser texto');
  const texto = nota.trim();
  if (texto.length > NOTA_MAXIMA) throw errorHttp(400, `La nota admite hasta ${NOTA_MAXIMA} caracteres`);
  return texto;
}

// Cierra TODOS los casos activos de ese tipo de una cuenta (el candado es de la
// cuenta, no de cada hallazgo) con quién y por qué, y borra el candado. Las huellas
// quedan, así que ese mismo hallazgo no vuelve a actuar sobre la cuenta. Primero
// MySQL (la decisión durable), después Redis; si Redis falla, reconciliar() quita el
// candado que quedó de más, y un reintento lo quita y responde bien.
async function cerrarCasos(tipo, usuarioId, revisorId, nota) {
  const texto = normalizarNota(nota);
  return enSerie(async () => {
    const { count } = await prisma.bloqueo_cuenta.updateMany({
      where: { id_usuario: usuarioId, estado: 'activo', tipo },
      data: { estado: 'liberado', revisado_por: revisorId, revisado_en: new Date(), nota_revision: texto || null },
    });
    const habiaCandado = await CANDADOS[tipo].levantar(usuarioId);
    if (count === 0 && !habiaCandado) {
      throw errorHttp(404, tipo === 'suspension' ? 'Esa cuenta no tiene un bloqueo activo (puede que ya haya vencido).' : 'Esa cuenta no tiene una restricción activa (puede que ya haya vencido).');
    }
    console.log(`${tipo === 'suspension' ? 'Bloqueo levantado' : 'Restricción levantada'} por la cuenta #${revisorId}: cuenta #${usuarioId} (${count} caso(s) cerrados).`);
    return { casosCerrados: count, ...(tipo === 'suspension' ? { bloqueoLevantado: habiaCandado } : { restriccionLevantada: habiaCandado }) };
  });
}

// "Dar el visto bueno": levanta la suspensión ahora — la cuenta entra de inmediato y
// sus productos vuelven a mostrarse.
function liberar(usuarioId, revisorId, nota) {
  return cerrarCasos('suspension', usuarioId, revisorId, nota);
}

// Quita los límites suaves de una cuenta antes de que venzan solos.
function quitarRestriccion(usuarioId, revisorId, nota) {
  return cerrarCasos('restriccion', usuarioId, revisorId, nota);
}

// "Esto sí parecía fraude": suma tiempo a la suspensión. Cada caso activo se
// extiende desde su propio vencimiento (o desde ahora, si ya había pasado sin que
// el reconciliador lo marcara) y el bloqueo de Redis pasa a durar lo que dura el
// más largo. Solo las suspensiones: una restricción suave vence sola o se quita.
async function extender(usuarioId, revisorId, horas, nota) {
  const texto = normalizarNota(nota);
  if (!Number.isFinite(horas) || horas <= 0 || horas > MAXIMO_HORAS) {
    throw errorHttp(400, `Las horas a extender deben ser un número mayor que 0 y de a lo sumo ${MAXIMO_HORAS}`);
  }
  return enSerie(async () => {
    const ahora = new Date();
    const casos = await prisma.bloqueo_cuenta.findMany({ where: { id_usuario: usuarioId, estado: 'activo', tipo: 'suspension' } });
    if (casos.length === 0) throw errorHttp(404, 'Esa cuenta no tiene un bloqueo activo (puede que ya haya vencido).');
    let maximo = 0;
    const cambios = casos.map((caso) => {
      const nueva = new Date(Math.max(caso.expira_en.getTime(), ahora.getTime()) + Math.round(horas * HORA_MS));
      maximo = Math.max(maximo, nueva.getTime());
      return prisma.bloqueo_cuenta.update({
        where: { id: caso.id },
        data: { expira_en: nueva, revisado_por: revisorId, revisado_en: ahora, ...(texto && { nota_revision: texto }) },
      });
    });
    await prisma.$transaction(cambios);
    await aplicarCandado('suspension', usuarioId, new Date(maximo));
    console.log(`Bloqueo extendido ${horas} h por la cuenta #${revisorId}: cuenta #${usuarioId}.`);
    return { casosExtendidos: casos.length, hasta: new Date(maximo).toISOString() };
  });
}

// ---------- Lo que ve el administrador ----------

const nombreDe = (persona) => (persona ? `${persona.nombres} ${persona.apellidos}` : null);

function formatearCaso(caso) {
  return {
    id: caso.id,
    tipo: caso.tipo,
    senal: caso.senal,
    senalNombre: SENALES[caso.senal] ?? caso.senal,
    origen: caso.origen,
    motivo: caso.motivo,
    evidencia: caso.evidencia,
    creadoEn: caso.creado_en.toISOString(),
    expiraEn: caso.expira_en.toISOString(),
  };
}

// Agrupa los casos activos de UN tipo por cuenta: una tarjeta por cuenta con todos
// sus hallazgos, lo pendiente de revisión primero y, dentro de cada grupo, lo más
// reciente.
function agruparPorCuenta(casos, fichas, enRedis) {
  const porUsuario = new Map();
  for (const caso of casos) {
    if (!porUsuario.has(caso.id_usuario)) porUsuario.set(caso.id_usuario, []);
    porUsuario.get(caso.id_usuario).push(caso);
  }
  const lista = [...porUsuario].map(([id, delUsuario]) => {
    const expiraEn = Math.max(...delUsuario.map((c) => c.expira_en.getTime()));
    // El tiempo que cuenta es el de Redis (es el que de verdad lo levanta); sin él,
    // lo que dice MySQL.
    const restanteMs = enRedis.has(id) && enRedis.get(id) !== null ? enRedis.get(id) : Math.max(0, expiraEn - Date.now());
    const revisados = delUsuario.filter((c) => c.revisado_en).sort((a, b) => b.revisado_en - a.revisado_en);
    const ultimo = revisados[0] ?? null;
    return {
      usuario: { id, nombre: fichas.get(id)?.nombre ?? `Cuenta #${id}`, ficha: fichas.get(id) ?? null },
      creadoEn: new Date(Math.min(...delUsuario.map((c) => c.creado_en.getTime()))).toISOString(),
      expiraEn: new Date(expiraEn).toISOString(),
      restanteSegundos: Math.max(0, Math.round(restanteMs / 1000)),
      // null = nadie lo revisó todavía; si no, la última decisión (extender).
      revisado: ultimo ? { en: ultimo.revisado_en.toISOString(), por: nombreDe(ultimo.revisor), nota: ultimo.nota_revision } : null,
      casos: delUsuario.sort((a, b) => b.creado_en - a.creado_en).map(formatearCaso),
    };
  });
  lista.sort((a, b) => (a.revisado ? 1 : 0) - (b.revisado ? 1 : 0) || new Date(b.creadoEn) - new Date(a.creadoEn));
  return lista;
}

async function listarAhora() {
  const cfg = configuracion();
  let cfgRestriccion;
  const advertencias = [];
  try {
    cfgRestriccion = restriccion.configuracion();
  } catch (err) {
    advertencias.push(err.message);
    cfgRestriccion = { habilitado: false, horas: null, montoMaximo: null, pedidosPorHora: null };
  }

  const [activos, historial] = await Promise.all([
    prisma.bloqueo_cuenta.findMany({
      where: { estado: 'activo' },
      orderBy: { creado_en: 'desc' },
      include: { revisor: { select: { nombres: true, apellidos: true } } },
    }),
    prisma.bloqueo_cuenta.findMany({
      where: { estado: { in: ['liberado', 'expirado'] } },
      orderBy: { creado_en: 'desc' },
      take: LIMITE_HISTORIAL,
      include: { usuario: { select: { nombres: true, apellidos: true, correo: true } }, revisor: { select: { nombres: true, apellidos: true } } },
    }),
  ]);

  const suspendidas = activos.filter((c) => c.tipo === 'suspension');
  const restringidas = activos.filter((c) => c.tipo === 'restriccion');
  const idsSuspendidas = [...new Set(suspendidas.map((c) => c.id_usuario))];
  const idsRestringidas = [...new Set(restringidas.map((c) => c.id_usuario))];
  const [{ fichas }, tiempoSuspension, tiempoRestriccion] = await Promise.all([
    enriquecerUsuarios([...new Set([...idsSuspendidas, ...idsRestringidas])]).catch((err) => {
      advertencias.push(`No se pudieron cargar las fichas de usuario: ${err.message}`);
      return { fichas: new Map() };
    }),
    suspension.restantes(idsSuspendidas).catch((err) => {
      advertencias.push(`No se pudo leer el tiempo restante en Redis: ${err.message}`);
      return new Map();
    }),
    restriccion.candado.restantes(idsRestringidas).catch(() => new Map()),
  ]);

  const activas = agruparPorCuenta(suspendidas, fichas, tiempoSuspension);
  const conLimites = agruparPorCuenta(restringidas, fichas, tiempoRestriccion);

  return {
    configuracion: {
      habilitado: cfg.habilitado,
      horas: cfg.horas,
      intervaloSegundos: Math.round(cfg.intervaloMs / 1000),
      restriccion: { habilitado: cfgRestriccion.habilitado, horas: cfgRestriccion.horas, montoMaximo: cfgRestriccion.montoMaximo, pedidosPorHora: cfgRestriccion.pedidosPorHora },
    },
    resumen: { activas: activas.length, pendientesDeRevision: activas.filter((a) => !a.revisado).length, restringidas: conLimites.length },
    activas,
    restringidas: conLimites,
    historial: historial.map((caso) => ({
      ...formatearCaso(caso),
      estado: caso.estado,
      usuario: { id: caso.id_usuario, nombre: nombreDe(caso.usuario), correo: caso.usuario?.correo ?? null },
      revisado: caso.revisado_en ? { en: caso.revisado_en.toISOString(), por: nombreDe(caso.revisor), nota: caso.nota_revision } : null,
    })),
    advertencias,
  };
}

async function listar() {
  await reconciliar();
  return listarAhora();
}

// ---------- El temporizador ----------

let temporizador;
let arranque;

// Lo arranca server.js (no app.js: importar Express en una prueba no debe lanzar
// temporizadores), igual que el worker de ventas. Un error de configuración lo
// lanza `configuracion()` y server.js lo informa sin detener el servidor.
function iniciar() {
  const cfg = configuracion();
  if (temporizador || !cfg.habilitado) return;
  const exentasFlash = exencionesFlash.correosExentos();
  if (exentasFlash.length > 0) console.log(`Exención local de fraude flash activa: ${exentasFlash.length} cuentas de prueba.`);
  const barrer = () => evaluar().catch((err) => registrarFallo('No se pudo evaluar el bloqueo de cuentas', err));
  // La primera pasada espera unos segundos a que el servidor esté arriba, y de
  // paso reconstruye en Redis lo que se haya perdido en un reinicio.
  arranque = setTimeout(barrer, 3000);
  arranque.unref();
  temporizador = setInterval(barrer, cfg.intervaloMs);
  temporizador.unref();
}

async function detener() {
  clearTimeout(arranque);
  if (temporizador) clearInterval(temporizador);
  temporizador = undefined;
  await evaluacion?.catch(() => {});
}

module.exports = {
  configuracion,
  candidatosDeHallazgos,
  evaluar,
  reconciliar,
  abrirCaso,
  liberar,
  quitarRestriccion,
  extender,
  listar,
  iniciar,
  detener,
  SENALES,
  MAXIMO_HORAS,
  NOTA_MAXIMA,
};
