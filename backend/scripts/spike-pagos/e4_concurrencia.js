// E4 — Concurrencia sobre el stock: oferta flash (misma forma que flash-sale-tests/scenarios/combined.json:
// compradores simultáneos sobre pocas unidades) y orden de bloqueo entre dos productos.
// Pregunta: ¿qué cambia en la corrección y en el comportamiento bajo contención si la
// escritura del pago viaja a Mongo?
const { createHistogram } = require('node:perf_hooks');
const { randomUUID } = require('node:crypto');
const { Decimal128 } = require('mongodb');
const { nuevoRegistro, tabla, conConcurrencia, ahoraMs, esperar, f } = require('./util');

const opcionesTx = { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' };
const PRECIO = '44.99';

async function ejecutar(ctx, { rapido }) {
  const { checks, chequear } = nuevoRegistro();
  const notas = [];
  const { my, mongo, db, ddlPedidos, USUARIOS_SEMILLA } = ctx;
  for (const ddl of ddlPedidos('e4')) await my.query(ddl);
  const stock = await db.createCollection('e4_stock');
  const compras = await db.createCollection('e4_compras');
  const pagos = await db.createCollection('e4_pagos');
  await pagos.createIndex({ compra_id: 1 });
  await esperar(300);
  const usuarioDe = (i) => 1 + (i % USUARIOS_SEMILLA);

  async function reiniciar(unidades) {
    await my.query('DELETE FROM e4_pago');
    await my.query('DELETE FROM e4_compra');
    await my.query('DELETE FROM e4_inventario');
    await my.query('INSERT INTO e4_inventario (id_producto, precio, cantidad) VALUES (1, ?, ?)', [PRECIO, unidades]);
    await Promise.all([compras.deleteMany({}), pagos.deleteMany({}), stock.deleteMany({})]);
    await stock.insertOne({ _id: 1, cantidad: unidades });
  }

  // --- Variante 1: lo que hace hoy el checkout (UPDATE condicional + compra + pago en UNA transacción MySQL).
  async function compraMysql(i) {
    const u = usuarioDe(i);
    const cx = await my.getConnection();
    try {
      await cx.beginTransaction();
      const r = await cx.query('UPDATE e4_inventario SET cantidad = cantidad - 1 WHERE id_producto = 1 AND cantidad >= 1');
      if (r.affectedRows !== 1) { await cx.rollback(); return 'agotado'; }
      const c = await cx.query('INSERT INTO e4_compra (id_usuario, id_direccion, total) VALUES (?, ?, ?)', [u, u, PRECIO]);
      await cx.query('INSERT INTO e4_pago (id_compra, id_metodo_pago, monto, estado, referencia_transaccion) VALUES (?, ?, ?, ?, ?)',
        [c.insertId, u, PRECIO, 'aprobado', `TX-${c.insertId}`]);
      await cx.commit();
      return 'comprado';
    } catch (err) {
      try { await cx.rollback(); } catch { /* conexión ya caída */ }
      throw err;
    } finally { cx.release(); }
  }

  // --- Variante 2: Mongo sin transacción. El descuento es atómico por documento (no sobrevende),
  // pero descuento, compra y pago son tres escrituras independientes: una falla entre ellas
  // deja stock descontado sin pedido. Es el hueco que la saga tiene que cerrar.
  async function compraMongoAtomica(i) {
    const u = usuarioDe(i);
    const r = await stock.findOneAndUpdate({ _id: 1, cantidad: { $gte: 1 } }, { $inc: { cantidad: -1 } });
    if (!r) return 'agotado';
    const c = await compras.insertOne({ usuario_id: u, total: Decimal128.fromString(PRECIO) });
    await pagos.insertOne({ compra_id: c.insertedId, intento_id: randomUUID(), monto: Decimal128.fromString(PRECIO), estado: 'aprobado' });
    return 'comprado';
  }

  // --- Variante 3: Mongo con transacción multi-documento (todo o nada), reintentando conflictos.
  let ejecucionesTx = 0;
  async function compraMongoTx(i) {
    const u = usuarioDe(i);
    const s = mongo.startSession();
    let resultado;
    try {
      await s.withTransaction(async () => {
        ejecucionesTx++;
        resultado = 'agotado';
        const r = await stock.findOneAndUpdate({ _id: 1, cantidad: { $gte: 1 } }, { $inc: { cantidad: -1 } }, { session: s });
        if (!r) return;
        const c = await compras.insertOne({ usuario_id: u, total: Decimal128.fromString(PRECIO) }, { session: s });
        await pagos.insertOne({ compra_id: c.insertedId, intento_id: randomUUID(), monto: Decimal128.fromString(PRECIO), estado: 'aprobado' }, { session: s });
        resultado = 'comprado';
      }, opcionesTx);
    } finally { await s.endSession(); }
    return resultado;
  }

  const variantes = [
    { id: 'MySQL (actual): UPDATE condicional + compra + pago en 1 tx', corto: 'MySQL (actual)', fn: compraMysql,
      leer: async () => ({ stock: (await my.query('SELECT cantidad FROM e4_inventario WHERE id_producto = 1'))[0].cantidad, pagos: Number((await my.query('SELECT COUNT(*) AS n FROM e4_pago'))[0].n) }) },
    { id: 'Mongo sin transacción (descuento atómico + 2 inserts)', corto: 'Mongo sin transacción', fn: compraMongoAtomica,
      leer: async () => ({ stock: (await stock.findOne({ _id: 1 })).cantidad, pagos: await pagos.countDocuments({}) }) },
    { id: 'Mongo con transacción multi-documento', corto: 'Mongo con transacción', fn: compraMongoTx,
      leer: async () => ({ stock: (await stock.findOne({ _id: 1 })).cantidad, pagos: await pagos.countDocuments({}) }) },
  ];

  const escenarios = rapido ? [[40, 12]] : [[100, 30], [400, 30]];
  const filas = [];
  for (const [compradores, unidades] of escenarios) {
    for (const v of variantes) {
      await reiniciar(unidades);
      ejecucionesTx = 0;
      const h = createHistogram();
      let comprados = 0; let agotados = 0; let errores = 0; let primerError = null;
      const t0 = ahoraMs();
      await conConcurrencia(compradores, compradores, async (i) => {
        const a = ahoraMs();
        try {
          const r = await v.fn(i);
          if (r === 'comprado') comprados++; else agotados++;
          h.record(Math.max(1, Math.round((ahoraMs() - a) * 1000)));
        } catch (err) { errores++; primerError ||= err.message; }
      });
      const ms = ahoraMs() - t0;
      const est = await v.leer();
      const sobreventa = Math.max(0, comprados - unidades);
      const etiqueta = `${v.id} — ${compradores} compradores / ${unidades} unidades`;
      chequear(`${etiqueta}: exactamente ${unidades} compras`, comprados === unidades && agotados === compradores - unidades && errores === 0,
        `${comprados} compradas, ${agotados} agotadas, ${errores} errores${primerError ? ` (${primerError})` : ''}`);
      chequear(`${etiqueta}: stock final 0, ${unidades} pagos, sin sobreventa`, Number(est.stock) === 0 && est.pagos === unidades && sobreventa === 0,
        `stock ${est.stock}, pagos ${est.pagos}`);
      filas.push({
        v: v.corto, esc: `${compradores}/${unidades}`,
        ok: `${comprados}/${agotados}/${errores}`, stock: est.stock, pagos: est.pagos,
        reint: v.fn === compraMongoTx ? ejecucionesTx - compradores : '—',
        ms: ms.toFixed(0), p50: f(h.percentile(50) / 1000, 1), p95: f(h.percentile(95) / 1000, 1), p99: f(h.percentile(99) / 1000, 1),
      });
    }
  }

  // ---------- Orden de bloqueo: dos productos tocados en orden opuesto por transacciones distintas ----------
  // La pausa de 15 ms AMPLÍA la ventana para que el fallo sea observable siempre; la fila "sin pausa"
  // muestra la frecuencia con la ventana real (la latencia entre dos sentencias).
  const dl = db.collection('e4_dl');
  const filasDl = [];
  const reiniciarDl = async () => {
    await my.query('DELETE FROM e4_inventario');
    await my.query('INSERT INTO e4_inventario (id_producto, precio, cantidad) VALUES (2, ?, 1000000), (3, ?, 1000000)', [PRECIO, PRECIO]);
    await dl.deleteMany({});
    await dl.insertMany([{ _id: 2, cantidad: 1000000 }, { _id: 3, cantidad: 1000000 }]);
  };
  async function txDosProductos(orden, pausaMs, reintentarDeadlock) {
    let reintentos = 0;
    for (let intento = 0; ; intento++) {
      const cx = await my.getConnection();
      try {
        await cx.beginTransaction();
        for (let k = 0; k < orden.length; k++) {
          await cx.query('UPDATE e4_inventario SET cantidad = cantidad - 1 WHERE id_producto = ? AND cantidad >= 1', [orden[k]]);
          if (k === 0 && pausaMs) await esperar(pausaMs);
        }
        await cx.commit();
        return { reintentos };
      } catch (err) {
        try { await cx.rollback(); } catch { /* ya revertida por el servidor */ }
        if (err.errno === 1213 && reintentarDeadlock && intento < 8) { reintentos++; continue; }
        throw err;
      } finally { cx.release(); }
    }
  }
  async function correrDl(nombre, { n, pausaMs, canonico, reintentarDeadlock }) {
    await reiniciarDl();
    let ok = 0; let deadlocks = 0; let otros = 0; let reintentos = 0;
    const t0 = ahoraMs();
    await conConcurrencia(n, n, async (i) => {
      const orden = canonico ? [2, 3] : (i % 2 ? [2, 3] : [3, 2]);
      try { const r = await txDosProductos(orden, pausaMs, reintentarDeadlock); ok++; reintentos += r.reintentos; }
      catch (err) { if (err.errno === 1213) deadlocks++; else otros++; }
    });
    const [a, b] = await my.query('SELECT cantidad FROM e4_inventario ORDER BY id_producto');
    const descontado = (1000000 - a.cantidad);
    filasDl.push({ caso: nombre, n, ok, deadlocks, reint: reintentos, otros, ms: (ahoraMs() - t0).toFixed(0) });
    return { ok, deadlocks, otros, reintentos, descontado, coherente: a.cantidad === b.cantidad && descontado === ok };
  }
  const N = rapido ? 30 : 60;
  const sinRetry = await correrDl('MySQL, orden opuesto, pausa 15 ms, sin reintento', { n: N, pausaMs: 15 });
  chequear('MySQL: con orden opuesto de bloqueo aparecen deadlocks reales (error 1213) si no se reintenta', sinRetry.deadlocks > 0, `${sinRetry.deadlocks} de ${N}`);
  chequear('MySQL: cada deadlock deja la transacción totalmente revertida (descuento == transacciones exitosas)', sinRetry.coherente);
  const conRetry = await correrDl('MySQL, orden opuesto, pausa 15 ms, con reintento en 1213', { n: N, pausaMs: 15, reintentarDeadlock: true });
  chequear('MySQL: reintentando la transacción completa en 1213, todas terminan', conRetry.ok === N && conRetry.otros === 0, `${conRetry.ok}/${N}, ${conRetry.reintentos} reintentos`);
  const ordenado = await correrDl('MySQL, orden canónico (id ascendente), pausa 15 ms', { n: N, pausaMs: 15, canonico: true });
  chequear('MySQL: con orden canónico no hay deadlocks y todas terminan', ordenado.ok === N && ordenado.deadlocks === 0);
  const real = await correrDl('MySQL, orden opuesto, SIN pausa (ventana real)', { n: rapido ? 100 : 300, pausaMs: 0 });
  notas.push(`Ventana real (sin pausa artificial), orden opuesto: ${real.deadlocks} deadlocks en ${rapido ? 100 : 300} transacciones simultáneas.`);

  // Mongo: mismo patrón con transacciones; Mongo aborta por WriteConflict y withTransaction reintenta.
  await reiniciarDl();
  let ejecucionesDl = 0; let okMongo = 0; let falloMongo = 0;
  const t1 = ahoraMs();
  await conConcurrencia(N, N, async (i) => {
    const orden = i % 2 ? [2, 3] : [3, 2];
    const s = mongo.startSession();
    try {
      await s.withTransaction(async () => {
        ejecucionesDl++;
        await dl.updateOne({ _id: orden[0] }, { $inc: { cantidad: -1 } }, { session: s });
        await esperar(15);
        await dl.updateOne({ _id: orden[1] }, { $inc: { cantidad: -1 } }, { session: s });
      }, opcionesTx);
      okMongo++;
    } catch { falloMongo++; } finally { await s.endSession(); }
  });
  const dlA = await dl.findOne({ _id: 2 });
  chequear('Mongo: orden opuesto en transacciones — todas terminan y el descuento es exacto', okMongo === N && falloMongo === 0 && 1000000 - dlA.cantidad === N, `${okMongo}/${N}`);
  filasDl.push({ caso: 'Mongo, orden opuesto, pausa 15 ms, withTransaction', n: N, ok: okMongo, deadlocks: 0, reint: ejecucionesDl - N, otros: falloMongo, ms: (ahoraMs() - t1).toFixed(0) });

  return {
    titulo: 'E4 — Concurrencia sobre el stock',
    checks,
    tablas: [
      { titulo: 'Oferta flash: compradores simultáneos sobre pocas unidades', md: tabla(
        [{ clave: 'v', titulo: 'Variante' }, { clave: 'esc', titulo: 'Compradores/unidades' }, { clave: 'ok', titulo: 'Compradas/agotadas/errores' },
          { clave: 'stock', titulo: 'Stock final' }, { clave: 'pagos', titulo: 'Pagos' }, { clave: 'reint', titulo: 'Reintentos de tx' },
          { clave: 'ms', titulo: 'Tiempo total (ms)' }, { clave: 'p50', titulo: 'p50 (ms)' }, { clave: 'p95', titulo: 'p95 (ms)' }, { clave: 'p99', titulo: 'p99 (ms)' }], filas) },
      { titulo: 'Orden de bloqueo entre dos productos', md: tabla(
        [{ clave: 'caso', titulo: 'Caso' }, { clave: 'n', titulo: 'Tx' }, { clave: 'ok', titulo: 'Terminaron' }, { clave: 'deadlocks', titulo: 'Deadlocks (1213)' },
          { clave: 'reint', titulo: 'Reintentos' }, { clave: 'otros', titulo: 'Otros errores' }, { clave: 'ms', titulo: 'Tiempo (ms)' }], filasDl) },
    ],
    notas,
    datos: { flash: filas, bloqueo: filasDl },
  };
}

module.exports = { ejecutar };
