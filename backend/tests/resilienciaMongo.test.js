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
