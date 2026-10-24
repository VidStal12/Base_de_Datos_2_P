const { conectar } = require('../config/redis');

// Tope de pedidos por hora de una cuenta — PREVENCIÓN, no detección: la ráfaga de
// gasto (señal E del grafo) se ve DESPUÉS, cuando los pedidos ya se hicieron; este
// contador en Redis rechaza el siguiente ANTES de que se complete. Un contador por
// cuenta (`limite:pedidos:{id}`) con INCR + EXPIRE en una sola ejecución atómica (script
// Lua `reservarCupo`, config/redis.js): con N pedidos simultáneos, exactamente `límite`
// pasan, sin la ventana entre "contar" y "decidir" que tendría un INCR suelto.
//
// La ventana es FIJA (se abre con el primer pedido y cierra una hora después), no
// deslizante: es lo que da INCR + EXPIRE, y se explica en una frase. El costo conocido
// de las ventanas fijas es una ráfaga justo en el borde (los últimos pedidos de una y
// los primeros de la siguiente); para frenar un ataque de prueba de tarjetas alcanza.
//
// Lo hace cumplir middleware/controlPedidos.js en las rutas de compra — los servicios
// de checkout no lo conocen, así que los scripts que los llaman directo no lo sienten.
// Falla abierto: sin Redis no se frena a nadie.

const VENTANA_SEGUNDOS = 3600;
const POR_HORA_POR_DEFECTO = 5;
const clave = (usuarioId) => `limite:pedidos:${usuarioId}`;

// LIMITE_PEDIDOS_HORA: cuántos pedidos por hora puede hacer una cuenta (5 por
// defecto; 0 = sin tope). Un valor mal escrito se rechaza en vez de caer en el defecto
// sin avisar.
function configuracion(env = process.env) {
  const crudo = env.LIMITE_PEDIDOS_HORA;
  const porHora = crudo === undefined || crudo === '' ? POR_HORA_POR_DEFECTO : Number(crudo);
  if (!Number.isInteger(porHora) || porHora < 0 || porHora > 1000) {
    throw new Error('LIMITE_PEDIDOS_HORA debe ser un entero entre 0 (sin tope) y 1000');
  }
  return { porHora, ventanaSegundos: VENTANA_SEGUNDOS };
}

// Reserva un pedido de la ventana de esta cuenta. `admitido: false` = ya llegó al
// límite; `reintentarEnSegundos` es lo que falta para que la ventana cierre.
async function reservar(usuarioId, limite, ventanaSegundos = VENTANA_SEGUNDOS) {
  const [cuenta, segundos] = await conectar('cupos').reservarCupo(clave(usuarioId), limite, ventanaSegundos);
  return { admitido: Number(cuenta) !== -1, cuenta: Number(cuenta), reintentarEnSegundos: Number(segundos) };
}

// Devuelve el pedido reservado cuando no llegó a completarse (el servicio lo rechazó
// después: stock, precio, dirección…): un pedido que falla no gasta el cupo.
async function liberar(usuarioId) {
  await conectar('cupos').liberarCupo(clave(usuarioId));
}

module.exports = { configuracion, reservar, liberar, clave, VENTANA_SEGUNDOS };
