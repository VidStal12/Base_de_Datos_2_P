// npm run seguridad:mongo — crea (o actualiza) en el MongoDB que esté corriendo el rol `app_tiendaya` y los usuarios
// `mg_admin` y `mg_app` (IA/PLAN-ENTREGA-FINAL.md §4.2), a partir de src/config/mongoCuentas.js. Es idempotente.
//
// Corre mongosh DENTRO del contenedor (docker exec): con la autenticación activada y sin ningún usuario, Mongo solo
// deja crear el primer usuario desde localhost del servidor (la «localhost exception»), y una conexión desde el host
// a través del puerto publicado no cuenta como tal. Las contraseñas viajan por variables de entorno del proceso, no
// por la línea de comandos. Sirve en los tres casos: Mongo todavía sin autenticación (el estado de antes), Mongo
// nuevo con autenticación y sin usuarios, y Mongo con autenticación y usuarios ya creados (entra como mg_admin).
require('dotenv').config({ path: require('node:path').join(__dirname, '..', '..', '.env'), quiet: true });
const { execFileSync } = require('node:child_process');
const mongo = require('../../src/config/mongoCuentas');

const CONTENEDOR = process.env.MONGO_CONTENEDOR || 'tiendaya-mongo';
const PUERTO = '27018';

// Lo que corre mongosh. Lee todo del entorno (DECLARACION, CONTRASENAS) y termina imprimiendo una línea JSON.
const PROGRAMA = `
const decl = JSON.parse(process.env.DECLARACION);
const clave = JSON.parse(process.env.CONTRASENAS);
const informe = { replicaSet: null, usuarios: {}, roles: {} };

// 1) El replica set: si el volumen es nuevo todavía no está iniciado (con una base ya existente no se toca).
const hello = db.hello();
if (hello.isreplicaset && !hello.setName) {
  rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: 'localhost:${PUERTO}' }] });
  informe.replicaSet = 'iniciado';
  for (let i = 0; i < 40 && !db.hello().isWritablePrimary; i++) sleep(500);
} else {
  informe.replicaSet = 'ya estaba iniciado';
}

// 2) mg_admin: si ya existe se entra con su contraseña; si no, se crea (permitido mientras no haya usuarios o
//    mientras la autenticación esté apagada) y se entra con ella.
const admin = db.getSiblingDB('admin');
let entro = false;
try { admin.auth(decl.admin.usuario, clave.admin); entro = true; } catch (e) { entro = false; }
if (!entro) {
  try {
    admin.createUser({ user: decl.admin.usuario, pwd: clave.admin, roles: decl.admin.roles });
    informe.usuarios[decl.admin.usuario] = 'creado';
  } catch (e) {
    if (/already exists/i.test(e.message)) throw new Error(decl.admin.usuario + ' ya existe pero su contraseña no coincide con MONGO_CONTRASENA_ADMIN de backend/.env');
    // Mongo ya exige autenticación y no se pudo entrar como mg_admin: la contraseña del .env no es la del servidor.
    if (/requires authentication|not authorized/i.test(e.message)) throw new Error('no se pudo entrar como ' + decl.admin.usuario + ': MONGO_CONTRASENA_ADMIN de backend/.env no coincide con la del servidor');
    throw e;
  }
  admin.auth(decl.admin.usuario, clave.admin);
} else {
  informe.usuarios[decl.admin.usuario] = 'ya existía';
}

// 3) Los roles de la aplicación (idempotente: si existe se reemplazan sus privilegios por los declarados).
for (const [nombre, rol] of Object.entries(decl.roles)) {
  const bd = db.getSiblingDB(rol.db);
  try {
    bd.createRole({ role: nombre, privileges: rol.privileges, roles: [] });
    informe.roles[nombre] = 'creado';
  } catch (e) {
    if (!/already exists/i.test(e.message)) throw e;
    bd.updateRole(nombre, { privileges: rol.privileges, roles: [] });
    informe.roles[nombre] = 'actualizado';
  }
}

// 4) Los usuarios de servicio (si existen se actualizan la contraseña y los roles).
for (const [cuenta, u] of Object.entries(decl.usuarios)) {
  if (cuenta === 'admin') continue;
  const bd = db.getSiblingDB(u.db);
  try {
    bd.createUser({ user: u.usuario, pwd: clave[cuenta], roles: u.roles });
    informe.usuarios[u.usuario] = 'creado';
  } catch (e) {
    if (!/already exists/i.test(e.message)) throw e;
    bd.updateUser(u.usuario, { pwd: clave[cuenta], roles: u.roles });
    informe.usuarios[u.usuario] = 'actualizado';
  }
}
print('INFORME ' + JSON.stringify(informe));
`;

function contenedorCorriendo() {
  try {
    return execFileSync('docker', ['inspect', '-f', '{{.State.Running}}', CONTENEDOR], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'true';
  } catch {
    return false;
  }
}

function main() {
  const contrasenas = {};
  for (const cuenta of Object.keys(mongo.USUARIOS)) {
    const valor = process.env[mongo.variableContrasena(cuenta)];
    if (!valor || valor.length < 16) throw new Error(`Falta ${mongo.variableContrasena(cuenta)} en backend/.env: ejecutá \`npm run seguridad:inicializar\` primero`);
    contrasenas[cuenta] = valor;
  }
  if (!contenedorCorriendo()) throw new Error(`El contenedor ${CONTENEDOR} no está corriendo: \`docker compose up -d mongo\` y volvé a intentar`);

  const declaracion = {
    usuarios: mongo.USUARIOS,
    roles: Object.fromEntries(Object.entries(mongo.ROLES).map(([nombre, r]) => [nombre, { db: r.db, privileges: mongo.privilegiosDe(nombre) }])),
    admin: mongo.USUARIOS.admin,
  };
  const salida = execFileSync(
    'docker',
    ['exec', '-i', '-e', 'DECLARACION', '-e', 'CONTRASENAS', CONTENEDOR, 'mongosh', '--port', PUERTO, '--quiet', '--eval', PROGRAMA],
    { encoding: 'utf8', env: { ...process.env, DECLARACION: JSON.stringify(declaracion), CONTRASENAS: JSON.stringify(contrasenas) } }
  );
  const linea = salida.split('\n').find((l) => l.startsWith('INFORME '));
  if (!linea) throw new Error(`mongosh no devolvió el informe:\n${salida}`);
  const informe = JSON.parse(linea.slice('INFORME '.length));
  console.log('MongoDB — roles y usuarios');
  console.log(`  replica set: ${informe.replicaSet}`);
  for (const [rol, estado] of Object.entries(informe.roles)) console.log(`  rol ${rol}: ${estado}`);
  for (const [usuario, estado] of Object.entries(informe.usuarios)) console.log(`  usuario ${usuario}: ${estado}`);
  console.log('\nSi Mongo todavía corre sin autenticación, `docker compose up -d mongo` lo recrea exigiendo usuario y contraseña.');
}

try {
  main();
} catch (err) {
  const detalle = err.stderr ? String(err.stderr).trim().split('\n').slice(-3).join(' · ') : err.message;
  console.error(`No se pudieron crear los usuarios de MongoDB: ${detalle || err.message}`);
  process.exitCode = 1;
}
