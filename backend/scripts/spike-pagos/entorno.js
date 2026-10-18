// Entorno del spike (IA/ADR-005): conexiones y espacios TEMPORALES.
//
// Regla de oro: el spike nunca escribe en `tiendaya` (ni en MySQL ni en Mongo).
//   - Mongo: base `tiendaya_poc_pagos`, en el mismo replica set rs0 del proyecto.
//   - MySQL: esquema `prisma_migrate_shadow_db_poc`. Es el único patrón de nombre
//     sobre el que el usuario de la app tiene ALL (docker/mysql-init/01-grant-shadow-db.sql),
//     así que no hace falta ningún privilegio nuevo.
// Los nombres son constantes y las funciones de borrado los vuelven a validar:
// ningún parámetro externo puede hacer que se borre otra base.
const os = require('node:os');
const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
const { MongoClient } = require('mongodb');
const mariadb = require('mariadb');

const MONGO_DB = 'tiendaya_poc_pagos';
const MYSQL_DB = 'prisma_migrate_shadow_db_poc';
const USUARIOS_SEMILLA = 1000;
const PRODUCTOS_SEMILLA = 2000;

function exigirTemporales() {
  if (!/^tiendaya_poc_[a-z_]+$/.test(MONGO_DB) || !/^prisma_migrate_shadow_db_poc[a-z_]*$/.test(MYSQL_DB)) {
    throw new Error('Nombre de espacio temporal inválido: el spike se niega a continuar');
  }
}

function configMysql(base) {
  const u = new URL(process.env.DATABASE_URL);
  return {
    host: u.hostname, port: Number(u.port || 3306), user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password), database: base, allowPublicKeyRetrieval: true,
    // El driver devuelve DECIMAL como string (decimalAsNumber=false por defecto): justamente
    // lo que se quiere para comparar montos sin pasar por coma flotante.
    timezone: 'Z', insertIdAsNumber: true, bigIntAsNumber: true,
  };
}

// Tablas auxiliares con la misma forma que las reales (DDL tomado de SHOW CREATE TABLE
// sobre `tiendaya`). Las FK se conservan a propósito: son parte del costo real de
// insertar un pedido/pago en el modelo relacional y Mongo no las tiene.
const COLACION = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
const DDL_BASE = [
  `CREATE TABLE usuarios (id_usuario INT NOT NULL PRIMARY KEY) ${COLACION}`,
  `CREATE TABLE producto (id INT NOT NULL PRIMARY KEY) ${COLACION}`,
  `CREATE TABLE direcciones (id INT NOT NULL PRIMARY KEY, id_usuario INT NOT NULL,
     CONSTRAINT dir_usuario_fk FOREIGN KEY (id_usuario) REFERENCES usuarios (id_usuario)) ${COLACION}`,
  `CREATE TABLE metodo_pago (id INT NOT NULL PRIMARY KEY, id_usuario INT NOT NULL,
     titular VARCHAR(191) NOT NULL, token_pasarela VARCHAR(191) NOT NULL, ultimos_4_digitos VARCHAR(4) NOT NULL,
     marca VARCHAR(30) NOT NULL, KEY mp_usuario (id_usuario),
     CONSTRAINT mp_usuario_fk FOREIGN KEY (id_usuario) REFERENCES usuarios (id_usuario)) ${COLACION}`,
];

// inventario/compra/pago de un experimento: prefijo propio para que los
// experimentos no se pisen entre sí (los nombres de FK son únicos por esquema).
function ddlPedidos(p, { outbox = false, fkPago = true } = {}) {
  const fk = (nombre, sql) => (fkPago ? `, CONSTRAINT ${p}_${nombre} ${sql}` : '');
  return [
    `CREATE TABLE ${p}_inventario (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, id_producto INT NOT NULL,
       precio DECIMAL(10,2) NOT NULL, cantidad INT NOT NULL, UNIQUE KEY ${p}_inv_prod (id_producto),
       CONSTRAINT ${p}_inv_fk FOREIGN KEY (id_producto) REFERENCES producto (id)) ${COLACION}`,
    `CREATE TABLE ${p}_compra (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, id_usuario INT NOT NULL,
       id_direccion INT NOT NULL, total DECIMAL(10,2) NOT NULL, fecha DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
       KEY ${p}_c_usuario (id_usuario), KEY ${p}_c_dir (id_direccion),
       CONSTRAINT ${p}_c_dir_fk FOREIGN KEY (id_direccion) REFERENCES direcciones (id),
       CONSTRAINT ${p}_c_usu_fk FOREIGN KEY (id_usuario) REFERENCES usuarios (id_usuario)) ${COLACION}`,
    `CREATE TABLE ${p}_pago (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, id_compra INT NOT NULL,
       id_metodo_pago INT NOT NULL, monto DECIMAL(10,2) NOT NULL, estado VARCHAR(191) NOT NULL,
       fecha_pago DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), referencia_transaccion VARCHAR(191) NULL,
       KEY ${p}_p_compra (id_compra), KEY ${p}_p_mp (id_metodo_pago)
       ${fk('p_compra_fk', `FOREIGN KEY (id_compra) REFERENCES ${p}_compra (id)`)}
       ${fk('p_mp_fk', 'FOREIGN KEY (id_metodo_pago) REFERENCES metodo_pago (id)')}) ${COLACION}`,
    ...(outbox ? [`CREATE TABLE ${p}_pago_outbox (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, id_compra INT NOT NULL,
       payload JSON NOT NULL, procesado_en DATETIME(3) NULL, intentos INT NOT NULL DEFAULT 0,
       KEY ${p}_ob_pend (procesado_en, id)) ${COLACION}`] : []),
  ];
}

async function insertarFilas(pool, tabla, columnas, filas, lote = 1000) {
  for (let i = 0; i < filas.length; i += lote) {
    const parte = filas.slice(i, i + lote);
    const marcas = parte.map(() => `(${columnas.map(() => '?').join(',')})`).join(',');
    await pool.query(`INSERT INTO ${tabla} (${columnas.join(',')}) VALUES ${marcas}`, parte.flat());
  }
}

async function prepararMysql(pool) {
  for (const ddl of DDL_BASE) await pool.query(ddl);
  const ids = Array.from({ length: USUARIOS_SEMILLA }, (_, i) => i + 1);
  await insertarFilas(pool, 'usuarios', ['id_usuario'], ids.map((i) => [i]));
  await insertarFilas(pool, 'direcciones', ['id', 'id_usuario'], ids.map((i) => [i, i]));
  await insertarFilas(pool, 'metodo_pago', ['id', 'id_usuario', 'titular', 'token_pasarela', 'ultimos_4_digitos', 'marca'],
    ids.map((i) => [i, i, `Titular ${i}`, `tok_sintetico_${i}`, String(1000 + (i % 9000)).slice(0, 4), 'VISA']));
  await insertarFilas(pool, 'producto', ['id'], Array.from({ length: PRODUCTOS_SEMILLA }, (_, i) => [i + 1]));
}

async function abrir() {
  exigirTemporales();
  const raiz = await mariadb.createConnection({ ...configMysql(undefined) });
  await raiz.query(`DROP DATABASE IF EXISTS \`${MYSQL_DB}\``);
  await raiz.query(`CREATE DATABASE \`${MYSQL_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await raiz.end();

  const my = mariadb.createPool({ ...configMysql(MYSQL_DB), connectionLimit: 110, acquireTimeout: 30000 });
  await prepararMysql(my);

  const mongo = new MongoClient(process.env.MONGO_URI, { maxPoolSize: 120, serverSelectionTimeoutMS: 5000 });
  await mongo.connect();
  await mongo.db(MONGO_DB).dropDatabase();
  const db = mongo.db(MONGO_DB);

  // Fuente real, SOLO LECTURA, para el experimento de migración (ETL). Sesión
  // marcada READ ONLY: aunque el código tuviera un error, el servidor rechazaría un INSERT.
  const origen = mariadb.createPool({
    ...configMysql(new URL(process.env.DATABASE_URL).pathname.slice(1)),
    connectionLimit: 2, initSql: 'SET SESSION TRANSACTION READ ONLY',
  });

  return { mongo, db, my, origen, MONGO_DB, MYSQL_DB, ddlPedidos, insertarFilas, configMysql, USUARIOS_SEMILLA, PRODUCTOS_SEMILLA };
}

async function hechos(ctx) {
  const admin = ctx.mongo.db('admin');
  const info = await admin.command({ buildInfo: 1 });
  const conf = (await admin.command({ replSetGetConfig: 1 })).config;
  const [m] = await ctx.my.query(`SELECT VERSION() AS version, @@innodb_flush_log_at_trx_commit AS flush,
    @@sync_binlog AS sync_binlog, @@transaction_isolation AS aislamiento, @@innodb_buffer_pool_size / 1048576 AS buffer_mb`);
  const cpu = os.cpus();
  return {
    fecha: new Date().toISOString(),
    mongod: info.version, miembros_rs: conf.members.length,
    journal_en_majority: conf.writeConcernMajorityJournalDefault,
    mysql: m.version, innodb_flush_log_at_trx_commit: Number(m.flush), sync_binlog: Number(m.sync_binlog),
    aislamiento_mysql: m.aislamiento, buffer_pool_mb: Number(m.buffer_mb),
    driver_mongodb: require('mongodb/package.json').version, driver_mariadb: require('mariadb/package.json').version,
    node: process.version, so: `${os.type()} ${os.release()}`, cpu: `${cpu[0].model.trim()} x${cpu.length}`,
    ram_gb: Math.round(os.totalmem() / 2 ** 30),
  };
}

// Borra únicamente los espacios temporales y cierra todo. Idempotente.
async function cerrar(ctx, { conservar = false } = {}) {
  if (!ctx) return;
  exigirTemporales();
  try {
    if (!conservar) {
      await ctx.mongo.db(MONGO_DB).dropDatabase();
      await ctx.my.query(`DROP DATABASE IF EXISTS \`${MYSQL_DB}\``);
    }
  } finally {
    await Promise.allSettled([ctx.mongo.close(), ctx.my.end(), ctx.origen.end()]);
  }
}

module.exports = { abrir, hechos, cerrar, ddlPedidos, insertarFilas, MONGO_DB, USUARIOS_SEMILLA, PRODUCTOS_SEMILLA };
