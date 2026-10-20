const mongoose = require('mongoose');
const { ServicioNoDisponible, crearCircuito, avisarCaida, avisarRecuperacion } = require('../utils/resiliencia');

let conexion;

// Con los tiempos por defecto del driver (selección de servidor: 30 s) un Mongo apagado
// dejaba cada petición del catálogo colgada medio minuto antes de fallar. Acá se
// detecta la caída en ~2 s (ver utils/resiliencia.js; medido con el contenedor detenido).
const OPCIONES = {
  serverSelectionTimeoutMS: 2000,
  connectTimeoutMS: 2000,
  heartbeatFrequencyMS: 2000,
  bufferTimeoutMS: 2000,
  socketTimeoutMS: 20000,
};

// El PRIMER intento de conexión también puede fallar (el backend arrancó con Mongo
// apagado). Ese fallo no se guarda: el siguiente `conectar()` vuelve a probar, pero con
// un cortacircuitos para que no cueste 2 s por petición mientras siga apagado.
const circuitoInicial = crearCircuito('mongo', { aperturaMs: 3000 });

// Solo se avisa la caída cuando una operación la sufre (abajo), no en el evento
// 'disconnected': los scripts cierran la conexión a propósito al terminar y eso no es una caída.
mongoose.connection.on('reconnected', () => avisarRecuperacion('mongo'));

// Conexión perezosa y reutilizada — se abre una sola vez, la primera vez que
// algún servicio la necesita, en vez de al arrancar el proceso.
function conectar() {
  if (!conexion) {
    conexion = circuitoInicial.ejecutar(() => mongoose.connect(process.env.MONGO_URI, OPCIONES)).catch((err) => {
      conexion = undefined;
      throw err;
    });
    return conexion;
  }
  // Ya se conectó alguna vez: mientras el driver la haya perdido (Mongo apagado), fallar
  // AL INSTANTE en vez de que cada operación espere su propio timeout. El driver sigue
  // reconectando solo: cuando Mongo vuelve, el estado pasa a 1 sin intervención.
  const estado = mongoose.connection.readyState;
  if (estado === 0 || estado === 3) {
    avisarCaida('mongo', new Error('se perdió la conexión con MongoDB'));
    return Promise.reject(new ServicioNoDisponible('mongo'));
  }
  return conexion;
}

module.exports = { conectar };
