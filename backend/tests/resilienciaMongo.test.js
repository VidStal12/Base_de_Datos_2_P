const test = require('node:test');
const assert = require('node:assert/strict');
const { cargar } = require('./redisHelpers');
const { ServicioNoDisponible } = require('../src/utils/resiliencia');

// config/mongo.js con un mongoose de mentira. Medido con el contenedor detenido, el driver
// tardaba 30 s en rendirse (selección de servidor) y, peor, si el PRIMER intento de conexión
// fallaba (el backend arrancó con Mongo apagado) el error quedaba guardado: aunque Mongo
// volviera, `conectar()` seguía devolviendo la promesa rechazada hasta reiniciar el backend.
function mongooseFalso({ fallar = 0 } = {}) {
  const estado = { intentos: 0, opciones: null, uris: [], eventos: {} };
  return {
    estado,
    connection: {
      readyState: 0,
      on(evento, manejador) { estado.eventos[evento] = manejador; },
    },
    async connect(uri, opciones) {
      estado.intentos += 1;
      estado.uris.push(uri);
      estado.opciones = opciones;
      if (estado.intentos <= fallar) {
        const err = new Error('connect ECONNREFUSED 127.0.0.1:27018');
        err.name = 'MongooseServerSelectionError';
        throw err;
      }
      this.connection.readyState = 1;
      return this;
    },
  };
}

function cargarConfig(mongoose) {
  return cargar('../src/config/mongo.js', { mongoose }, { MONGO_URI: 'mongodb://prueba/tiendaya' });
}

test('se conecta con tiempos cortos: Mongo apagado se detecta en ~2 s, no en 30', async () => {
  const mongoose = mongooseFalso();
  await cargarConfig(mongoose).conectar();
  const { opciones, uris } = mongoose.estado;
  assert.deepEqual(uris, ['mongodb://prueba/tiendaya']);
  assert.ok(opciones.serverSelectionTimeoutMS <= 3000);
  assert.ok(opciones.connectTimeoutMS <= 3000);
  assert.ok(opciones.heartbeatFrequencyMS <= 3000, 'la caída se nota rápido, sin esperar al siguiente latido');
  assert.ok(opciones.bufferTimeoutMS <= 3000, 'una operación sin conexión no espera 10 s en la cola');
});

test('un primer intento fallido NO se guarda: el siguiente conectar() vuelve a probar', async () => {
  const mongoose = mongooseFalso({ fallar: 1 });
  const config = cargarConfig(mongoose);
  await assert.rejects(config.conectar(), (err) => err instanceof ServicioNoDisponible && err.componente === 'mongo');
  assert.equal(mongoose.estado.intentos, 1);
  // Dentro de la ventana del cortacircuitos no se golpea otra vez al servidor…
  await assert.rejects(config.conectar(), (err) => err instanceof ServicioNoDisponible);
  assert.equal(mongoose.estado.intentos, 1, 'mientras siga apagado no se paga un timeout por petición');
});

test('conectado y luego caído: falla al instante; cuando el driver reconecta, vuelve a funcionar solo', async () => {
  const mongoose = mongooseFalso();
  const config = cargarConfig(mongoose);
  await config.conectar();
  assert.equal(mongoose.estado.intentos, 1);

  mongoose.connection.readyState = 0; // el contenedor se detuvo y el driver lo notó
  await assert.rejects(config.conectar(), (err) => err instanceof ServicioNoDisponible && err.componente === 'mongo');
  mongoose.connection.readyState = 3;
  await assert.rejects(config.conectar(), (err) => err instanceof ServicioNoDisponible, 'desconectando también cuenta como caído');
  assert.equal(mongoose.estado.intentos, 1, 'no se abre otra conexión: el driver reconecta solo');

  mongoose.connection.readyState = 1; // reconectó
  assert.ok(await config.conectar());
});

test('una conexión que se cierra a propósito (los scripts al terminar) no se anuncia como caída', () => {
  const mongoose = mongooseFalso();
  cargarConfig(mongoose);
  assert.equal(mongoose.estado.eventos.disconnected, undefined, 'solo se avisa cuando una operación sufre la caída');
  assert.equal(typeof mongoose.estado.eventos.reconnected, 'function', 'pero sí se anota cuando vuelve');
});

// ───────────────────────── Credenciales (Entrega Final, IA/PLAN-ENTREGA-FINAL.md §4.2 y §4.3) ─────────────────────────
const { CredencialRechazada } = require('../src/utils/resiliencia');

const rechazoDeMongo = (nombre, codeName, mensaje) => Object.assign(new Error(mensaje), { name: 'MongoServerError', codeName });

function mongooseQueRechaza() {
  const mongoose = mongooseFalso();
  mongoose.estado.rechazos = 0;
  mongoose.connect = async function connect(uri, opciones) {
    mongoose.estado.intentos += 1;
    mongoose.estado.opciones = opciones;
    mongoose.estado.rechazos += 1;
    throw rechazoDeMongo('MongoServerError', 'AuthenticationFailed', 'Authentication failed.');
  };
  return mongoose;
}

const cargarConEntorno = (mongoose, entorno) => cargar('../src/config/mongo.js', { mongoose }, { MONGO_URI: 'mongodb://prueba/tiendaya', ...entorno });

test('con la contraseña de mg_app en el entorno conecta con esas credenciales, contra la base `tiendaya`', async () => {
  const mongoose = mongooseFalso();
  await cargarConEntorno(mongoose, { MONGO_CONTRASENA_APP: 'p'.repeat(40) }).conectar();
  const { opciones, uris } = mongoose.estado;
  assert.deepEqual(uris, ['mongodb://prueba/tiendaya'], 'la URI no lleva la contraseña: viaja aparte');
  assert.deepEqual({ ...opciones.auth }, { username: 'mg_app', password: 'p'.repeat(40) });
  assert.equal(opciones.authSource, 'tiendaya');
  assert.ok(opciones.serverSelectionTimeoutMS <= 3000, 'y conserva los tiempos acotados');
});

test('sin contraseña en el entorno conecta sin credenciales (un Mongo sin autenticación), como antes', async () => {
  const mongoose = mongooseFalso();
  await cargarConEntorno(mongoose, {}).conectar();
  assert.equal(mongoose.estado.opciones.auth, undefined);
  assert.equal(mongoose.estado.opciones.authSource, undefined);
});

test('el servidor web nunca entra con la cuenta de administración', async () => {
  const mongoose = mongooseFalso();
  await cargarConEntorno(mongoose, { MONGO_CONTRASENA_ADMIN: 'a'.repeat(40) }).conectar();
  assert.equal(mongoose.estado.opciones.auth, undefined, 'solo MONGO_CONTRASENA_APP cuenta para el servidor');
});

test('un rechazo de credenciales NO es una caída: CredencialRechazada, y no se vuelve a intentar en cada petición', async (t) => {
  t.mock.method(console, 'error', () => {});
  const mongoose = mongooseQueRechaza();
  const config = cargarConEntorno(mongoose, { MONGO_CONTRASENA_APP: 'p'.repeat(40) });
  await assert.rejects(config.conectar(), (err) => err instanceof CredencialRechazada && err.componente === 'mongo' && err.cuenta === 'mg_app' && err.status === 500);
  assert.equal(mongoose.estado.intentos, 1);
  for (let i = 0; i < 5; i++) await assert.rejects(config.conectar(), CredencialRechazada);
  assert.equal(mongoose.estado.intentos, 1, 'cinco peticiones más: ningún login fallido adicional');
});

test('un rechazo de credenciales no se confunde con una caída: no abre el cortacircuitos ni lo anuncia como «no responde»', async (t) => {
  const avisos = t.mock.method(console, 'error', () => {});
  const mongoose = mongooseQueRechaza();
  const config = cargarConEntorno(mongoose, { MONGO_CONTRASENA_APP: 'p'.repeat(40) });
  await assert.rejects(config.conectar(), CredencialRechazada);
  assert.ok(avisos.mock.calls.every((c) => !/no responde/.test(String(c.arguments[0]))), 'el aviso habla de credenciales, no de una caída');
});

test('pasado el tiempo de espera se prueba UNA vez más, para que corregir el .env no exija reiniciar', async (t) => {
  t.mock.method(console, 'error', () => {});
  const reloj = { ahora: Date.now() };
  class DateConReloj extends Date {
    static now() {
      return reloj.ahora;
    }
  }
  const mongoose = mongooseQueRechaza();
  const config = cargar('../src/config/mongo.js', { mongoose }, { MONGO_URI: 'mongodb://prueba/tiendaya', MONGO_CONTRASENA_APP: 'p'.repeat(40) }, { Date: DateConReloj });
  await assert.rejects(config.conectar(), CredencialRechazada);
  reloj.ahora += 29000;
  await assert.rejects(config.conectar(), CredencialRechazada);
  assert.equal(mongoose.estado.intentos, 1, 'a los 29 s todavía no');
  reloj.ahora += 2000;
  await assert.rejects(config.conectar(), CredencialRechazada);
  assert.equal(mongoose.estado.intentos, 2, 'a los 31 s hace un intento nuevo');
});

test('un fallo de red al conectar NO bloquea: sigue siendo una caída que se reintenta', async () => {
  const mongoose = mongooseFalso({ fallar: 1 });
  const config = cargarConEntorno(mongoose, { MONGO_CONTRASENA_APP: 'p'.repeat(40) });
  await assert.rejects(config.conectar(), (err) => err instanceof ServicioNoDisponible);
  assert.ok(!(await config.conectar().catch((e) => e) instanceof CredencialRechazada));
});

test('credencialesDe: solo la cuenta pedida, con su usuario y su base de autenticación', () => {
  const { credencialesDe } = cargarConEntorno(mongooseFalso(), {});
  assert.equal(credencialesDe('app', {}), null);
  assert.deepEqual({ ...credencialesDe('app', { MONGO_CONTRASENA_APP: 'x'.repeat(20) }).auth }, { username: 'mg_app', password: 'x'.repeat(20) });
  assert.equal(credencialesDe('admin', { MONGO_CONTRASENA_ADMIN: 'y'.repeat(20) }).authSource, 'admin');
  assert.throws(() => credencialesDe('root', {}), /Cuenta de Mongo desconocida/);
});

test('un script de mantenimiento puede pedir la cuenta de administración (la primera conexión manda)', async () => {
  const mongoose = mongooseFalso();
  const config = cargarConEntorno(mongoose, { MONGO_CONTRASENA_ADMIN: 'a'.repeat(40), MONGO_CONTRASENA_APP: 'p'.repeat(40) });
  await config.conectar('admin');
  assert.deepEqual({ ...mongoose.estado.opciones.auth }, { username: 'mg_admin', password: 'a'.repeat(40) });
  assert.equal(mongoose.estado.opciones.authSource, 'admin');
  await config.conectar(); // ya conectado: el resto del proceso sigue con esa conexión
  assert.equal(mongoose.estado.intentos, 1);
});
