const test = require('node:test');
const assert = require('node:assert/strict');
const { cargar } = require('./redisHelpers');

// GET /api/health/componentes: qué base responde ahora. La interfaz lo usa para decirle a la
// persona qué función está limitada, y quien apaga un contenedor de Docker ve al instante
// cómo lo toma la aplicación (estadoServiciosService.js).
function servicio() {
  return cargar('../src/services/estadoServiciosService.js', {
    mongoose: { connection: { db: { admin: () => ({ ping: async () => {} }), collection: () => ({ findOne: async () => null }) } } },
    '../config/prisma': {},
    '../config/mongo': {},
    '../config/redis': {},
    '../config/elasticsearch': {},
    '../config/neo4j': {},
    '../config/cassandra': {},
  }, {}, { setTimeout, clearTimeout });
}

const plano = (valor) => JSON.parse(JSON.stringify(valor));
const ok = async () => {};
const cae = (mensaje) => async () => { throw new Error(mensaje); };
const COMPLETAS = { mysql: ok, mongo: ok, redis: ok, elasticsearch: ok, neo4j: ok, cassandra: ok };

test('completo si todo responde; degradado si falta algo que no impide comprar; crítico sin MySQL o sin catálogo', async () => {
  const { resumir } = servicio();
  const estado = (caidos) => resumir(Object.fromEntries(Object.keys(COMPLETAS).map((n) => [n, { ok: !caidos.includes(n) }])));
  assert.equal(estado([]), 'completo');
  for (const caido of ['redis', 'elasticsearch', 'neo4j', 'cassandra']) assert.equal(estado([caido]), 'degradado', caido);
  assert.equal(estado(['mongo']), 'degradado', 'el catálogo se sirve del índice');
  assert.equal(estado(['redis', 'elasticsearch', 'neo4j', 'cassandra']), 'degradado', 'MySQL y Mongo bastan para comprar');
  assert.equal(estado(['mysql']), 'critico', 'sin MySQL no hay cuentas ni pedidos');
  assert.equal(estado(['mongo', 'elasticsearch']), 'critico', 'sin catálogo ni su copia no hay qué mostrar');
});

test('cada base se comprueba por separado: la que falla dice por qué y no tumba a las demás', async () => {
  const { consultar } = servicio();
  const r = plano(await consultar({ comprobaciones: { ...COMPLETAS, redis: cae('Command timed out') }, ahora: () => 0 }));
  assert.equal(r.estado, 'degradado');
  assert.equal(r.componentes.redis.ok, false);
  assert.match(r.componentes.redis.error, /Command timed out/);
  assert.equal(r.componentes.mysql.ok, true);
  assert.equal(typeof r.componentes.mysql.ms, 'number');
});

test('una base colgada no cuelga el endpoint: se corta a los 1,5 s y se informa', async () => {
  const { consultar } = servicio();
  const colgada = () => new Promise(() => {});
  const inicio = Date.now();
  const r = plano(await consultar({ comprobaciones: { ...COMPLETAS, neo4j: colgada }, ahora: () => 100000 }));
  assert.ok(Date.now() - inicio < 3000);
  assert.equal(r.componentes.neo4j.ok, false);
  assert.match(r.componentes.neo4j.error, /sin respuesta/);
});

test('el resultado vale 2 s: el frontend consulta cada 10 s y varios clientes no multiplican los pings', async () => {
  const { consultar } = servicio();
  let pings = 0;
  const contador = { ...COMPLETAS, mysql: async () => { pings += 1; } };
  let t = 500000; // un instante propio: la caché es del módulo y otras pruebas ya la usaron
  const reloj = () => t;
  await consultar({ comprobaciones: contador, ahora: reloj });
  const simultaneas = await Promise.all([consultar({ comprobaciones: contador, ahora: reloj }), consultar({ comprobaciones: contador, ahora: reloj })]);
  assert.equal(pings, 1, 'dentro de la vigencia se reutiliza el resultado');
  assert.equal(simultaneas[0], simultaneas[1]);
  t += 2500;
  await consultar({ comprobaciones: contador, ahora: reloj });
  assert.equal(pings, 2, 'vencida la vigencia, se vuelve a comprobar');
});

// ───────────────────────── Mongo con autenticación (IA/PLAN-ENTREGA-FINAL.md §4.2) ─────────────────────────
// `ping` no pide autenticación: con la cuenta del servidor rechazada el catálogo respondía 500 y la salud seguía en «ok».
// La comprobación de Mongo lee algo con la cuenta de la aplicación.
function servicioConMongo(collection, { ping = async () => {} } = {}) {
  return cargar('../src/services/estadoServiciosService.js', {
    mongoose: { connection: { db: { admin: () => ({ ping }), collection } } },
    '../config/prisma': {},
    '../config/mongo': { conectar: async () => {} },
    '../config/redis': {},
    '../config/elasticsearch': {},
    '../config/neo4j': {},
    '../config/cassandra': {},
  }, {}, { setTimeout, clearTimeout });
}

test('la salud de Mongo hace una lectura con la cuenta de la aplicación, no solo un ping', async () => {
  const lecturas = [];
  const { COMPROBACIONES } = servicioConMongo((nombre) => ({ findOne: async () => { lecturas.push(nombre); return null; } }));
  await COMPROBACIONES.mongo();
  assert.deepEqual(lecturas, ['categorias']);
});

test('si Mongo rechaza a la cuenta del servidor, la salud lo dice: falla y marca `credencial` (el detalle es solo para el administrador)', async () => {
  const rechazo = Object.assign(new Error('not authorized on tiendaya to execute command { find: "categorias" }'), { name: 'MongoServerError', codeName: 'Unauthorized' });
  const { consultar, paraPublico } = servicioConMongo(() => ({ findOne: async () => { throw rechazo; } }));
  const estado = await consultar({ comprobaciones: { mongo: servicioConMongo(() => ({ findOne: async () => { throw rechazo; } })).COMPROBACIONES.mongo } });
  assert.equal(estado.componentes.mongo.ok, false);
  assert.equal(estado.componentes.mongo.credencial, true);
  const publico = plano(paraPublico(estado));
  assert.deepEqual(publico.componentes.mongo, { ok: false }, 'quien no es administrador no ve ni el motivo ni la marca');
});
