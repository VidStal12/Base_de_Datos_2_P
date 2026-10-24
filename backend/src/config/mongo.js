const mongoose = require('mongoose');
const { ServicioNoDisponible, CredencialRechazada, esErrorDeAcceso, crearCircuito, avisarCaida, avisarCredencial, avisarRecuperacion } = require('../utils/resiliencia');
const { definicion, variableContrasena } = require('./mongoCuentas');

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

// Las credenciales del servidor web (la cuenta `mg_app`, ver mongoCuentas.js) salen del entorno: backend/.env, que
// escribe `npm run seguridad:inicializar`. Sin contraseña definida se conecta sin credenciales (un Mongo sin
// autenticación), como antes de la Entrega Final.
function credencialesDe(cuenta = 'app', env = process.env) {
  const contrasena = env[variableContrasena(cuenta)];
  const d = definicion(cuenta);
  return contrasena ? { auth: { username: d.usuario, password: contrasena }, authSource: d.db } : null;
}

// Si Mongo rechaza las credenciales, reintentar en cada petición sería un nuevo intento de login fallido por
// petición: se recuerda el rechazo y, durante este tiempo, las llamadas fallan al instante con CredencialRechazada.
// Pasado el tiempo se prueba UNA vez más, para que corregir el .env no exija reiniciar el backend.
const REINTENTO_CREDENCIAL_MS = 30000;
let rechazado = null;

// Conexión perezosa y reutilizada — se abre una sola vez, la primera vez que
// algún servicio la necesita, en vez de al arrancar el proceso. `cuenta` solo cuenta en esa primera vez: el servidor
// web usa siempre la de la aplicación; un script de mantenimiento que necesita borrar (el rol de la aplicación no
// puede) pide 'admin' ANTES de tocar nada y todo el proceso corre con ella.
function conectar(cuenta = 'app') {
  if (rechazado && Date.now() - rechazado.en < REINTENTO_CREDENCIAL_MS) return Promise.reject(rechazado.error);
  rechazado = null;
  if (!conexion) {
    const credenciales = credencialesDe(cuenta);
    conexion = circuitoInicial.ejecutar(() => mongoose.connect(process.env.MONGO_URI, { ...OPCIONES, ...credenciales })).catch((err) => {
      conexion = undefined;
      if (esErrorDeAcceso(err)) {
        const usuario = credenciales?.auth.username ?? null;
        rechazado = { error: new CredencialRechazada('mongo', usuario, err), en: Date.now() };
        avisarCredencial('mongo', err, usuario);
        throw rechazado.error;
      }
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

module.exports = { conectar, credencialesDe };
