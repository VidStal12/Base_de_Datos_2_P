const test = require('node:test');
const assert = require('node:assert/strict');
const { cargar } = require('./redisHelpers');
const { ServicioNoDisponible, CredencialRechazada } = require('../src/utils/resiliencia');
const { CUENTAS, variableContrasena } = require('../src/config/redisCuentas');

// config/redis.js con un ioredis de mentira: lo que se prueba es la POLÍTICA (tiempos
// acotados y rechazo inmediato mientras la conexión está caída, una conexión por cuenta de
// servicio, y qué pasa cuando Redis rechaza las credenciales), no el protocolo. Con los
// valores por defecto de ioredis un Redis apagado dejaba cada comando esperando ~73 s y
// hasta el catálogo público tardaba ~108 s (medido con el contenedor detenido); contra el
// Redis real lo cubren la medición en vivo de IA/ENTREGA-3-CONSISTENCIA.md §7 y
// `npm run verificar:acceso`.
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

// Un comando que nunca se resuelve (porque algo dejó de cortarlo) debe fallar la prueba, no colgarla.
const conPlazo = (promesa, ms = 500) => Promise.race([promesa, new Promise((_, rechazar) => setTimeout(() => rechazar(new Error(`sin respuesta en ${ms} ms: el comando se quedó esperando`)), ms).unref())]);

const CONTRASENA = 'c'.repeat(32);
const conTodasLasContrasenas = () => Object.fromEntries(Object.keys(CUENTAS).map((cuenta) => [variableContrasena(cuenta), CONTRASENA]));

function cliente(cuenta = 'carrito', entorno = {}) {
  const config = cargar('../src/config/redis.js', { ioredis: RedisFalso }, { REDIS_URL: 'redis://prueba:6379', ...entorno });
  const redis = config.conectar(cuenta);
  return { config, redis };
}

const wrongpass = () => Object.assign(new Error('WRONGPASS invalid username-password pair or user is disabled.'), { name: 'ReplyError' });

test('el cliente se crea con tiempos acotados: ningún comando espera más de unos segundos', () => {
  const { redis } = cliente();
  assert.equal(redis.url, 'redis://prueba:6379');
  assert.ok(redis.opciones.commandTimeout <= 2000, 'un comando sin respuesta se descarta en <= 2 s');
  assert.ok(redis.opciones.maxRetriesPerRequest <= 2, 'la cola de espera se vacía tras pocos reintentos (el valor por defecto era 20)');
  assert.ok(redis.opciones.connectTimeout <= 3000);
  assert.equal(redis.opciones.retryStrategy(1) <= 500, true, 'los primeros reintentos son rápidos');
  assert.equal(redis.opciones.retryStrategy(1000), 2000, 'y la espera nunca pasa de 2 s');
  assert.equal(redis.opciones.enableReadyCheck, false, 'ioredis no pregunta INFO: una cuenta de servicio no lo tiene');
  assert.equal(redis.opciones.disableClientInfo, true, 'ni CLIENT SETINFO');
});

test('es el mismo cliente en cada llamada, con los scripts Lua registrados una sola vez', () => {
  const { config, redis } = cliente();
  assert.equal(config.conectar('carrito'), redis);
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
    await assert.rejects(conPlazo(redis.sendCommand(comando)), (err) => err instanceof ServicioNoDisponible && err.componente === 'redis', estado);
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

test('cerrar() desconecta TODOS los clientes abiertos y la siguiente conexión es una nueva', () => {
  const config = cargar('../src/config/redis.js', { ioredis: RedisFalso }, { REDIS_URL: 'redis://prueba:6379', ...conTodasLasContrasenas() });
  const carrito = config.conectar('carrito');
  const actividad = config.conectar('actividad');
  assert.notEqual(carrito, actividad);
  config.cerrar();
  assert.equal(carrito.desconectado, true);
  assert.equal(actividad.desconectado, true);
  assert.notEqual(config.conectar('carrito'), carrito);
});

test('sin contraseñas en el entorno (Redis todavía sin ACL) todas las cuentas comparten UNA conexión sin credenciales', () => {
  const { config, redis } = cliente('carrito');
  for (const cuenta of Object.keys(CUENTAS)) assert.equal(config.conectar(cuenta), redis, cuenta);
  assert.equal(redis.opciones.username, undefined);
  assert.equal(redis.opciones.password, undefined);
});

test('con contraseñas, cada cuenta entra con su propio cliente, su usuario y su contraseña (nadie usa «default»)', () => {
  const entorno = conTodasLasContrasenas();
  const config = cargar('../src/config/redis.js', { ioredis: RedisFalso }, { REDIS_URL: 'redis://prueba:6379', ...entorno });
  const clientes = Object.keys(CUENTAS).map((cuenta) => [cuenta, config.conectar(cuenta)]);
  assert.equal(new Set(clientes.map(([, c]) => c)).size, Object.keys(CUENTAS).length, 'un cliente por cuenta');
  for (const [cuenta, redis] of clientes) {
    assert.equal(redis.opciones.username, `rd_${cuenta}`);
    assert.equal(redis.opciones.password, CONTRASENA);
    assert.notEqual(redis.opciones.username, 'default');
    assert.equal(redis.url, 'redis://prueba:6379', 'el servidor sale de REDIS_URL; las credenciales, de la cuenta');
    assert.equal(config.conectar(cuenta), redis, 'y es el mismo en cada llamada');
  }
});

test('una cuenta sin contraseña propia no se cuela por la de otra: cae a la conexión sin credenciales, y se nota', () => {
  const entorno = { [variableContrasena('carrito')]: CONTRASENA };
  const config = cargar('../src/config/redis.js', { ioredis: RedisFalso }, { REDIS_URL: 'redis://prueba:6379', ...entorno });
  const carrito = config.conectar('carrito');
  const ofertas = config.conectar('ofertas');
  assert.equal(carrito.opciones.username, 'rd_carrito');
  assert.equal(ofertas.opciones.username, undefined, 'ofertas no hereda las credenciales del carrito');
  assert.notEqual(ofertas, carrito);
});

test('conectar() exige una cuenta conocida: un módulo no puede entrar «sin decir quién es»', () => {
  const config = cargar('../src/config/redis.js', { ioredis: RedisFalso }, { REDIS_URL: 'redis://prueba:6379' });
  assert.throws(() => config.conectar(), /Cuenta de Redis desconocida/);
  assert.throws(() => config.conectar('root'), /Cuenta de Redis desconocida: «root»/);
  assert.throws(() => config.conectar('default'), /desconocida/);
});

test('si Redis rechaza el login (WRONGPASS) no se reintenta en bucle: la cuenta queda rechazada y sus comandos fallan al instante', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { redis } = cliente('carrito', conTodasLasContrasenas());
  assert.equal(redis.opciones.retryStrategy(1) > 0, true, 'mientras no la rechacen, reintenta');
  redis.eventos.error(wrongpass());
  assert.ok(redis.credencialRechazada instanceof CredencialRechazada);
  assert.equal(redis.credencialRechazada.cuenta, 'rd_carrito');
  assert.equal(redis.opciones.retryStrategy(1), null, 'ya no reconecta');
  for (const estado of ['ready', 'reconnecting', 'end']) {
    redis.status = estado;
    await assert.rejects(conPlazo(redis.sendCommand(comandoFalso('get'))), (err) => err instanceof CredencialRechazada && err.status === 500, estado);
  }
  assert.deepEqual(redis.enviados, [], 'ni un comando llegó a ioredis');
});

test('NOAUTH (el servidor exige credenciales y el backend no tiene) también cierra el cerrojo', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { redis } = cliente('carrito'); // sin contraseñas en el entorno
  redis.eventos.error(Object.assign(new Error('NOAUTH HELLO must be called with the client already authenticated'), { name: 'ReplyError' }));
  await assert.rejects(conPlazo(redis.sendCommand(comandoFalso('get'))), CredencialRechazada);
});

test('un error de red NO cierra el cerrojo: es una caída, y se sigue reintentando', (t) => {
  t.mock.method(console, 'error', () => {});
  const { redis } = cliente('carrito', conTodasLasContrasenas());
  redis.eventos.error(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6379'), { code: 'ECONNREFUSED' }));
  assert.equal(redis.credencialRechazada, undefined);
  assert.equal(redis.opciones.retryStrategy(1) > 0, true);
});

test('un NOPERM (un comando que la cuenta no tiene) no cierra el cerrojo: el login fue bueno, solo ese comando está prohibido', (t) => {
  t.mock.method(console, 'error', () => {});
  const { redis } = cliente('carrito', conTodasLasContrasenas());
  redis.eventos.error(Object.assign(new Error("NOPERM User rd_carrito has no permissions to run the 'flushall' command"), { name: 'ReplyError' }));
  assert.equal(redis.credencialRechazada, undefined);
  assert.equal(redis.opciones.retryStrategy(1) > 0, true);
});

test('pasado el tiempo de espera se prueba UNA vez más con un cliente nuevo; antes, el mismo cliente rechazado', (t) => {
  t.mock.method(console, 'error', () => {});
  const entorno = conTodasLasContrasenas();
  const config = cargar('../src/config/redis.js', { ioredis: RedisFalso }, { REDIS_URL: 'redis://prueba:6379', ...entorno });
  const primero = config.conectar('carrito');
  primero.eventos.error(wrongpass());
  assert.equal(config.conectar('carrito'), primero, 'recién rechazada: no se abre otra conexión');
  assert.equal(primero.desconectado, undefined);

  primero.rechazadaEn = Date.now() - 31000;
  const segundo = config.conectar('carrito');
  assert.notEqual(segundo, primero, 'pasaron más de 30 s: cliente nuevo');
  assert.equal(primero.desconectado, true, 'el rechazado se cierra');
  assert.equal(segundo.credencialRechazada, undefined, 'y el nuevo empieza limpio');
  assert.equal(config.conectar('carrito'), segundo);
});
