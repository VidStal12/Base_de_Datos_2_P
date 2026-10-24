const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { esErrorDeAcceso, componenteCaido, CredencialRechazada } = require('../src/utils/resiliencia');
const { cuerpoDeError, estadoDeError } = require('../src/utils/http');
const mongo = require('../src/config/mongoCuentas');

// Control de acceso a MongoDB (IA/PLAN-ENTREGA-FINAL.md §4.0 y §4.2): el rol del servidor web es una lista blanca
// y el historial de cambios es append-only por garantía de la base. Contra un Mongo de verdad lo prueba
// `npm run verificar:acceso`.

const SRC = path.join(__dirname, '..', 'src');
const ACCIONES_PERMITIDAS = new Set(['find', 'insert', 'update', 'createIndex', 'createCollection', 'listIndexes']);

// ───────────────────────── 1. La lista blanca del rol ─────────────────────────

test('el rol de la aplicación nombra cada colección: ningún comodín, ninguna base entera, ninguna acción de administración', () => {
  const privilegios = mongo.privilegiosDe('app_tiendaya');
  assert.ok(privilegios.length >= 5);
  for (const { resource, actions } of privilegios) {
    assert.equal(resource.db, 'tiendaya', 'solo la base de la aplicación');
    assert.ok(resource.collection && resource.collection !== '', `${resource.collection}: una colección con nombre, nunca la base entera`);
    assert.ok(!('cluster' in resource) && !('anyResource' in resource));
    for (const accion of actions) assert.ok(ACCIONES_PERMITIDAS.has(accion), `${resource.collection}: la acción «${accion}» no está en la lista blanca`);
  }
});

test('NADIE puede borrar con el rol de la aplicación: ni una colección tiene `remove`, `drop` o `dropCollection`', () => {
  for (const { resource, actions } of mongo.privilegiosDe('app_tiendaya')) {
    for (const prohibida of ['remove', 'dropCollection', 'dropDatabase', 'dropIndex', 'anyAction', 'createUser', 'createRole', 'grantRole']) {
      assert.ok(!actions.includes(prohibida), `${resource.collection} no puede tener ${prohibida}`);
    }
  }
});

test('el historial de cambios (producto_eventos) es append-only: solo leer e insertar, más lo que Mongoose usa al cargar el modelo', () => {
  const { actions } = mongo.privilegiosDe('app_tiendaya').find((p) => p.resource.collection === 'producto_eventos');
  assert.deepEqual([...actions].sort(), ['createCollection', 'createIndex', 'find', 'insert', 'listIndexes']);
  assert.ok(!actions.includes('update'), 'un evento no se modifica nunca');
  assert.ok(!actions.includes('remove'), 'ni se borra');
  const demas = mongo.privilegiosDe('app_tiendaya').filter((p) => p.resource.collection !== 'producto_eventos');
  assert.ok(demas.every((p) => p.actions.includes('update')), 'el resto del catálogo sí se edita (precio, stock, reseñas…)');
});

test('el servidor web tiene un solo rol, el de la aplicación; solo mg_admin es root', () => {
  assert.deepEqual(mongo.USUARIOS.app.roles, [{ role: 'app_tiendaya', db: 'tiendaya' }]);
  assert.deepEqual(mongo.USUARIOS.admin.roles, [{ role: 'root', db: 'admin' }]);
  assert.equal(mongo.USUARIOS.app.usuario, 'mg_app');
  assert.equal(mongo.USUARIOS.admin.usuario, 'mg_admin');
  assert.equal(mongo.variableContrasena('app'), 'MONGO_CONTRASENA_APP');
  assert.throws(() => mongo.definicion('root'), /Cuenta de Mongo desconocida/);
});

test('normalizarPrivilegios ordena y une, para poder comparar lo declarado con lo que devuelve el servidor', () => {
  const mapa = mongo.normalizarPrivilegios([
    { resource: { db: 'tiendaya', collection: 'a' }, actions: ['update', 'find'] },
    { resource: { db: 'tiendaya', collection: 'a' }, actions: ['insert', 'find'] },
    { resource: { cluster: true }, actions: ['x'] },
  ]);
  assert.deepEqual(mapa, { 'tiendaya.a': ['find', 'insert', 'update'], cluster: ['x'] });
});

test('las pruebas de denegación cubren el historial, el borrado, los usuarios y lo ajeno', () => {
  const textos = mongo.PRUEBAS_APP.denegado.map((p) => p.texto);
  for (const esperado of ['modificar un evento del historial', 'borrar un evento del historial', 'borrar la colección del historial', 'crear un usuario', 'borrar una base de datos', 'leer otra base']) {
    assert.ok(textos.includes(esperado), esperado);
  }
  for (const { comando } of mongo.PRUEBAS_APP.denegado) assert.ok(Object.keys(comando).length >= 1);
});

// ───────────────────────── 2. Cómo se reconoce un rechazo de Mongo ─────────────────────────

const deMongo = (codeName, mensaje) => Object.assign(new Error(mensaje), { name: 'MongoServerError', codeName });
const RECHAZOS = [
  deMongo('Unauthorized', 'Command find requires authentication'),
  deMongo('Unauthorized', 'not authorized on tiendaya to execute command { update: "producto_eventos", updates: [ [Object] ], lsid: { id: UUID("…") } }'),
  deMongo('AuthenticationFailed', 'Authentication failed.'),
];

test('un rechazo de Mongo (sin sesión, sin permiso o contraseña mala) se reconoce y NO es una caída', () => {
  for (const err of RECHAZOS) {
    assert.equal(esErrorDeAcceso(err), 'mongo', err.message.slice(0, 40));
    assert.equal(componenteCaido(err), null);
  }
});

test('lo que no es un rechazo de Mongo no se confunde con uno', () => {
  assert.equal(esErrorDeAcceso(deMongo('DuplicateKey', 'E11000 duplicate key error collection: tiendaya.resenas')), null);
  assert.equal(esErrorDeAcceso(Object.assign(new Error('Producto no encontrado'), { status: 404 })), null);
  assert.equal(esErrorDeAcceso(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:27018'), { name: 'MongoServerSelectionError' })), null);
});

test('al cliente un rechazo de Mongo le llega como 500 CREDENCIAL_RECHAZADA, sin el comando que se intentó', () => {
  const err = RECHAZOS[1];
  assert.equal(estadoDeError(err, 404), 500);
  const cuerpo = cuerpoDeError(err);
  assert.equal(cuerpo.codigo, 'CREDENCIAL_RECHAZADA');
  assert.doesNotMatch(JSON.stringify(cuerpo), /producto_eventos|tiendaya|update|lsid/);
  assert.ok(new CredencialRechazada('mongo', 'mg_app', err) instanceof Error);
});

// ───────────────────────── 3. El código de la aplicación nunca intenta lo que la base no permitiría ─────────────────────────

function archivosJs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? archivosJs(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
}
const sinComentarios = (texto) => texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

test('el servidor nunca modifica ni borra un evento del historial (la base lo impediría; el código tampoco lo intenta)', () => {
  const culpables = [];
  for (const archivo of archivosJs(SRC)) {
    const texto = sinComentarios(fs.readFileSync(archivo, 'utf8'));
    for (const m of texto.matchAll(/ProductoEvento\s*\.\s*(updateOne|updateMany|replaceOne|findOneAndUpdate|findByIdAndUpdate|findOneAndReplace|deleteOne|deleteMany|findOneAndDelete|findByIdAndDelete|remove|bulkWrite|drop)\b/g)) {
      culpables.push(`${path.relative(SRC, archivo)}: ProductoEvento.${m[1]}`);
    }
  }
  assert.deepEqual(culpables, []);
});

test('el servidor no borra documentos de Mongo: el rol de la aplicación no tiene `remove` (Prisma/MySQL es otra cosa)', () => {
  const culpables = [];
  const modelos = ['Producto', 'Categoria', 'Subcategoria', 'Resena', 'ProductoEvento'];
  for (const archivo of archivosJs(SRC)) {
    const texto = sinComentarios(fs.readFileSync(archivo, 'utf8'));
    for (const m of texto.matchAll(new RegExp(`\\b(${modelos.join('|')})\\s*\\.\\s*(deleteOne|deleteMany|findOneAndDelete|findByIdAndDelete|remove|drop)\\b`, 'g'))) {
      culpables.push(`${path.relative(SRC, archivo)}: ${m[1]}.${m[2]}`);
    }
  }
  assert.deepEqual(culpables, []);
});

test('el servidor solo se conecta a Mongo por config/mongo.js (una sola puerta, con su cuenta)', () => {
  const conectores = [];
  for (const archivo of archivosJs(SRC)) {
    if (archivo.endsWith(`${path.sep}config${path.sep}mongo.js`)) continue;
    const texto = sinComentarios(fs.readFileSync(archivo, 'utf8'));
    if (/mongoose\s*\.\s*connect\s*\(|new\s+MongoClient\s*\(/.test(texto)) conectores.push(path.relative(SRC, archivo));
  }
  assert.deepEqual(conectores, [], 'otra conexión a Mongo se saltaría la cuenta de servicio');
});

test('ningún archivo de src/ pide la cuenta de administración de Mongo: solo los scripts de mantenimiento', () => {
  const culpables = [];
  for (const archivo of archivosJs(SRC)) {
    const texto = sinComentarios(fs.readFileSync(archivo, 'utf8'));
    if (/\bconectar(Mongo)?\s*\(\s*['"]admin['"]\s*\)/.test(texto)) culpables.push(path.relative(SRC, archivo));
  }
  assert.deepEqual(culpables, []);
});

// El texto de cada argumento de las llamadas a la `conectar` DE MONGO de un archivo (no a la de Redis, que también
// puede llamarse conectar('admin')).
function llamadasAMongo(archivo) {
  const texto = sinComentarios(fs.readFileSync(archivo, 'utf8'));
  const patrones = [];
  const desestructurado = /const\s*\{([^}]*)\}\s*=\s*require\(\s*['"][^'"]*config\/mongo['"]\s*\)/.exec(texto);
  if (desestructurado) {
    for (const parte of desestructurado[1].split(',')) {
      const m = /^\s*conectar\s*(?::\s*(\w+))?\s*$/.exec(parte);
      if (m) patrones.push(new RegExp(`(?<![\\w.])${m[1] ?? 'conectar'}\\(([^)]*)\\)`, 'g'));
    }
  }
  const modulo = /const\s+(\w+)\s*=\s*require\(\s*['"][^'"]*config\/mongo['"]\s*\)/.exec(texto);
  if (modulo) patrones.push(new RegExp(`\\b${modulo[1]}\\.conectar\\(([^)]*)\\)`, 'g'));
  return patrones.flatMap((patron) => [...texto.matchAll(patron)].map((m) => m[1].trim()));
}

test('los scripts que BORRAN en Mongo (el seed, las pruebas que limpian lo suyo) entran con la cuenta de administración', () => {
  const raiz = path.join(__dirname, '..');
  const modelos = ['Producto', 'Categoria', 'Subcategoria', 'Resena', 'ProductoEvento'];
  const sinPedirAdmin = [];
  const carpetas = [path.join(raiz, 'scripts'), path.join(raiz, 'prisma')];
  for (const carpeta of carpetas) {
    for (const archivo of archivosJs(carpeta)) {
      if (archivo.includes(`${path.sep}spike-pagos${path.sep}`)) continue; // el ensayo del ADR-005 trae su propia conexión
      const texto = sinComentarios(fs.readFileSync(archivo, 'utf8'));
      const borra = new RegExp(`\\b(${modelos.join('|')})\\s*\\.\\s*(deleteOne|deleteMany|findOneAndDelete|findByIdAndDelete|remove|drop)\\b`).test(texto);
      if (!borra) continue;
      const llamadas = llamadasAMongo(archivo);
      // Todas sus conexiones a Mongo piden 'admin', y hay al menos una (si no, conectaría el primer servicio que toque).
      if (llamadas.length === 0 || llamadas.some((argumento) => argumento !== "'admin'")) sinPedirAdmin.push(path.relative(raiz, archivo));
    }
  }
  assert.deepEqual(sinPedirAdmin, [], 'estos scripts borran en Mongo y con el rol de la aplicación fallarían con Unauthorized');
});
