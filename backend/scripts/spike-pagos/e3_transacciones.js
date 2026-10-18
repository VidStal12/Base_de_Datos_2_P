// E3 — Transacciones multi-documento en Mongo: rollback, aislamiento, conflictos de
// escritura y la restricción de Mongoose con operaciones en paralelo (el checkout usa
// Promise.all contra Mongo, aunque hoy fuera de cualquier transacción).
const { randomUUID } = require('node:crypto');
const { Decimal128 } = require('mongodb');
const mongoose = require('mongoose');
const { nuevoRegistro, tabla, conConcurrencia, ahoraMs, esperar } = require('./util');

async function ejecutar({ mongo, db, MONGO_DB }, { rapido }) {
  const { checks, chequear } = nuevoRegistro();
  const notas = [];
  const pagos = await db.createCollection('e3_pagos');
  const eventos = await db.createCollection('e3_eventos');
  const stock = await db.createCollection('e3_stock');
  await db.createCollection('e3_contador');
  await esperar(300); // Mongo exige que el catálogo se asiente antes de leer snapshots de estas colecciones
  const opcionesTx = { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' };

  // --- 1. Rollback: pago + evento + descuento de stock; la falla en el último paso lo deshace todo.
  await stock.insertOne({ _id: 'P1', cantidad: 10 });
  const sesion = mongo.startSession();
  let mensaje = null;
  try {
    await sesion.withTransaction(async () => {
      await pagos.insertOne({ intento_id: randomUUID(), monto: Decimal128.fromString('9.99'), estado: 'aprobado' }, { session: sesion });
      await eventos.insertOne({ tipo: 'aprobado' }, { session: sesion });
      await stock.updateOne({ _id: 'P1' }, { $inc: { cantidad: -1 } }, { session: sesion });
      throw new Error('falla simulada antes del commit');
    }, opcionesTx);
  } catch (err) { mensaje = err.message; } finally { await sesion.endSession(); }
  chequear('Una falla dentro de la transacción deshace pago, evento y stock a la vez',
    mensaje === 'falla simulada antes del commit' && (await pagos.countDocuments({})) === 0
      && (await eventos.countDocuments({})) === 0 && (await stock.findOne({ _id: 'P1' })).cantidad === 10);

  // --- 2. Aislamiento: lo no confirmado no se ve desde fuera; tras el commit sí.
  const s2 = mongo.startSession();
  let invisibleAntes; let visibleDespues;
  try {
    s2.startTransaction(opcionesTx);
    await pagos.insertOne({ intento_id: randomUUID(), monto: Decimal128.fromString('5.00'), estado: 'autorizado' }, { session: s2 });
    invisibleAntes = (await pagos.countDocuments({})) === 0;
    await s2.commitTransaction();
    visibleDespues = (await pagos.countDocuments({})) === 1;
  } finally { await s2.endSession(); }
  chequear('Un lector externo no ve el pago antes del commit y sí después', invisibleAntes && visibleDespues);

  // --- 3. Conflicto de escritura sobre un documento caliente: Mongo aborta (no espera como un
  // lock de fila de InnoDB) y withTransaction reintenta toda la transacción.
  const contador = db.collection('e3_contador');
  await contador.insertOne({ _id: 'c', n: 0 });
  const N = rapido ? 20 : 50;
  let intentos = 0;
  const t0 = ahoraMs();
  await conConcurrencia(N, N, async () => {
    const s = mongo.startSession();
    try {
      await s.withTransaction(async () => {
        intentos++;
        await contador.updateOne({ _id: 'c' }, { $inc: { n: 1 } }, { session: s });
      }, opcionesTx);
    } finally { await s.endSession(); }
  });
  const msCaliente = ahoraMs() - t0;
  const final = (await contador.findOne({ _id: 'c' })).n;
  chequear(`${N} transacciones simultáneas sobre un documento: el contador final es exacto (${N})`, final === N, `n=${final}`);
  notas.push(`Documento caliente: ${N} transacciones simultáneas → ${intentos} ejecuciones del callback (${intentos - N} reintentos por WriteConflict), ${msCaliente.toFixed(0)} ms.`);

  // --- 4. Mongoose: varias operaciones en paralelo con la MISMA sesión dentro de una transacción.
  // La documentación de Mongo las desaconseja; se mide cuántas fallan de verdad.
  const uri = new URL(process.env.MONGO_URI);
  uri.pathname = `/${MONGO_DB}`;
  const conexion = await mongoose.createConnection(uri.toString(), { serverSelectionTimeoutMS: 5000 }).asPromise();
  const Modelo = conexion.model('E3Paralelo', new mongoose.Schema({ k: Number }, { collection: 'e3_mongoose' }));
  await Modelo.createCollection();
  await esperar(300);
  const REPETICIONES = rapido ? 10 : 30;
  const PARALELAS = 5;
  let fallaron = 0; let ejemplo = null; let insertados = 0;
  for (let i = 0; i < REPETICIONES; i++) {
    try {
      await conexion.transaction(async (session) => {
        await Promise.all(Array.from({ length: PARALELAS }, (_, k) => Modelo.create([{ k: i * 10 + k }], { session })));
      });
    } catch (err) { fallaron++; ejemplo ||= `${err.name}: ${err.message}`; }
  }
  insertados = await Modelo.countDocuments({});
  const esperados = (REPETICIONES - fallaron) * PARALELAS;
  notas.push(`Mongoose \`connection.transaction()\` con ${PARALELAS} \`create()\` en \`Promise.all\` y la misma sesión: ${fallaron}/${REPETICIONES} transacciones fallaron${ejemplo ? ` (ejemplo: ${ejemplo})` : ''}; documentos persistidos ${insertados} de ${esperados} esperados para las que confirmaron.`);
  // Control: las mismas operaciones en secuencia deben funcionar siempre.
  let fallaronSecuencial = 0;
  for (let i = 0; i < REPETICIONES; i++) {
    try {
      await conexion.transaction(async (session) => {
        for (let k = 0; k < PARALELAS; k++) await Modelo.create([{ k: 1000 + i * 10 + k }], { session });
      });
    } catch { fallaronSecuencial++; }
  }
  chequear('Mongoose: las mismas operaciones en secuencia dentro de la transacción nunca fallan', fallaronSecuencial === 0, `${fallaronSecuencial} fallas`);
  await conexion.close();

  return {
    titulo: 'E3 — Transacciones y aislamiento',
    checks,
    tablas: [{ titulo: 'Documento caliente', md: tabla(
      [{ clave: 'n', titulo: 'Transacciones simultáneas' }, { clave: 'cb', titulo: 'Ejecuciones del callback' }, { clave: 'r', titulo: 'Reintentos' }, { clave: 'ms', titulo: 'Tiempo total (ms)' }],
      [{ n: N, cb: intentos, r: intentos - N, ms: msCaliente.toFixed(0) }]) }],
    notas,
    datos: { N, intentos, msCaliente, mongoose: { REPETICIONES, PARALELAS, fallaron, ejemplo, insertados, esperados, fallaronSecuencial } },
  };
}

module.exports = { ejecutar };
