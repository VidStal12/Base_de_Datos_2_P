// E7 — Flexibilidad de esquema: una pasarela real devuelve cargas distintas según el medio de pago.
// ¿Eso justifica Mongo, o una columna JSON de MySQL 8.4 con índice sobre un campo generado hace lo mismo?
const { randomUUID } = require('node:crypto');
const { Decimal128 } = require('mongodb');
const { nuevoRegistro, tabla } = require('./util');

const TIPOS = ['tarjeta', 'billetera', 'transferencia'];
const pasarelaDe = (i) => {
  const tipo = TIPOS[i % 3];
  if (tipo === 'tarjeta') return { tipo, autorizacion: `AUT-${i}`, avs: 'Y', marca: 'VISA' };
  if (tipo === 'billetera') return { tipo, proveedor: 'wallet-x', token: `tok-${i}` };
  return { tipo, banco: 'BANCO-1', referencia: `REF-${i}` };
};

const recorre = (plan) => JSON.stringify(plan);
async function codigoDeError(fn) {
  try { await fn(); return null; } catch (err) { return err.errno ?? err.code ?? err.name; }
}

async function ejecutar({ db, my, insertarFilas }, { rapido }) {
  const { checks, chequear } = nuevoRegistro();
  const N = rapido ? 600 : 3000;

  // ----- Mongo -----
  await db.createCollection('e7_pagos', { validator: { $jsonSchema: {
    bsonType: 'object', required: ['intento_id', 'monto', 'estado', 'pasarela'],
    properties: {
      intento_id: { bsonType: 'string' }, monto: { bsonType: 'decimal' }, estado: { enum: ['autorizado', 'aprobado', 'anulado'] },
      pasarela: { bsonType: 'object', required: ['tipo'], properties: { tipo: { enum: TIPOS } } },
    } } } });
  const pagos = db.collection('e7_pagos');
  await pagos.createIndex({ 'pasarela.autorizacion': 1 }, { partialFilterExpression: { 'pasarela.autorizacion': { $exists: true } } });
  await pagos.insertMany(Array.from({ length: N }, (_, i) => ({ intento_id: randomUUID(), monto: Decimal128.fromString('10.00'), estado: 'aprobado', pasarela: pasarelaDe(i) })));
  chequear(`Mongo: ${N} pagos con tres formas distintas de "pasarela" conviven en una colección`, (await pagos.countDocuments({})) === N);
  const objetivo = 300 - (300 % 3); // múltiplo de 3 → tipo "tarjeta" → tiene autorización
  const hit = await pagos.findOne({ 'pasarela.autorizacion': `AUT-${objetivo}` });
  chequear('Mongo: se encuentra un pago por un campo que solo existe en una de las formas', hit?.pasarela.tipo === 'tarjeta');
  const planIdx = recorre(await pagos.find({ 'pasarela.autorizacion': `AUT-${objetivo}` }).explain('queryPlanner'));
  chequear('Mongo: esa consulta usa el índice parcial (IXSCAN)', planIdx.includes('IXSCAN') && !planIdx.includes('COLLSCAN'));
  const planSin = recorre(await pagos.find({ 'pasarela.referencia': 'REF-5' }).explain('queryPlanner'));
  chequear('Mongo: un campo del payload SIN índice se resuelve con COLLSCAN (cada campo consultado necesita su índice)', planSin.includes('COLLSCAN'));
  chequear('Mongo: el validador rechaza un pago sin "pasarela" (121)', (await codigoDeError(() => pagos.insertOne({ intento_id: randomUUID(), monto: Decimal128.fromString('1.00'), estado: 'aprobado' }))) === 121);
  chequear('Mongo: el validador rechaza un tipo de pasarela desconocido (121)', (await codigoDeError(() => pagos.insertOne({ intento_id: randomUUID(), monto: Decimal128.fromString('1.00'), estado: 'aprobado', pasarela: { tipo: 'cripto' } }))) === 121);

  // ----- MySQL: JSON + columna generada indexada + CHECK -----
  await my.query(`CREATE TABLE e7_pago (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, intento_id CHAR(36) NOT NULL, monto DECIMAL(10,2) NOT NULL,
    estado VARCHAR(16) NOT NULL, pasarela JSON NOT NULL,
    autorizacion VARCHAR(64) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(pasarela, '$.autorizacion'))) VIRTUAL, KEY e7_aut (autorizacion),
    CONSTRAINT e7_tipo CHECK (JSON_VALID(pasarela) AND JSON_UNQUOTE(JSON_EXTRACT(pasarela, '$.tipo')) IN ('tarjeta','billetera','transferencia'))) ENGINE=InnoDB`);
  await insertarFilas(my, 'e7_pago', ['intento_id', 'monto', 'estado', 'pasarela'],
    Array.from({ length: N }, (_, i) => [randomUUID(), '10.00', 'aprobado', JSON.stringify(pasarelaDe(i))]));
  const [{ n }] = await my.query('SELECT COUNT(*) AS n FROM e7_pago');
  chequear(`MySQL: ${N} pagos con tres formas distintas de "pasarela" conviven en una columna JSON`, Number(n) === N);
  const encontrado = await my.query('SELECT id FROM e7_pago WHERE autorizacion = ?', [`AUT-${objetivo}`]);
  chequear('MySQL: se encuentra un pago por un campo que solo existe en una de las formas', encontrado.length === 1);
  const explicacion = await my.query('EXPLAIN SELECT id FROM e7_pago WHERE autorizacion = ?', [`AUT-${objetivo}`]);
  chequear('MySQL: esa consulta usa el índice sobre la columna generada', explicacion[0].key === 'e7_aut', `key=${explicacion[0].key}, type=${explicacion[0].type}`);
  const sinIdx = await my.query("EXPLAIN SELECT id FROM e7_pago WHERE JSON_UNQUOTE(JSON_EXTRACT(pasarela, '$.referencia')) = 'REF-5'");
  chequear('MySQL: un campo del payload SIN columna generada indexada recorre toda la tabla (type=ALL)', sinIdx[0].type === 'ALL', `type=${sinIdx[0].type}`);
  chequear('MySQL: el CHECK rechaza un tipo de pasarela desconocido (3819)',
    (await codigoDeError(() => my.query('INSERT INTO e7_pago (intento_id, monto, estado, pasarela) VALUES (?, ?, ?, ?)', [randomUUID(), '1.00', 'aprobado', JSON.stringify({ tipo: 'cripto' })]))) === 3819);

  const filas = [
    { c: 'Tres formas de payload en una misma tabla/colección', mongo: 'sí', mysql: 'sí (columna JSON)' },
    { c: 'Consulta por un campo de la parte variable', mongo: 'índice parcial → IXSCAN', mysql: 'columna generada + índice → ref' },
    { c: 'Campo variable sin índice', mongo: 'COLLSCAN', mysql: 'recorrido completo (ALL)' },
    { c: 'Validación de los campos obligatorios', mongo: '$jsonSchema (121)', mysql: 'CHECK constraint (3819)' },
    { c: 'Costo de añadir un campo nuevo consultable', mongo: 'crear índice', mysql: 'ALTER TABLE + columna generada + índice' },
  ];
  return {
    titulo: 'E7 — Flexibilidad del payload de la pasarela',
    checks,
    tablas: [{ titulo: 'Mongo vs MySQL 8.4 con JSON', md: tabla([{ clave: 'c', titulo: 'Capacidad' }, { clave: 'mongo', titulo: 'MongoDB 7.0' }, { clave: 'mysql', titulo: 'MySQL 8.4' }], filas) }],
    notas: [],
    datos: { N },
  };
}

module.exports = { ejecutar };
