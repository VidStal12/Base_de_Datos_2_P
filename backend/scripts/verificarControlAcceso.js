// npm run verificar:acceso — la matriz de cuentas de servicio contra las bases REALES (IA/PLAN-ENTREGA-FINAL.md §4.2).
//   npm run verificar:acceso            Redis y MongoDB
//   npm run verificar:acceso -- redis   solo Redis      npm run verificar:acceso -- mongo   solo MongoDB
//
// REDIS. Para cada cuenta de src/config/redisCuentas.js comprueba lo que la lista blanca promete, por los dos lados:
//   - lo PERMITIDO se evalúa con ACL DRYRUN (Redis dice si lo dejaría pasar, sin ejecutarlo: no toca ningún dato);
//   - lo NEGADO se ejecuta de verdad con esa cuenta y tiene que responder NOPERM. Antes se consulta ACL DRYRUN: si
//     por un error de configuración Redis lo dejara pasar, NO se ejecuta (un FLUSHALL permitido borraría datos) y se
//     marca como falla.
//   También el login: sin credenciales, con la cuenta `default` y con una contraseña incorrecta no se entra.
//
// MONGODB. Comprueba que los privilegios de `mg_app` en el servidor sean EXACTAMENTE los declarados en
// src/config/mongoCuentas.js, que sin credenciales y con una contraseña mala no se entre, y ejecuta de verdad lo que
// `mg_app` no debe poder hacer (modificar o borrar un evento del historial, borrar colecciones o bases, crear usuarios,
// leer lo ajeno), que tiene que responder «not authorized». Como en Redis, antes de ejecutar algo prohibido se mira
// que el servidor no lo permita: si lo permitiera por un error de configuración, no se ejecuta y se marca como falla.
//
// Imprime la matriz y termina con código 1 si algo no coincide. Las denegaciones quedan en el registro de cada base.
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const Redis = require('ioredis');
const { MongoClient, ObjectId } = require('mongodb');
const redisCuentas = require('../src/config/redisCuentas');
const mongoCuentas = require('../src/config/mongoCuentas');

const { CUENTAS, usuarioDe, variableContrasena } = redisCuentas;
const DENEGADO_REDIS = /NOPERM|ACL failure in script|can't (run this command|access at least one of the keys)/;
let fallas = 0;
let comprobaciones = 0;

function resultado(ok, texto, detalle = '') {
  comprobaciones += 1;
  if (!ok) fallas += 1;
  console.log(`  ${ok ? '✔' : '✖'} ${texto}${detalle ? `  → ${detalle}` : ''}`);
}

async function intentar(operacion) {
  try {
    return { valor: await operacion() };
  } catch (err) {
    return { error: String(err.message).split('\n')[0].slice(0, 110), codeName: err.codeName };
  }
}

// ───────────────────────────── Redis ─────────────────────────────

function conectarRedis(opciones) {
  const cliente = new Redis(process.env.REDIS_URL, { retryStrategy: () => null, maxRetriesPerRequest: 0, enableReadyCheck: false, disableClientInfo: true, ...opciones });
  cliente.on('error', () => {}); // los errores de login se ven en cada comprobación, no como eventos sueltos
  return cliente;
}
const comoCuentaRedis = (cuenta) => conectarRedis({ username: usuarioDe(cuenta), password: process.env[variableContrasena(cuenta)] });

async function verificarRedis() {
  console.log('══ Redis ══');
  const faltan = Object.keys(CUENTAS).filter((c) => !process.env[variableContrasena(c)]);
  if (!process.env.REDIS_URL || faltan.length > 0) {
    console.error(`Falta ${!process.env.REDIS_URL ? 'REDIS_URL' : faltan.map(variableContrasena).join(', ')} en backend/.env.`);
    console.error('Ejecutá `npm run seguridad:inicializar`, luego `docker compose up -d redis`, y volvé a correr esto.');
    fallas += 1;
    return;
  }
  const inicio = Date.now();
  const admin = comoCuentaRedis('admin');
  const quien = await intentar(() => admin.call('ACL', 'WHOAMI'));
  if (quien.error || quien.valor !== usuarioDe('admin')) {
    console.error(`No se pudo entrar a Redis como ${usuarioDe('admin')}: ${quien.error ?? `entró como ${quien.valor}`}.`);
    console.error('¿El contenedor tiene el archivo de ACL? `npm run seguridad:inicializar` y `docker compose up -d redis`.');
    admin.disconnect();
    fallas += 1;
    return;
  }

  console.log('Quién puede entrar');
  const sinCredenciales = conectarRedis({});
  const anonimo = await intentar(() => sinCredenciales.call('PING'));
  resultado(/NOAUTH/.test(anonimo.error ?? ''), 'sin credenciales no se hace nada', anonimo.error ?? 'PING respondió: el usuario «default» sigue abierto');
  sinCredenciales.disconnect();
  const porDefecto = conectarRedis({ username: 'default', password: 'cualquiera-1234567890' });
  const comoDefault = await intentar(() => porDefecto.call('PING'));
  resultado(/WRONGPASS|invalid username-password/.test(comoDefault.error ?? ''), 'la cuenta «default» está apagada', comoDefault.error ?? 'entró');
  porDefecto.disconnect();
  const mala = conectarRedis({ username: usuarioDe('carrito'), password: 'contraseña-incorrecta-123' });
  const conMala = await intentar(() => mala.call('PING'));
  resultado(/WRONGPASS/.test(conMala.error ?? ''), `${usuarioDe('carrito')} con una contraseña incorrecta no entra`, conMala.error ?? 'entró');
  mala.disconnect();

  for (const [cuenta, definicion] of Object.entries(CUENTAS)) {
    const usuario = usuarioDe(cuenta);
    console.log(`\n${usuario}  ${definicion.todo ? '(todo)' : ''}\n  ${definicion.uso}`);
    for (const comando of definicion.pruebas.permitido) {
      const veredicto = await intentar(() => admin.call('ACL', 'DRYRUN', usuario, ...comando));
      resultado(veredicto.valor === 'OK', `permitido  ${comando.join(' ')}`, veredicto.valor === 'OK' ? 'OK' : (veredicto.valor ?? veredicto.error));
    }
    if (definicion.pruebas.negado.length === 0) continue;
    const c = comoCuentaRedis(cuenta);
    for (const comando of definicion.pruebas.negado) {
      const texto = comando.join(' ').slice(0, 56);
      // Un EVAL de prueba solo LEE una llave ajena: se ejecuta siempre (lo que se comprueba es que el script no escapa).
      const soloLectura = comando[0] === 'EVAL' && /^return redis\.call\('GET','[^']+'\)$/.test(comando[1]);
      if (!soloLectura) {
        const veredicto = await intentar(() => admin.call('ACL', 'DRYRUN', usuario, ...comando));
        if (veredicto.valor === 'OK') {
          resultado(false, `negado     ${texto}`, 'Redis lo DEJARÍA pasar (no se ejecutó)');
          continue;
        }
      }
      const intento = await intentar(() => c.call(comando[0], ...comando.slice(1)));
      resultado(DENEGADO_REDIS.test(intento.error ?? ''), `negado     ${texto}`, intento.error ?? `EJECUTÓ y respondió ${JSON.stringify(intento.valor)}`);
    }
    c.disconnect();
  }

  // Lo que Redis anotó de esta corrida: es la evidencia que queda en el servidor.
  const registro = await intentar(() => admin.call('ACL', 'LOG', '200'));
  const propias = (registro.valor ?? [])
    .map((e) => Object.fromEntries(Array.from({ length: e.length / 2 }, (_, i) => [e[2 * i], e[2 * i + 1]])))
    .filter((e) => Number(e['age-seconds']) <= (Date.now() - inicio) / 1000 + 2); // la edad la mide el reloj de Redis, no el nuestro
  const porRazon = propias.reduce((acc, e) => ({ ...acc, [e.reason]: (acc[e.reason] ?? 0) + 1 }), {});
  console.log(`\nACL LOG de Redis (esta corrida): ${propias.length} denegaciones ${JSON.stringify(porRazon)}`);
  admin.disconnect();
}

// ───────────────────────────── MongoDB ─────────────────────────────

// Convierte los {"$oid": "..."} de las pruebas declaradas en ObjectId reales.
function conObjectId(valor) {
  if (Array.isArray(valor)) return valor.map(conObjectId);
  if (valor && typeof valor === 'object') {
    if (typeof valor.$oid === 'string') return new ObjectId(valor.$oid);
    return Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, conObjectId(v)]));
  }
  return valor;
}

// Qué acción de Mongo exige cada orden de las pruebas, para mirar si el usuario la tiene ANTES de ejecutarla.
const ACCION_DE_COMANDO = { find: 'find', insert: 'insert', update: 'update', delete: 'remove', drop: 'dropCollection', dropDatabase: 'dropDatabase', createUser: 'createUser' };

function urlMongo(usuario, contrasena, authSource) {
  const base = new URL(process.env.MONGO_URI);
  const credenciales = usuario ? `${encodeURIComponent(usuario)}:${encodeURIComponent(contrasena)}@` : '';
  return `mongodb://${credenciales}${base.host}/${mongoCuentas.BASE_DE_DATOS}?directConnection=true${authSource ? `&authSource=${authSource}` : ''}`;
}
const clienteMongo = (usuario, contrasena, authSource) => new MongoClient(urlMongo(usuario, contrasena, authSource), { serverSelectionTimeoutMS: 4000, appName: 'verificar-acceso' });

async function verificarMongo() {
  console.log('\n══ MongoDB ══');
  const { USUARIOS } = mongoCuentas;
  const faltan = Object.keys(USUARIOS).filter((c) => !process.env[mongoCuentas.variableContrasena(c)]);
  if (!process.env.MONGO_URI || faltan.length > 0) {
    console.error(`Falta ${!process.env.MONGO_URI ? 'MONGO_URI' : faltan.map(mongoCuentas.variableContrasena).join(', ')} en backend/.env.`);
    console.error('Ejecutá `npm run seguridad:inicializar`, `npm run seguridad:mongo` y `docker compose up -d mongo`, y volvé a correr esto.');
    fallas += 1;
    return;
  }
  const admin = clienteMongo(USUARIOS.admin.usuario, process.env[mongoCuentas.variableContrasena('admin')], USUARIOS.admin.db);
  const app = clienteMongo(USUARIOS.app.usuario, process.env[mongoCuentas.variableContrasena('app')], USUARIOS.app.db);
  const anonimo = clienteMongo();
  const mala = clienteMongo(USUARIOS.app.usuario, 'contraseña-incorrecta-123', USUARIOS.app.db);
  try {
    const yo = await intentar(() => admin.db('admin').command({ connectionStatus: 1 }));
    if (yo.error) {
      console.error(`No se pudo entrar a MongoDB como ${USUARIOS.admin.usuario}: ${yo.error}`);
      console.error('¿Mongo ya exige autenticación y tiene los usuarios? `npm run seguridad:mongo` y `docker compose up -d mongo`.');
      fallas += 1;
      return;
    }

    console.log('Quién puede entrar');
    const sinCredenciales = await intentar(() => anonimo.db(mongoCuentas.BASE_DE_DATOS).collection('productos').find({}).limit(1).toArray());
    resultado(sinCredenciales.codeName === 'Unauthorized', 'sin credenciales no se lee nada', sinCredenciales.error ?? 'LEYÓ: Mongo no exige autenticación');
    const conMala = await intentar(() => mala.db(mongoCuentas.BASE_DE_DATOS).collection('productos').find({}).limit(1).toArray());
    resultado(conMala.codeName === 'AuthenticationFailed', `${USUARIOS.app.usuario} con una contraseña incorrecta no entra`, conMala.error ?? 'entró');

    const info = await intentar(() => admin.db(USUARIOS.app.db).command({ usersInfo: { user: USUARIOS.app.usuario, db: USUARIOS.app.db }, showPrivileges: true }));
    const usuario = info.valor?.users?.[0];
    console.log(`\n${USUARIOS.app.usuario}  rol app_tiendaya\n  ${mongoCuentas.ROLES.app_tiendaya.uso}`);
    resultado(Boolean(usuario) && usuario.roles.length === 1 && usuario.roles[0].role === 'app_tiendaya', 'tiene un solo rol: app_tiendaya', usuario ? JSON.stringify(usuario.roles) : 'el usuario no existe');
    const real = mongoCuentas.normalizarPrivilegios(usuario?.inheritedPrivileges ?? []);
    const declarado = mongoCuentas.normalizarPrivilegios(mongoCuentas.privilegiosDe('app_tiendaya'));
    const colecciones = [...new Set([...Object.keys(real), ...Object.keys(declarado)])].sort();
    for (const coleccion of colecciones) {
      const igual = JSON.stringify(real[coleccion]) === JSON.stringify(declarado[coleccion]);
      resultado(igual, `permitido  ${coleccion}: ${(declarado[coleccion] ?? ['(nada)']).join(', ')}`, igual ? 'el servidor coincide' : `el servidor tiene: ${(real[coleccion] ?? ['(nada)']).join(', ')}`);
    }
    const lectura = await intentar(() => app.db(mongoCuentas.BASE_DE_DATOS).collection('productos').find({}).limit(1).toArray());
    resultado(Array.isArray(lectura.valor) && lectura.valor.length === 1, 'permitido  leer el catálogo (find productos)', lectura.error ?? 'OK');
    const eventos = await intentar(() => app.db(mongoCuentas.BASE_DE_DATOS).collection('producto_eventos').find({}).limit(1).toArray());
    resultado(Array.isArray(eventos.valor), 'permitido  leer el historial (find producto_eventos)', eventos.error ?? 'OK');

    for (const prueba of mongoCuentas.PRUEBAS_APP.denegado) {
      const accion = ACCION_DE_COMANDO[Object.keys(prueba.comando)[0]];
      const coleccion = typeof Object.values(prueba.comando)[0] === 'string' ? Object.values(prueba.comando)[0] : null;
      const loTendria = (usuario?.inheritedPrivileges ?? []).some((p) => p.resource.db === prueba.db && (p.resource.collection === (coleccion ?? p.resource.collection)) && p.actions.includes(accion));
      if (loTendria) {
        resultado(false, `negado     ${prueba.texto}`, `el servidor SÍ le da «${accion}» (no se ejecutó)`);
        continue;
      }
      const intento = await intentar(() => app.db(prueba.db).command(conObjectId(prueba.comando)));
      resultado(intento.codeName === 'Unauthorized', `negado     ${prueba.texto}`, intento.error ?? `EJECUTÓ y respondió ${JSON.stringify(intento.valor).slice(0, 60)}`);
    }
  } finally {
    await Promise.all([admin.close(), app.close(), anonimo.close(), mala.close()]);
  }
}

async function main() {
  const quiere = process.argv[2];
  if (quiere && !['redis', 'mongo'].includes(quiere)) {
    console.error('Uso: npm run verificar:acceso [-- redis | mongo]');
    process.exitCode = 1;
    return;
  }
  if (!quiere || quiere === 'redis') await verificarRedis();
  if (!quiere || quiere === 'mongo') await verificarMongo();
  console.log(`\n${comprobaciones} comprobaciones, ${fallas} fallas.`);
  process.exitCode = fallas === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('ERROR del script:', err.message);
  process.exitCode = 1;
});
