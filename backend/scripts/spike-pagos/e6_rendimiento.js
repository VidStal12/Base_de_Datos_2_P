// E6 — Rendimiento: ¿cuánto cuesta (en latencia y rendimiento) cada arquitectura de pago?
//
// Diseño del benchmark (para que la comparación sea defendible):
//   - Durabilidad equivalente: MySQL con sus valores por defecto (fsync por COMMIT) frente a Mongo con
//     w:majority, que en un replica set de un nodo con journaling equivale a esperar el journal. `w:1` sin
//     journal se incluye solo como referencia de "rápido pero no durable".
//   - Calentamiento descartado y repeticiones INTERCALADAS (ronda 1 de todas las cargas, luego ronda 2, …):
//     una deriva del equipo se reparte entre todas las cargas en vez de castigar a la última.
//   - Se informa la mediana y el rango (mín–máx) de las repeticiones, no un solo número.
//   - Productos repartidos en 2000 filas: aquí NO se mide contención (eso es E4), solo el costo base.
//   - Mismo hardware, mismo cliente Node, mismo disco: sirve para comparar entre filas, no como cifra absoluta.
const { randomUUID } = require('node:crypto');
const { Decimal128 } = require('mongodb');
const { nuevoRegistro, tabla, medir, mediana, f, esperar } = require('./util');

const opcionesTx = { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' };

async function ejecutar(ctx, { rapido }) {
  const { checks, chequear } = nuevoRegistro();
  const notas = [];
  const { my, mongo, db, ddlPedidos, insertarFilas, USUARIOS_SEMILLA, PRODUCTOS_SEMILLA } = ctx;

  // ---------- esquemas ----------
  for (const ddl of ddlPedidos('e6', { outbox: true })) await my.query(ddl);
  await my.query(`CREATE TABLE e6_pago_plano (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, id_compra INT NOT NULL, id_metodo_pago INT NOT NULL,
    monto DECIMAL(10,2) NOT NULL, estado VARCHAR(191) NOT NULL, fecha_pago DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    referencia_transaccion VARCHAR(191) NULL, KEY e6_pp_compra (id_compra), KEY e6_pp_mp (id_metodo_pago)) ENGINE=InnoDB`);
  await my.query('CREATE TABLE e6_intento (id CHAR(36) NOT NULL PRIMARY KEY, estado VARCHAR(16) NOT NULL) ENGINE=InnoDB');
  const productos = Array.from({ length: PRODUCTOS_SEMILLA }, (_, i) => i + 1);
  await insertarFilas(my, 'e6_inventario', ['id_producto', 'precio', 'cantidad'], productos.map((p) => [p, '44.99', 1000000000]));

  const nombres = ['e6_stock', 'e6_compras', 'e6_pagos', 'e6_eventos'];
  for (const n of nombres) await db.createCollection(n);
  await db.collection('e6_stock').insertMany(productos.map((p) => ({ _id: p, cantidad: 1000000000 })));
  // Mismos índices que el modelo objetivo: único por intento, único parcial por compra aprobada, por usuario.
  const indicesPagos = async (c) => {
    await c.createIndex({ intento_id: 1 }, { unique: true });
    await c.createIndex({ compra_id: 1 }, { unique: true, partialFilterExpression: { estado: 'aprobado' } });
    await c.createIndex({ usuario_id: 1, compra_id: -1 });
  };
  await indicesPagos(db.collection('e6_pagos'));
  await esperar(500);
  const stock = db.collection('e6_stock');
  const compras = db.collection('e6_compras');
  const eventos = db.collection('e6_eventos');
  const pagos = db.collection('e6_pagos');
  const pagosW1 = db.collection('e6_pagos', { writeConcern: { w: 1 } });
  const pagosW1J = db.collection('e6_pagos', { writeConcern: { w: 1, j: true } });
  const pagosMaj = db.collection('e6_pagos', { writeConcern: { w: 'majority' } });

  let seq = 1; // clave única creciente: ninguna repetición reutiliza una compra o intento
  const prod = (n) => 1 + ((n * 7919) % PRODUCTOS_SEMILLA);
  const usu = (n) => 1 + (n % USUARIOS_SEMILLA);
  const docPago = (n, extra = {}) => ({
    intento_id: randomUUID(), usuario_id: usu(n), compra_id: n, monto: Decimal128.fromString('44.99'), estado: 'aprobado',
    metodo_pago: { id: usu(n), marca: 'VISA', ultimos_4: '4242' }, creado_en: new Date(), ...extra,
  });

  async function enMysql(fn) {
    const cx = await my.getConnection();
    try { await cx.beginTransaction(); await fn(cx); await cx.commit(); }
    catch (err) { try { await cx.rollback(); } catch { /* sin transacción abierta */ } throw err; }
    finally { cx.release(); }
  }
  const pedidoMysql = async (cx, n) => {
    const u = usu(n);
    await cx.query('UPDATE e6_inventario SET cantidad = cantidad - 1 WHERE id_producto = ? AND cantidad >= 1', [prod(n)]);
    return (await cx.query('INSERT INTO e6_compra (id_usuario, id_direccion, total) VALUES (?, ?, ?)', [u, u, '44.99'])).insertId;
  };

  const cargas = [
    { id: 'A', grupo: 'Pago aislado', nombre: 'MySQL: INSERT de un pago (autocommit)', detalle: 'Una fila en una tabla con la forma de `pago`, sin FK, con fsync por COMMIT.', escribe: '1 fila, 1 commit',
      op: () => { const n = seq++; return my.query('INSERT INTO e6_pago_plano (id_compra, id_metodo_pago, monto, estado, referencia_transaccion) VALUES (?, ?, ?, ?, ?)', [n, usu(n), '44.99', 'aprobado', `TX-${n}`]); } },
    { id: 'B', grupo: 'Pago aislado', nombre: 'Mongo: insertOne con w:1', detalle: 'Un documento de pago; se confirma en memoria sin esperar el journal (puede perderse ante una caída).', escribe: '1 doc',
      op: () => pagosW1.insertOne(docPago(seq++)) },
    { id: 'C', grupo: 'Pago aislado', nombre: 'Mongo: insertOne con w:1, j:true', detalle: 'Un documento de pago; se confirma tras escribir el journal en disco.', escribe: '1 doc, 1 commit',
      op: () => pagosW1J.insertOne(docPago(seq++)) },
    { id: 'D', grupo: 'Pago aislado', nombre: 'Mongo: insertOne con w:majority', detalle: 'Un documento de pago; w:majority en un replica set de un nodo equivale a esperar el journal (writeConcernMajorityJournalDefault=true).', escribe: '1 doc, 1 commit',
      op: () => pagosMaj.insertOne(docPago(seq++)) },
    { id: 'E', grupo: 'Checkout completo', nombre: 'Pedido como hoy (todo en MySQL)', detalle: 'Una transacción: UPDATE condicional de stock + INSERT compra + INSERT pago, con las FK reales.', escribe: '3 filas, 1 commit',
      op: () => { const n = seq++; return enMysql(async (cx) => {
        const compra = await pedidoMysql(cx, n);
        await cx.query('INSERT INTO e6_pago (id_compra, id_metodo_pago, monto, estado, referencia_transaccion) VALUES (?, ?, ?, ?, ?)', [compra, usu(n), '44.99', 'aprobado', `TX-${compra}`]);
      }); } },
    { id: 'F', grupo: 'Checkout completo', nombre: 'Pedido + fila outbox hacia Mongo (Opción C)', detalle: 'Igual que E más una fila de outbox en la misma transacción; el relevo a Mongo ocurre fuera de la ruta crítica.', escribe: '4 filas, 1 commit',
      op: () => { const n = seq++; return enMysql(async (cx) => {
        const compra = await pedidoMysql(cx, n);
        await cx.query('INSERT INTO e6_pago (id_compra, id_metodo_pago, monto, estado, referencia_transaccion) VALUES (?, ?, ?, ?, ?)', [compra, usu(n), '44.99', 'aprobado', `TX-${compra}`]);
        await cx.query('INSERT INTO e6_pago_outbox (id_compra, payload) VALUES (?, ?)', [compra, JSON.stringify({ monto: '44.99', usuario: usu(n) })]);
      }); } },
    { id: 'G', grupo: 'Checkout completo', nombre: 'Saga: pago en Mongo, pedido en MySQL (Opción B)', detalle: 'Transacción Mongo {pago autorizado, evento} dentro de la transacción MySQL {stock, compra, intento}, y luego transacción Mongo {aprobar pago, evento}.', escribe: '4 docs + 3 filas, 3 commits',
      op: () => { const n = seq++; const id = randomUUID(); return enMysql(async (cx) => {
        const s = mongo.startSession();
        try {
          await s.withTransaction(async () => {
            await pagos.insertOne(docPago(n, { intento_id: id, estado: 'autorizado', compra_id: null }), { session: s });
            await eventos.insertOne({ intento_id: id, tipo: 'autorizado', en: new Date() }, { session: s });
          }, opcionesTx);
        } finally { await s.endSession(); }
        await pedidoMysql(cx, n);
        await cx.query('INSERT INTO e6_intento (id, estado) VALUES (?, ?)', [id, 'completado']);
      }).then(async () => {
        const s = mongo.startSession();
        try {
          await s.withTransaction(async () => {
            await pagos.updateOne({ intento_id: id, estado: 'autorizado' }, { $set: { estado: 'aprobado', compra_id: n } }, { session: s });
            await eventos.insertOne({ intento_id: id, tipo: 'aprobado', en: new Date() }, { session: s });
          }, opcionesTx);
        } finally { await s.endSession(); }
      }); } },
    { id: 'H', grupo: 'Checkout completo', nombre: 'Todo en Mongo, una transacción (Opción A3)', detalle: 'Transacción multi-documento: descuento de stock + compra + pago + evento, con snapshot y w:majority.', escribe: '4 docs, 1 commit',
      op: async () => { const n = seq++; const s = mongo.startSession();
        try {
          await s.withTransaction(async () => {
            await stock.findOneAndUpdate({ _id: prod(n), cantidad: { $gte: 1 } }, { $inc: { cantidad: -1 } }, { session: s });
            const c = await compras.insertOne({ usuario_id: usu(n), total: Decimal128.fromString('44.99') }, { session: s });
            const id = randomUUID();
            await pagos.insertOne(docPago(n, { intento_id: id, compra_id: n, compra_ref: c.insertedId }), { session: s });
            await eventos.insertOne({ intento_id: id, tipo: 'aprobado', en: new Date() }, { session: s });
          }, opcionesTx);
        } finally { await s.endSession(); } } },
  ];

  const niveles = [1, 8, 32];
  const REPS = rapido ? 1 : 3;
  const totalPara = (c) => (rapido ? 30 * c : (c === 1 ? 300 : c * 100));
  const muestras = new Map(); // `${id}|${c}` → [medición]
  const registrar = (clave, m) => { (muestras.get(clave) || muestras.set(clave, []).get(clave)).push(m); };

  // Calentamiento (descartado): abre conexiones, llena cachés, estabiliza el journal.
  if (!rapido) for (const w of cargas) await medir({ total: 120, concurrencia: 8, operacion: w.op });
  for (let ronda = 1; ronda <= REPS; ronda++) {
    for (const w of cargas) {
      for (const c of niveles) registrar(`${w.id}|${c}`, await medir({ total: totalPara(c), concurrencia: c, operacion: w.op }));
    }
  }

  const resumenCelda = (id, c) => {
    const m = muestras.get(`${id}|${c}`);
    return {
      errores: m.reduce((a, x) => a + x.errores, 0), primerError: m.find((x) => x.primerError)?.primerError,
      ops: mediana(m.map((x) => x.ops_s)), min: Math.min(...m.map((x) => x.ops_s)), max: Math.max(...m.map((x) => x.ops_s)),
      p50: mediana(m.map((x) => x.p50_ms)), p95: mediana(m.map((x) => x.p95_ms)), p99: mediana(m.map((x) => x.p99_ms)),
    };
  };
  const filas = [];
  for (const c of niveles) {
    for (const w of cargas) {
      const r = resumenCelda(w.id, c);
      chequear(`Carga ${w.id} (concurrencia ${c}) sin errores`, r.errores === 0, r.primerError || '');
      filas.push({ c, id: w.id, grupo: w.grupo, nombre: w.nombre, ops: `${f(r.ops, 0)} [${f(r.min, 0)}–${f(r.max, 0)}]`,
        p50: f(r.p50, 2), p95: f(r.p95, 2), p99: f(r.p99, 2), datos: { ...r } });
    }
  }
  const leyenda = tabla([{ clave: 'id', titulo: '#' }, { clave: 'nombre', titulo: 'Carga' }, { clave: 'detalle', titulo: 'Qué hace' }, { clave: 'escribe', titulo: 'Escribe' }],
    cargas.map((w) => ({ id: w.id, nombre: w.nombre, detalle: w.detalle, escribe: w.escribe })));
  const cols = [{ clave: 'id', titulo: '#' }, { clave: 'nombre', titulo: 'Carga' }, { clave: 'ops', titulo: 'ops/s mediana [mín–máx]' },
    { clave: 'p50', titulo: 'p50 ms' }, { clave: 'p95', titulo: 'p95 ms' }, { clave: 'p99', titulo: 'p99 ms' }];
  const tablas = [{ titulo: 'Leyenda de las cargas de escritura', md: leyenda }];
  tablas.push(...niveles.map((c) => ({ titulo: `Escrituras — concurrencia ${c} (${totalPara(c)} operaciones por celda × ${REPS} rondas)`,
    md: tabla(cols, filas.filter((x) => x.c === c)) })));

  // ---------- lecturas con volumen (100 000 pagos) ----------
  const N = rapido ? 10000 : 100000;
  for (const ddl of ddlPedidos('e6r')) await my.query(ddl);
  await my.query(`CREATE TABLE e6r_compra_detalle (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, id_compra INT NOT NULL, id_producto INT NOT NULL,
    KEY e6r_d_compra (id_compra), KEY e6r_d_producto (id_producto)) ENGINE=InnoDB`);
  const ids = Array.from({ length: N }, (_, i) => i + 1);
  // La carga masiva usa UNA conexión dedicada: foreign_key_checks es de sesión, no del pool.
  const carga = await my.getConnection();
  try {
    await carga.query('SET foreign_key_checks = 0');
    await insertarFilas(carga, 'e6r_compra', ['id', 'id_usuario', 'id_direccion', 'total'], ids.map((i) => [i, usu(i), usu(i), '44.99']));
    await insertarFilas(carga, 'e6r_compra_detalle', ['id_compra', 'id_producto'], ids.map((i) => [i, 1 + (i % PRODUCTOS_SEMILLA)]));
    await insertarFilas(carga, 'e6r_pago', ['id_compra', 'id_metodo_pago', 'monto', 'estado'], ids.map((i) => [i, usu(i), '44.99', 'aprobado']));
    await carga.query('ANALYZE TABLE e6r_compra, e6r_compra_detalle, e6r_pago');
  } finally { carga.release(); }
  const lecturaPagos = db.collection('e6r_pagos');
  for (let i = 0; i < N; i += 10000) {
    await lecturaPagos.insertMany(ids.slice(i, i + 10000).map((n) => ({
      intento_id: randomUUID(), usuario_id: usu(n), compra_id: n, monto: Decimal128.fromString('44.99'), estado: 'aprobado',
    })));
  }
  await indicesPagos(lecturaPagos);
  await esperar(500);

  const lecturas = [
    { id: 'R1', nombre: 'MySQL: pago de una compra (por id_compra)',
      op: () => my.query('SELECT id, monto, estado FROM e6r_pago WHERE id_compra = ?', [1 + Math.floor(Math.random() * N)]) },
    { id: 'R2', nombre: 'Mongo: pago de una compra (por compra_id)',
      op: () => lecturaPagos.findOne({ compra_id: 1 + Math.floor(Math.random() * N), estado: 'aprobado' }) },
    { id: 'R3', nombre: '"¿Pagó el producto X?" MySQL: JOIN compra⨝detalle⨝pago',
      op: () => { const n = 1 + Math.floor(Math.random() * N);
        return my.query(`SELECT 1 FROM e6r_compra c JOIN e6r_compra_detalle d ON d.id_compra = c.id
          JOIN e6r_pago p ON p.id_compra = c.id AND p.estado = 'aprobado' WHERE c.id_usuario = ? AND d.id_producto = ? LIMIT 1`, [usu(n), 1 + (n % PRODUCTOS_SEMILLA)]); } },
    { id: 'R4', nombre: '"¿Pagó el producto X?" pago en Mongo: consulta MySQL + consulta Mongo (2 viajes)',
      op: async () => { const n = 1 + Math.floor(Math.random() * N);
        const cs = await my.query('SELECT c.id FROM e6r_compra c JOIN e6r_compra_detalle d ON d.id_compra = c.id WHERE c.id_usuario = ? AND d.id_producto = ?', [usu(n), 1 + (n % PRODUCTOS_SEMILLA)]);
        return lecturaPagos.findOne({ compra_id: { $in: cs.map((x) => x.id) }, estado: 'aprobado' }, { projection: { _id: 1 } }); } },
    { id: 'R5', nombre: 'MySQL: últimos 20 pagos de un usuario (JOIN compra⨝pago)',
      op: () => my.query(`SELECT p.id, p.monto, p.estado, p.fecha_pago FROM e6r_compra c JOIN e6r_pago p ON p.id_compra = c.id
        WHERE c.id_usuario = ? ORDER BY c.id DESC LIMIT 20`, [usu(1 + Math.floor(Math.random() * N))]) },
    { id: 'R6', nombre: 'Mongo: últimos 20 pagos de un usuario (usuario_id denormalizado)',
      op: () => lecturaPagos.find({ usuario_id: usu(1 + Math.floor(Math.random() * N)) }).sort({ compra_id: -1 }).limit(20).toArray() },
  ];
  const nivelesLectura = [1, 16];
  const muestrasL = new Map();
  if (!rapido) for (const r of lecturas) await medir({ total: 300, concurrencia: 8, operacion: r.op });
  for (let ronda = 1; ronda <= REPS; ronda++) {
    for (const r of lecturas) for (const c of nivelesLectura) {
      const m = await medir({ total: rapido ? 100 : 2000, concurrencia: c, operacion: r.op });
      (muestrasL.get(`${r.id}|${c}`) || muestrasL.set(`${r.id}|${c}`, []).get(`${r.id}|${c}`)).push(m);
    }
  }
  const filasL = [];
  for (const c of nivelesLectura) for (const r of lecturas) {
    const m = muestrasL.get(`${r.id}|${c}`);
    chequear(`Lectura ${r.id} (concurrencia ${c}) sin errores`, m.every((x) => x.errores === 0), m.find((x) => x.primerError)?.primerError || '');
    filasL.push({ c, id: r.id, nombre: r.nombre,
      ops: `${f(mediana(m.map((x) => x.ops_s)), 0)} [${f(Math.min(...m.map((x) => x.ops_s)), 0)}–${f(Math.max(...m.map((x) => x.ops_s)), 0)}]`,
      p50: f(mediana(m.map((x) => x.p50_ms)), 2), p95: f(mediana(m.map((x) => x.p95_ms)), 2), p99: f(mediana(m.map((x) => x.p99_ms)), 2) });
  }
  for (const c of nivelesLectura) {
    tablas.push({ titulo: `Lecturas sobre ${N.toLocaleString('es')} pagos — concurrencia ${c}`, md: tabla(cols, filasL.filter((x) => x.c === c)) });
  }
  notas.push('Las cifras de E6 comparan filas entre sí dentro de una misma corrida; no son capacidad de producción (ver "Límites" del ADR-005).');

  return { titulo: 'E6 — Rendimiento', checks, tablas, notas,
    datos: { escrituras: filas.map(({ datos, ...x }) => ({ ...x, ...datos })), lecturas: filasL, reps: REPS, volumenLectura: N } };
}

module.exports = { ejecutar };
