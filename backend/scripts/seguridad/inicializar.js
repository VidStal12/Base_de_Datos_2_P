// Prepara el control de acceso de los contenedores (IA/PLAN-ENTREGA-FINAL.md §4.2). Es idempotente: se puede correr
// las veces que haga falta y nunca cambia una contraseña ni una llave que ya existe.
//
//   Redis    una contraseña aleatoria por cuenta de servicio (REDIS_CONTRASENA_<CUENTA>) y el archivo de ACL
//            docker/redis/users.acl, que lleva las contraseñas como hash SHA-256.
//   MongoDB  las contraseñas de mg_admin y mg_app (MONGO_CONTRASENA_<CUENTA>) y la llave del replica set
//            docker/mongo/keyfile (con autenticación, los miembros se identifican entre sí con ella).
//
// Las contraseñas van a backend/.env; el .env, users.acl y keyfile están fuera de git. No imprime ningún secreto.
// Después hay que recrear los contenedores y, para Mongo, crear los usuarios en el servidor:
//   docker compose up -d redis
//   npm run seguridad:mongo          (con Mongo corriendo; crea los roles y usuarios)
//   docker compose up -d mongo       (recrea Mongo con autenticación)
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const redis = require('../../src/config/redisCuentas');
const mongo = require('../../src/config/mongoCuentas');

const BACKEND = path.resolve(__dirname, '..', '..');
const RAIZ = path.resolve(BACKEND, '..');
const ENV = path.join(BACKEND, '.env');
const ENV_EJEMPLO = path.join(BACKEND, '.env.example');
const ACL_REDIS = path.join(RAIZ, 'docker', 'redis', 'users.acl');
const LLAVE_MONGO = path.join(RAIZ, 'docker', 'mongo', 'keyfile');

function leerEnv() {
  if (!fs.existsSync(ENV)) {
    if (!fs.existsSync(ENV_EJEMPLO)) throw new Error('No hay backend/.env ni backend/.env.example de dónde partir');
    fs.copyFileSync(ENV_EJEMPLO, ENV);
    console.log('backend/.env no existía: se creó a partir de .env.example (completá DATABASE_URL, JWT_SECRET, etc. si hace falta).');
  }
  const texto = fs.readFileSync(ENV, 'utf8');
  return { texto, salto: texto.includes('\r\n') ? '\r\n' : '\n' };
}

function valorDe(texto, variable) {
  const m = new RegExp(`^${variable}=(.*)$`, 'm').exec(texto);
  return m ? m[1].replace(/\r$/, '').trim() : undefined;
}

// Devuelve { valores: { variable → contraseña }, nuevas: [variables creadas] } y deja el texto del .env actualizado.
function asegurarContrasenas(texto, variables) {
  const valores = {};
  const nuevas = [];
  for (const variable of variables) {
    const actual = valorDe(texto, variable);
    if (actual && actual.length >= 16) {
      valores[variable] = actual;
      continue;
    }
    if (actual !== undefined && actual !== '') throw new Error(`${variable} en backend/.env tiene menos de 16 caracteres: corregila o borrala para que se genere una nueva`);
    valores[variable] = randomBytes(24).toString('hex');
    nuevas.push(variable);
  }
  return { valores, nuevas };
}

function main() {
  let { texto, salto } = leerEnv();
  const cuentasRedis = Object.keys(redis.CUENTAS);
  const cuentasMongo = Object.keys(mongo.USUARIOS);
  const variablesRedis = cuentasRedis.map(redis.variableContrasena);
  const variablesMongo = cuentasMongo.map(mongo.variableContrasena);
  const { valores, nuevas } = asegurarContrasenas(texto, [...variablesRedis, ...variablesMongo]);

  if (nuevas.length > 0) {
    for (const variable of nuevas) texto = texto.replace(new RegExp(`^${variable}=\\s*(\\r?\\n|$)`, 'm'), ''); // una vacía se reemplaza, no se duplica
    const bloque = [''];
    const nuevasRedis = nuevas.filter((v) => variablesRedis.includes(v));
    const nuevasMongo = nuevas.filter((v) => variablesMongo.includes(v));
    if (nuevasRedis.length > 0) {
      bloque.push('# Cuentas de servicio de Redis, una por módulo del backend (src/config/redisCuentas.js). Las generó', '# `npm run seguridad:inicializar`: no las compartas ni las subas a git.');
      bloque.push(...nuevasRedis.map((v) => `${v}=${valores[v]}`));
    }
    if (nuevasMongo.length > 0) {
      bloque.push('# Cuentas de MongoDB (src/config/mongoCuentas.js): el servidor web entra como mg_app; mg_admin es solo para mantenimiento.');
      bloque.push(...nuevasMongo.map((v) => `${v}=${valores[v]}`));
    }
    texto = `${texto.replace(/(\r?\n)*$/, '')}${salto}${bloque.join(salto)}${salto}`;
    fs.writeFileSync(ENV, texto);
  }

  // Redis: el archivo se escribe EN EL LUGAR (mismo archivo, no uno nuevo que lo reemplace): el contenedor lo ve montado.
  fs.mkdirSync(path.dirname(ACL_REDIS), { recursive: true });
  fs.writeFileSync(ACL_REDIS, redis.archivoAcl(Object.fromEntries(cuentasRedis.map((c) => [c, valores[redis.variableContrasena(c)]]))));

  // Mongo: la llave del replica set, una sola vez (cambiarla obliga a recrear el contenedor y no aporta nada).
  fs.mkdirSync(path.dirname(LLAVE_MONGO), { recursive: true });
  const llaveNueva = !fs.existsSync(LLAVE_MONGO);
  if (llaveNueva) fs.writeFileSync(LLAVE_MONGO, `${randomBytes(756).toString('base64')}\n`);

  const nombre = (variable) => variable.replace('REDIS_CONTRASENA_', 'rd_').replace('MONGO_CONTRASENA_', 'mg_').toLowerCase();
  console.log('Control de acceso');
  console.log(`  Redis    cuentas: ${cuentasRedis.map(redis.usuarioDe).join(', ')}`);
  console.log(`  MongoDB  cuentas: ${cuentasMongo.map((c) => mongo.USUARIOS[c].usuario).join(', ')}`);
  console.log(`  contraseñas nuevas en backend/.env: ${nuevas.length === 0 ? 'ninguna (ya estaban todas)' : nuevas.map(nombre).join(', ')}`);
  console.log(`  archivo de ACL de Redis (solo hashes): ${path.relative(RAIZ, ACL_REDIS)}`);
  console.log(`  llave del replica set de MongoDB: ${path.relative(RAIZ, LLAVE_MONGO)}${llaveNueva ? ' (nueva)' : ' (ya existía)'}`);
  console.log('\nSiguientes pasos:');
  console.log('  docker compose up -d redis      # Redis lee el archivo de ACL (el usuario `default` queda apagado)');
  console.log('  npm run seguridad:mongo         # con Mongo corriendo: crea el rol y los usuarios');
  console.log('  docker compose up -d mongo      # Mongo arranca exigiendo usuario y contraseña');
  console.log('y reiniciá el backend para que tome las contraseñas del .env.');
}

try {
  main();
} catch (err) {
  console.error(`No se pudo inicializar el control de acceso: ${err.message}`);
  process.exitCode = 1;
}
