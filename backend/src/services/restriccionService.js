const { crearCandado } = require('./candadoRedis');
const { ROLES_EXENTOS } = require('./suspensionService');

// Límites suaves para una cuenta con un hallazgo de fraude de confianza «posible»
// (respuesta escalonada, IA/PLAN-NEO4J-DETECCION-FRAUDE.md §21): no se la suspende
// — un «posible» puede ser un falso positivo con demasiada facilidad —, pero mientras
// dura, la cuenta puede comprar solo con estos límites:
//   - cada pedido, de hasta RESTRICCION_MONTO_MAXIMO (500 por defecto);
//   - menos pedidos por hora que el tope general (RESTRICCION_PEDIDOS_HORA, 2);
//   - su contraseña en cada pedido (reautenticacionService.js).
// El candado es el mismo mecanismo que la suspensión (candadoRedis.js): una clave
// `restriccion:{id}` cuyo TTL (FRAUDE_RESTRICCION_HORAS, 24 h) es lo que falta para
// que se levante sola. Los casos que lo respaldan viven en la misma tabla
// (`bloqueo_cuenta`, tipo 'restriccion'). Lo hace cumplir middleware/controlPedidos.js
// en las rutas de compra; los servicios solo reciben el tope de monto como parámetro.
//
// Fallar abierto, como la suspensión: sin Redis, nadie queda restringido.

const candado = crearCandado('restriccion');

const HORAS_POR_DEFECTO = 24;
const MAXIMO_HORAS = 720;
const MONTO_POR_DEFECTO = 500;
const PEDIDOS_POR_HORA_POR_DEFECTO = 2;

function entero(valor, defecto, nombre, { minimo = 0, maximo = 1000000 } = {}) {
  if (valor === undefined || valor === '') return defecto;
  const n = Number(valor);
  if (!Number.isFinite(n) || n < minimo || n > maximo) throw new Error(`${nombre} debe ser un número entre ${minimo} y ${maximo}`);
  return n;
}

// RESTRICCION_ENABLED (true) apaga TODOS los límites suaves de este proceso aunque
// existan candados; FRAUDE_RESTRICCION_HORAS (24, admite decimales),
// RESTRICCION_MONTO_MAXIMO (500; 0 = sin tope de monto) y RESTRICCION_PEDIDOS_HORA
// (2; 0 = sin tope propio de pedidos). Un valor mal escrito se rechaza en vez de caer
// en el defecto sin avisar.
function configuracion(env = process.env) {
  const horas = Number(env.FRAUDE_RESTRICCION_HORAS || HORAS_POR_DEFECTO);
  if (!Number.isFinite(horas) || horas <= 0 || horas > MAXIMO_HORAS) {
    throw new Error(`FRAUDE_RESTRICCION_HORAS debe ser un número mayor que 0 y de a lo sumo ${MAXIMO_HORAS}`);
  }
  return {
    habilitado: !['false', '0'].includes(String(env.RESTRICCION_ENABLED || 'true').toLowerCase()),
    horas,
    duracionMs: Math.round(horas * 3600000),
    montoMaximo: entero(env.RESTRICCION_MONTO_MAXIMO, MONTO_POR_DEFECTO, 'RESTRICCION_MONTO_MAXIMO'),
    pedidosPorHora: entero(env.RESTRICCION_PEDIDOS_HORA, PEDIDOS_POR_HORA_POR_DEFECTO, 'RESTRICCION_PEDIDOS_HORA', { maximo: 1000 }),
  };
}

let ultimoAviso = 0;
function avisarFallo(err) {
  if (Date.now() - ultimoAviso < 30000) return;
  ultimoAviso = Date.now();
  console.error('No se pudo consultar las restricciones de cuentas (se deja pasar):', err.message);
}

// Los límites que rigen para esta cuenta AHORA, o null si no tiene restricción (o
// si están apagados, o es un administrador — un automatismo no toca a quienes
// pueden deshacerlo). `montoMaximo`/`pedidosPorHora` son null cuando ese tope está
// desactivado. Una configuración inválida o un Redis caído se tratan como "sin
// restricción" y se avisa: no deben impedir comprar a todo el mundo.
async function limitesDe(usuarioId, rol) {
  if (ROLES_EXENTOS.has(rol)) return null;
  try {
    const cfg = configuracion();
    if (!cfg.habilitado) return null;
    const estado = await candado.estado(usuarioId);
    if (!estado.activo) return null;
    return { montoMaximo: cfg.montoMaximo || null, pedidosPorHora: cfg.pedidosPorHora || null, hasta: estado.hasta };
  } catch (err) {
    avisarFallo(err);
    return null;
  }
}

// { id: 'ISO de cuándo se levanta' } de las cuentas con límites suaves ahora — lo
// usa el panel de fraude para marcar sus fichas.
async function mapaRestringidas() {
  const ids = await candado.usuarios();
  const ms = await candado.restantes(ids);
  return Object.fromEntries([...ms].map(([id, restante]) => [id, restante === null ? null : new Date(Date.now() + restante).toISOString()]));
}

module.exports = { candado, configuracion, limitesDe, mapaRestringidas };
