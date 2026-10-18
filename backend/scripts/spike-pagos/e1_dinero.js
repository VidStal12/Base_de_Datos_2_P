// E1 — Dinero: ¿se puede representar un monto en Mongo sin perder exactitud?
// Contrasta Decimal128 (con validador de esquema) contra double y contra DECIMAL(10,2) de MySQL.
const { Decimal128 } = require('mongodb');
const { nuevoRegistro, tabla } = require('./util');

const centavosADecimal = (c) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
const dif = (valor, exacto) => {
  const d = Number(valor) - Number(exacto);
  return d === 0 ? '0' : d.toExponential(2);
};

async function codigoDeError(fn) {
  try { await fn(); return null; } catch (err) { return err.errno ?? err.code ?? err.name; }
}

async function ejecutar({ db, my, insertarFilas }, { rapido }) {
  const { checks, chequear } = nuevoRegistro();
  const notas = [];
  const N = rapido ? 10000 : 100000;

  // El esquema es la defensa: sin él, un `19.99` (double) entra igual de fácil que un Decimal128.
  // El segundo término ($round) impone escala ≤ 2, equivalente al DECIMAL(10,2) relacional.
  const validador = { $and: [
    { $jsonSchema: { bsonType: 'object', required: ['monto', 'estado'], properties: {
      monto: { bsonType: 'decimal' }, estado: { enum: ['autorizado', 'aprobado', 'anulado'] } } } },
    { $expr: { $eq: [{ $round: ['$monto', 2] }, '$monto'] } },
  ] };
  await db.createCollection('e1_pagos', { validator: validador, validationAction: 'error' });
  const pagos = db.collection('e1_pagos');

  await pagos.insertOne({ monto: Decimal128.fromString('19.99'), estado: 'aprobado' });
  const leido = await pagos.findOne({ estado: 'aprobado' });
  chequear('Decimal128 devuelve 19.99 exacto tras guardar y leer', leido.monto.toString() === '19.99', leido.monto.toString());
  chequear('Validador rechaza un monto double (19.99 como Number) — código 121',
    (await codigoDeError(() => pagos.insertOne({ monto: 19.99, estado: 'aprobado' }))) === 121);
  chequear('Validador rechaza un monto string ("19.99") — código 121',
    (await codigoDeError(() => pagos.insertOne({ monto: '19.99', estado: 'aprobado' }))) === 121);
  chequear('Validador rechaza escala 3 (12.345) — código 121',
    (await codigoDeError(() => pagos.insertOne({ monto: Decimal128.fromString('12.345'), estado: 'aprobado' }))) === 121);
  chequear('Validador acepta 12.34',
    (await codigoDeError(() => pagos.insertOne({ monto: Decimal128.fromString('12.34'), estado: 'aprobado' }))) === null);
  chequear('Validador rechaza un estado fuera del enum — código 121',
    (await codigoDeError(() => pagos.insertOne({ monto: Decimal128.fromString('1.00'), estado: 'inventado' }))) === 121);

  // Alternativa declarativa: ¿multipleOf sirve para imponer la escala? Se informa, no se afirma.
  try {
    await db.createCollection('e1_multipleof', { validator: { $jsonSchema: { bsonType: 'object',
      properties: { monto: { bsonType: 'decimal', multipleOf: 0.01 } } } } });
    const c = db.collection('e1_multipleof');
    const bien = await codigoDeError(() => c.insertOne({ monto: Decimal128.fromString('12.34') }));
    const mal = await codigoDeError(() => c.insertOne({ monto: Decimal128.fromString('12.345') }));
    notas.push(`\`multipleOf: 0.01\` sobre un Decimal128: 12.34 → ${bien === null ? 'aceptado' : `error ${bien}`}; 12.345 → ${mal === null ? 'aceptado' : `error ${mal}`}.`);
  } catch (err) {
    notas.push(`\`multipleOf: 0.01\` sobre un Decimal128 no pudo crearse: ${err.message}`);
  }

  // Suma de N montos con fracciones de centavo "incómodas" (cada importe 0.01 … 99.99).
  const centavos = Array.from({ length: N }, (_, i) => ((i * 37) % 9999) + 1);
  const exacto = centavosADecimal(centavos.reduce((a, c) => a + c, 0));
  const lotes = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, (i + 1) * n));
  for (const lote of lotes(centavos, 10000)) {
    await db.collection('e1_dec').insertMany(lote.map((c) => ({ monto: Decimal128.fromString(centavosADecimal(c)) })));
    await db.collection('e1_dbl').insertMany(lote.map((c) => ({ monto: c / 100 })));
  }
  await my.query('CREATE TABLE e1_monto (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, monto DECIMAL(10,2) NOT NULL) ENGINE=InnoDB');
  await insertarFilas(my, 'e1_monto', ['monto'], centavos.map((c) => [centavosADecimal(c)]));

  const sumaJs = centavos.reduce((a, c) => a + c / 100, 0);
  const sumaMongoDbl = (await db.collection('e1_dbl').aggregate([{ $group: { _id: null, t: { $sum: '$monto' } } }]).next()).t;
  const sumaMongoDec = (await db.collection('e1_dec').aggregate([{ $group: { _id: null, t: { $sum: '$monto' } } }]).next()).t.toString();
  const [{ t: sumaMysql }] = await my.query('SELECT SUM(monto) AS t FROM e1_monto');

  chequear(`Σ ${N} montos en Decimal128 ($sum) es exacta`, sumaMongoDec === exacto, `${sumaMongoDec} vs ${exacto}`);
  chequear(`Σ ${N} montos en DECIMAL(10,2) de MySQL es exacta`, String(sumaMysql) === exacto, `${sumaMysql} vs ${exacto}`);

  const filas = [
    { rep: 'Enteros en centavos (referencia exacta)', suma: exacto, dif: '0' },
    { rep: 'JavaScript Number acumulado', suma: String(sumaJs), dif: dif(sumaJs, exacto) },
    { rep: 'Mongo `$sum` sobre double', suma: String(sumaMongoDbl), dif: dif(sumaMongoDbl, exacto) },
    { rep: 'Mongo `$sum` sobre Decimal128', suma: sumaMongoDec, dif: dif(sumaMongoDec, exacto) },
    { rep: 'MySQL `SUM(DECIMAL(10,2))`', suma: String(sumaMysql), dif: dif(sumaMysql, exacto) },
  ];

  // Qué hace MySQL con una escala de más y con un valor fuera de rango (comportamiento real, no supuesto).
  await my.query('CREATE TABLE e1_escala (monto DECIMAL(10,2) NOT NULL) ENGINE=InnoDB');
  const cx = await my.getConnection();
  try {
    await cx.query('INSERT INTO e1_escala VALUES (12.345)');
    const aviso = await cx.query('SHOW WARNINGS');
    const [{ monto }] = await cx.query('SELECT monto FROM e1_escala');
    notas.push(`MySQL con 12.345 en DECIMAL(10,2): guarda ${monto}${aviso.length ? ` y emite ${aviso[0].Level} ${aviso[0].Code} ("${aviso[0].Message}")` : ' sin aviso'} — redondea, no rechaza.`);
    const cod = await codigoDeError(() => cx.query('INSERT INTO e1_escala VALUES (123456789012.34)'));
    notas.push(`MySQL con 123456789012.34 (fuera de rango): error ${cod}.`);
  } finally { cx.release(); }

  // El contrato HTTP hoy devuelve el monto como string ("19.99", Prisma.Decimal); Mongo sin mapeo daría otra cosa.
  notas.push(`\`JSON.stringify({ monto: Decimal128("19.99") })\` → \`${JSON.stringify({ monto: Decimal128.fromString('19.99') })}\`: la API necesitaría un mapeo explícito a string.`);
  try {
    const { Prisma } = require('@prisma/client');
    notas.push(`\`JSON.stringify({ monto: new Prisma.Decimal("19.99") })\` → \`${JSON.stringify({ monto: new Prisma.Decimal('19.99') })}\` (lo que devuelve hoy la API).`);
  } catch { /* cliente Prisma sin generar: no es relevante para el spike */ }

  return {
    titulo: 'E1 — Representación del dinero',
    checks,
    tablas: [{ titulo: `Σ de ${N.toLocaleString('es')} montos`, md: tabla(
      [{ clave: 'rep', titulo: 'Representación' }, { clave: 'suma', titulo: 'Suma' }, { clave: 'dif', titulo: 'Diferencia vs exacto' }], filas) }],
    notas,
    datos: { N, exacto, sumaJs, sumaMongoDbl, sumaMongoDec, sumaMysql: String(sumaMysql) },
  };
}

module.exports = { ejecutar };
