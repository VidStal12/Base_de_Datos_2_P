const test = require('node:test');
const assert = require('node:assert/strict');
const { cargar } = require('./redisHelpers');
const { ServicioNoDisponible } = require('../src/utils/resiliencia');

// config/redis.js con un ioredis de mentira: lo que se prueba es la POLÍTICA (tiempos
// acotados y rechazo inmediato mientras la conexión está caída), no el protocolo. Con los
// valores por defecto de ioredis un Redis apagado dejaba cada comando esperando ~73 s y
// hasta el catálogo público tardaba ~108 s (medido con el contenedor detenido); contra el
// Redis real lo cubre la medición en vivo de IA/ENTREGA-3-CONSISTENCIA.md §7.
const instancias = [];

class RedisFalso {
  constructor(url, opciones) {
    this.url = url;
    this.opciones = opciones;
    this.status = 'connecting';
    this.eventos = {};
    this.definidos = [];
    this.enviados = [];
    instancias.push(this);
  }
  on(evento, manejador) { this.eventos[evento] = manejador; return this; }
  defineCommand(nombre) { this.definidos.push(nombre); }
  sendCommand(comando) { this.enviados.push(comando.name); return comando.promise; }
  disconnect() { this.desconectado = true; }
}

function comandoFalso(nombre) {
  let rechazar;
  const promise = new Promise((_, rej) => { rechazar = rej; });
  promise.catch(() => {}); // lo atiende quien lo espera; aquí solo se mira el rechazo
  return { name: nombre, promise, reject: rechazar };
}

function cliente() {
  const config = cargar('../src/config/redis.js', { ioredis: RedisFalso }, { REDIS_URL: 'redis://prueba:6379' });
  const redis = config.conectar();
  return { config, redis };
}

test('el cliente se crea con tiempos acotados: ningún comando espera más de unos segundos', () => {
  const { redis } = cliente();
  assert.equal(redis.url, 'redis://prueba:6379');
  assert.ok(redis.opciones.commandTimeout <= 2000, 'un comando sin respuesta se descarta en <= 2 s');
  assert.ok(redis.opciones.maxRetriesPerRequest <= 2, 'la cola de espera se vacía tras pocos reintentos (el valor por defecto era 20)');
  assert.ok(redis.opciones.connectTimeout <= 3000);
  assert.equal(redis.opciones.retryStrategy(1) <= 500, true, 'los primeros reintentos son rápidos');
  assert.equal(redis.opciones.retryStrategy(1000), 2000, 'y la espera nunca pasa de 2 s');
});

test('es el mismo cliente en cada llamada, con los scripts Lua registrados una sola vez', () => {
  const { config, redis } = cliente();
  assert.equal(config.conectar(), redis);
  const cantidad = redis.definidos.length;
  assert.ok(cantidad >= 10, 'carrito, ofertas, bloqueos y topes de pedidos');
  assert.equal(new Set(redis.definidos).size, cantidad, 'ninguno se registra dos veces');
  assert.ok(redis.definidos.includes('decrementarOferta') && redis.definidos.includes('invalidarCarrito') && redis.definidos.includes('reservarCupo'));
  assert.equal(typeof redis.eventos.error, 'function', 'sin un oyente de "error", ioredis escribe una línea por cada reintento');
  assert.equal(typeof redis.eventos.ready, 'function');
});

test('con la conexión perdida un comando falla AL INSTANTE con ServicioNoDisponible, sin llegar a ioredis', async () => {
  for (const estado of ['reconnecting', 'end']) {
    const { redis } = cliente();
    redis.status = estado;
    const comando = comandoFalso('get');
    await assert.rejects(redis.sendCommand(comando), (err) => err instanceof ServicioNoDisponible && err.componente === 'redis', estado);
    assert.deepEqual(redis.enviados, [], 'no se encoló: no hay nada que esperar');
  }
});

test('conectando o conectado, el comando sigue su camino normal (Redis puede estar sano)', () => {
  for (const estado of ['connecting', 'connect', 'ready']) {
    const { redis } = cliente();
    redis.status = estado;
    redis.sendCommand(comandoFalso('pttl'));
    assert.deepEqual(redis.enviados, ['pttl'], estado);
  }
});

test('cerrar() desconecta el cliente y la siguiente conexión es una nueva', () => {
  const { config, redis } = cliente();
  config.cerrar();
  assert.equal(redis.desconectado, true);
  assert.notEqual(config.conectar(), redis);
});
