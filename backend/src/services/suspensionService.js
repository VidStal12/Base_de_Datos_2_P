const { crearCandado } = require('./candadoRedis');
const { esErrorDeAcceso } = require('../utils/resiliencia');

// Suspensión temporal de cuentas — la parte RÁPIDA (Redis), la que se consulta en
// cada petición autenticada. La parte durable (por qué, quién lo revisó, qué se
// decidió) es bloqueoService.js sobre la tabla `bloqueo_cuenta`; este módulo solo
// sabe de claves y de tiempo, y por eso no importa Prisma, Mongo ni Neo4j: el
// middleware de autenticación lo carga en cada petición.
//
//   bloqueo:{id_usuario}   la clave EXISTE mientras la cuenta está suspendida; su
//                          TTL es lo que falta para que se levante sola. Redis es
//                          quien hace vencer el bloqueo — nadie tiene que acordarse
//                          de desbloquear (ver candadoRedis.js).
//
// Fallar abierto: si Redis no responde, la cuenta se trata como NO suspendida. Una
// caída de Redis no debe dejar a todo el sitio sin poder iniciar sesión; el costo
// es que durante la caída una cuenta suspendida podría actuar, y en cuanto Redis
// vuelve, bloqueoService.reconciliar() reconstruye los bloqueos desde MySQL.
//
// Fallar abierto es para una Redis CAÍDA, no para una Redis que RECHAZA a la cuenta de servicio (credencial
// vencida, un permiso que falta en su ACL): eso es un error de configuración, y dejar pasar a todo el
// mundo «sin que nadie lo note» apagaría las suspensiones en silencio. En ese caso la consulta FALLA
// (500 CREDENCIAL_RECHAZADA) y el error queda en el log con la cuenta (IA/PLAN-ENTREGA-FINAL.md §4.3).

const CODIGO_CUENTA_SUSPENDIDA = 'CUENTA_SUSPENDIDA';
// Un automatismo no puede dejar sin acceso a las únicas personas que pueden
// deshacerlo: las cuentas de administrador nunca se suspenden (sus hallazgos se
// siguen viendo en el panel de fraude, para que otro administrador los revise).
const ROLES_EXENTOS = new Set(['administrador']);

const candado = crearCandado('bloqueo');
const clave = candado.clave;

function textoFecha(fecha) {
  return fecha.toLocaleString('es-GT', { timeZone: 'America/Guatemala', dateStyle: 'long', timeStyle: 'short' });
}

// Lo que ve la persona suspendida. No dice QUÉ señal la disparó: explicar el
// criterio le enseñaría a esquivarlo.
function mensajeSuspension(hasta) {
  const cuando = hasta ? ` hasta el ${textoFecha(hasta)}` : '';
  return `Tu cuenta está suspendida temporalmente${cuando} mientras una persona del equipo revisa actividad inusual. Si fue un error, la suspensión se levanta una vez revisado el caso.`;
}

// Las cuentas suspendidas se leen en cada consulta del catálogo (vendedoresSuspendidos,
// más abajo): el memo evita un SCAN por petición. Se invalida al escribir o levantar un
// bloqueo desde este proceso; un bloqueo que vence por TTL tarda a lo sumo MEMO_MS en
// dejar de ocultarse — el costo de no tener un evento de "venció".
const MEMO_MS = 3000;
let memo = null;
function invalidarMemo() {
  memo = null;
}

async function estadoBloqueo(usuarioId) {
  const estado = await candado.estado(usuarioId);
  if (!estado.activo) return { bloqueada: false };
  return { bloqueada: true, restanteMs: estado.restanteMs, hasta: estado.hasta };
}

let ultimoAviso = 0;
// Un Redis caído haría una línea de log por petición: se avisa a lo sumo cada 30 s.
function avisarFallo(err) {
  if (Date.now() - ultimoAviso < 30000) return;
  ultimoAviso = Date.now();
  console.error('No se pudo consultar el bloqueo de cuentas en Redis (se deja pasar):', err.message);
}

async function estaBloqueada(usuarioId) {
  try {
    return await estadoBloqueo(usuarioId);
  } catch (err) {
    if (esErrorDeAcceso(err)) throw err;
    avisarFallo(err);
    return { bloqueada: false };
  }
}

// Lanza el error que el middleware y el login convierten en 403. `rol` sale del
// token o de la cuenta; un administrador no se consulta siquiera.
async function exigirCuentaActiva(usuarioId, rol) {
  if (ROLES_EXENTOS.has(rol)) return;
  const estado = await estaBloqueada(usuarioId);
  if (!estado.bloqueada) return;
  const err = new Error(mensajeSuspension(estado.hasta));
  err.status = 403;
  err.codigo = CODIGO_CUENTA_SUSPENDIDA;
  err.hasta = estado.hasta ? estado.hasta.toISOString() : null;
  throw err;
}

// Escribe el bloqueo SOLO si dura más que el que ya corre (script Lua atómico, ver
// config/redis.js): ni un segundo hallazgo ni la reconstrucción desde MySQL pueden
// acortar una suspensión vigente. Devuelve true si escribió.
async function bloquear(usuarioId, duracionMs) {
  const escribio = await candado.bloquear(usuarioId, duracionMs);
  invalidarMemo();
  return escribio;
}

// true si había un bloqueo que quitar.
async function levantar(usuarioId) {
  const habia = await candado.levantar(usuarioId);
  invalidarMemo();
  return habia;
}

const usuariosBloqueados = () => candado.usuarios();
const restantes = (usuarioIds) => candado.restantes(usuarioIds);

// Los ids de las cuentas suspendidas ahora, como Set. Un vendedor suspendido deja
// de mostrarse y de poder comprarse: el catálogo, el buscador, las recomendaciones, el
// carrito y los pedidos le preguntan a esto — la visibilidad se DERIVA del candado, no
// se guarda en los productos. Por eso se levanta sola en el mismo instante en que
// vence el TTL o un administrador libera la cuenta, sin escribir nada en Mongo,
// Elasticsearch ni Redis por cada producto, y sin poder quedarse "oculto" por un
// fallo a medias. Falla abierto: sin Redis no se oculta a nadie.
async function vendedoresSuspendidos() {
  if (memo && Date.now() - memo.en < MEMO_MS) return memo.ids;
  try {
    const ids = new Set(await usuariosBloqueados());
    memo = { en: Date.now(), ids };
    return ids;
  } catch (err) {
    avisarFallo(err);
    return new Set();
  }
}

// { id: 'ISO de cuando se levanta' } de todas las cuentas suspendidas ahora — lo
// usa el panel de fraude para marcar las fichas de cuentas ya suspendidas.
async function mapaBloqueadas() {
  const ids = await usuariosBloqueados();
  const ms = await restantes(ids);
  return Object.fromEntries([...ms].map(([id, restante]) => [id, restante === null ? null : new Date(Date.now() + restante).toISOString()]));
}

module.exports = {
  CODIGO_CUENTA_SUSPENDIDA,
  ROLES_EXENTOS,
  candado,
  clave,
  textoFecha,
  mensajeSuspension,
  estadoBloqueo,
  estaBloqueada,
  exigirCuentaActiva,
  bloquear,
  levantar,
  usuariosBloqueados,
  restantes,
  vendedoresSuspendidos,
  mapaBloqueadas,
};
