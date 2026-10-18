// E5 — Saga de pago con MongoDB como autoridad, con fallas inyectadas.
//
// Modela (no modifica) el escenario de migración del ADR-005: el pago vive en Mongo y el pedido
// en MySQL, así que no hay un COMMIT único. El diseño reutiliza lo que el checkout idempotente
// ya tiene (IA/CHECKOUT-IDEMPOTENCIA.md):
//   - `checkout_intento` en MySQL es el REGISTRO durable de la saga (aquí: e5_intento).
//   - El pago se autoriza en Mongo desde el mismo gancho donde hoy se reserva el cupo flash en
//     Redis: dentro de la transacción de MySQL, antes del trabajo relacional.
//   - Si el pedido no llega a confirmarse, se anula el pago (compensación) y se hace bajo el
//     MISMO lock del usuario, para no anular nunca un pago cuyo COMMIT sí ocurrió.
//   - Un barrido periódico (como `reconciliar()`, cada 30 s) cierra lo que quedó a medias.
// Estados del pago en Mongo: autorizado → aprobado (tras el COMMIT) | anulado (compensación).
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { MongoClient, Decimal128 } = require('mongodb');
const { nuevoRegistro, tabla, ahoraMs, esperar } = require('./util');

const opcionesTx = { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' };
const STOCK_INICIAL = 1000;
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

// Proxy TCP mínimo hacia Mongo. `cortar()` destruye las conexiones vivas y cierra el puerto; `reanudar()` lo reabre
// en el mismo puerto, igual que si la red o el servicio volvieran.
function crearProxy(puertoDestino) {
  const vivos = new Set();
  let servidor = null;
  let puerto = 0;
  const atender = (cliente) => {
    const destino = net.connect(puertoDestino, '127.0.0.1');
    vivos.add(cliente); vivos.add(destino);
    const cerrar = () => { vivos.delete(cliente); vivos.delete(destino); cliente.destroy(); destino.destroy(); };
    cliente.on('error', cerrar); destino.on('error', cerrar); cliente.on('close', cerrar); destino.on('close', cerrar);
    cliente.pipe(destino); destino.pipe(cliente);
  };
  const escuchar = () => new Promise((resolver, rechazar) => {
    servidor = net.createServer(atender);
    servidor.once('error', rechazar);
    servidor.listen(puerto, '127.0.0.1', () => { puerto = servidor.address().port; resolver(puerto); });
  });
  return {
    iniciar: escuchar,
    reanudar: escuchar,
    cortar: () => new Promise((resolver) => {
      for (const s of [...vivos]) s.destroy();
      if (servidor?.listening) servidor.close(() => resolver()); else resolver();
    }),
    get puerto() { return puerto; },
  };
}

class Muerte extends Error {}          // el proceso "muere": no corre ningún código de compensación
class ErrorNegocio extends Error {}    // rechazo de negocio (p. ej. stock insuficiente)

async function ejecutar(ctx, { rapido }) {
  const { checks, chequear } = nuevoRegistro();
  const notas = [];
  const { my, db, MONGO_DB } = ctx;

  await my.query(`CREATE TABLE e5_inventario (id_producto INT NOT NULL PRIMARY KEY, cantidad INT NOT NULL) ENGINE=InnoDB`);
  await my.query(`CREATE TABLE e5_compra (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, id_usuario INT NOT NULL, total DECIMAL(10,2) NOT NULL,
    intento_id CHAR(36) NOT NULL, UNIQUE KEY uq_e5_compra_intento (intento_id)) ENGINE=InnoDB`);
  await my.query(`CREATE TABLE e5_intento (id CHAR(36) NOT NULL PRIMARY KEY, id_usuario INT NOT NULL, estado VARCHAR(16) NOT NULL DEFAULT 'pendiente',
    compra_id INT NULL, respuesta JSON NULL, compensado TINYINT NOT NULL DEFAULT 0,
    actualizado_en DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)) ENGINE=InnoDB`);
  await my.query(`CREATE TABLE e5_pago_outbox (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, intento_id CHAR(36) NOT NULL, payload JSON NOT NULL,
    procesado_en DATETIME(3) NULL, intentos INT NOT NULL DEFAULT 0) ENGINE=InnoDB`);
  await my.query('INSERT INTO e5_inventario (id_producto, cantidad) VALUES (1, ?)', [STOCK_INICIAL]);

  const proveedor = (cliente) => ({
    cliente,
    pagos: cliente.db(MONGO_DB).collection('e5_pagos'),
    eventos: cliente.db(MONGO_DB).collection('e5_pago_eventos'),
  });
  const sano = proveedor(ctx.mongo);
  await db.createCollection('e5_pagos');
  await db.createCollection('e5_pago_eventos');
  await sano.pagos.createIndex({ intento_id: 1 }, { unique: true });
  await sano.pagos.createIndex({ compra_id: 1 }, { unique: true, partialFilterExpression: { estado: 'aprobado' } });
  await sano.pagos.createIndex({ estado: 1 });
  await esperar(300);

  // La saga habla con Mongo a través de un proxy TCP propio. Cortar el proxy destruye los sockets abiertos y
  // cierra el puerto: la falla de red (sockets reseteados, luego "nadie escucha") la produce el driver real,
  // no una excepción fabricada, y no hace falta tocar el contenedor de Mongo.
  const proxy = crearProxy(Number(new URL(process.env.MONGO_URI).port || 27017));
  await proxy.iniciar();
  const clienteRed = new MongoClient(`mongodb://127.0.0.1:${proxy.puerto}/?directConnection=true`,
    { serverSelectionTimeoutMS: 1500, heartbeatFrequencyMS: 500, maxPoolSize: 30 });
  await clienteRed.connect();
  const viaRed = proveedor(clienteRed);

  const saga = { mongo: viaRed };
  const registro = { reintentosMongo: 2 };

  // ---------------- piezas de la saga ----------------
  async function enTx(fn, { tras } = {}) {
    const cx = await my.getConnection();
    try {
      await cx.beginTransaction();
      const r = await fn(cx);
      await cx.commit();
      if (tras) tras(); // puede lanzar: el servidor ya confirmó pero el cliente "pierde" la respuesta del COMMIT
      return r;
    } catch (err) {
      try { await cx.rollback(); } catch { /* ya confirmada o conexión caída */ }
      throw err;
    } finally { cx.release(); }
  }
  const bloquear = (cx, usuarioId) => cx.query('SELECT id_usuario FROM usuarios WHERE id_usuario = ? FOR UPDATE', [usuarioId]);
  async function reintentar(fn, veces) {
    for (let i = 1; ; i++) {
      try { return await fn(); } catch (err) { if (err instanceof Muerte || i >= veces) throw err; await esperar(10); }
    }
  }

  async function nuevoIntento(usuarioId) {
    const id = randomUUID();
    await my.query('INSERT INTO e5_intento (id, id_usuario) VALUES (?, ?)', [id, usuarioId]);
    return id;
  }

  // Autoriza el pago y deja su evento, atómicos entre sí (transacción multi-documento en Mongo).
  // E11000 = ese intento ya había registrado su pago: es éxito (idempotencia), no error.
  async function autorizarPago({ intentoId, usuarioId, monto }, inyectar, estado) {
    const s = saga.mongo.cliente.startSession();
    try {
      await s.withTransaction(async () => {
        await saga.mongo.pagos.insertOne({ intento_id: intentoId, usuario_id: usuarioId, monto: Decimal128.fromString(monto),
          estado: 'autorizado', compra_id: null, creado_en: new Date() }, { session: s });
        await saga.mongo.eventos.insertOne({ intento_id: intentoId, tipo: 'autorizado', en: new Date() }, { session: s });
      }, opcionesTx);
    } catch (err) {
      if (err.code !== 11000) throw err;
    } finally { await s.endSession(); }
    if (inyectar.ackPerdidoMongo && !estado.ackPerdido) {
      estado.ackPerdido = true;
      throw new Error('respuesta de Mongo perdida (simulado): el servidor ya escribió');
    }
  }

  // autorizado → aprobado, idempotente: si ya estaba aprobado no cambia nada ni duplica el evento.
  async function finalizarPago(intentoId, compraId, inyectar = {}) {
    if (inyectar.finalizarFalla && !inyectar.yaFallo) { inyectar.yaFallo = true; throw new Error('Mongo no disponible al aprobar el pago (simulado)'); }
    const s = saga.mongo.cliente.startSession();
    try {
      await s.withTransaction(async () => {
        const r = await saga.mongo.pagos.updateOne({ intento_id: intentoId, estado: 'autorizado' },
          { $set: { estado: 'aprobado', compra_id: compraId, actualizado_en: new Date() } }, { session: s });
        if (r.modifiedCount) await saga.mongo.eventos.insertOne({ intento_id: intentoId, tipo: 'aprobado', en: new Date() }, { session: s });
      }, opcionesTx);
    } finally { await s.endSession(); }
  }

  // Compensación: anular un pago que quedó autorizado sin pedido. Solo actúa sobre 'autorizado'.
  async function anularPago(intentoId) {
    const s = saga.mongo.cliente.startSession();
    try {
      await s.withTransaction(async () => {
        const r = await saga.mongo.pagos.updateOne({ intento_id: intentoId, estado: 'autorizado' },
          { $set: { estado: 'anulado', actualizado_en: new Date() } }, { session: s });
        if (r.modifiedCount) await saga.mongo.eventos.insertOne({ intento_id: intentoId, tipo: 'anulado', en: new Date() }, { session: s });
      }, opcionesTx);
    } finally { await s.endSession(); }
  }
  async function compensar(intento) {
    if (intento.compensado) return;
    await anularPago(intento.id);
    await my.query('UPDATE e5_intento SET compensado = 1 WHERE id = ?', [intento.id]);
  }

  // Igual que `resolverFallo` del checkout real: toma el lock del usuario ANTES de decidir, así un
  // COMMIT ambiguo nunca se compensa mientras otra transacción pueda confirmarlo.
  async function resolverFallo(intentoId, usuarioId, { umbralMs = null } = {}) {
    const intento = await enTx(async (cx) => {
      await bloquear(cx, usuarioId);
      const [actual] = await cx.query(
        'SELECT *, TIMESTAMPDIFF(MICROSECOND, actualizado_en, CURRENT_TIMESTAMP(3)) / 1000 AS edad_ms FROM e5_intento WHERE id = ?', [intentoId]);
      if (actual.estado !== 'pendiente') return actual;
      if (umbralMs !== null && Number(actual.edad_ms) < umbralMs) return actual; // aún puede estar en vuelo
      await cx.query("UPDATE e5_intento SET estado = 'fallido' WHERE id = ?", [intentoId]);
      return { ...actual, estado: 'fallido' };
    });
    if (intento.estado === 'completado') {
      try { await finalizarPago(intentoId, intento.compra_id); } catch { /* lo cierra el barrido */ }
      return parse(intento.respuesta);
    }
    if (intento.estado === 'fallido') {
      try { await compensar(intento); } catch { /* compensación pendiente: la reintenta el barrido */ }
    }
    return null;
  }

  async function checkout({ usuarioId, intentoId, cantidad = 1, monto = '10.00' }, inyectar = {}) {
    const estado = {};
    try {
      const respuesta = await enTx(async (cx) => {
        await bloquear(cx, usuarioId);
        const [intento] = await cx.query('SELECT * FROM e5_intento WHERE id = ?', [intentoId]);
        if (intento.estado === 'completado') return { ...parse(intento.respuesta), reutilizado: true };
        if (intento.estado === 'fallido') throw Object.assign(new ErrorNegocio('El intento ya terminó'), { terminado: true });
        await reintentar(() => autorizarPago({ intentoId, usuarioId, monto }, inyectar, estado), registro.reintentosMongo); // gancho de la saga
        if (inyectar.muerteTrasMongo) throw new Muerte('el proceso muere tras autorizar el pago');
        const r = await cx.query('UPDATE e5_inventario SET cantidad = cantidad - ? WHERE id_producto = 1 AND cantidad >= ?', [cantidad, cantidad]);
        if (r.affectedRows !== 1) throw new ErrorNegocio('Stock insuficiente');
        if (inyectar.mysqlFalla) throw new Error('falla de MySQL antes del COMMIT (simulada)');
        const c = await cx.query('INSERT INTO e5_compra (id_usuario, total, intento_id) VALUES (?, ?, ?)', [usuarioId, monto, intentoId]);
        const resp = { compraId: c.insertId, monto };
        await cx.query("UPDATE e5_intento SET estado = 'completado', compra_id = ?, respuesta = ? WHERE id = ?", [c.insertId, JSON.stringify(resp), intentoId]);
        return resp;
      }, { tras: inyectar.commitAmbiguo ? () => { throw new Error('respuesta del COMMIT perdida (simulada)'); } : undefined });
      if (!respuesta.reutilizado) {
        try { await finalizarPago(intentoId, respuesta.compraId, inyectar); } catch { /* el pedido ya está confirmado: lo cierra el barrido */ }
      }
      return respuesta;
    } catch (err) {
      if (err instanceof Muerte || err.terminado) throw err;
      const confirmada = await resolverFallo(intentoId, usuarioId);
      if (confirmada) return confirmada;
      throw err;
    }
  }

  // Barrido: lo que haría el worker. Tres pasadas, todas idempotentes.
  async function barrer({ umbralMs }) {
    for (const i of await my.query("SELECT id, id_usuario FROM e5_intento WHERE estado = 'pendiente'")) {
      await resolverFallo(i.id, i.id_usuario, { umbralMs }).catch(() => {});
    }
    for (const i of await my.query("SELECT * FROM e5_intento WHERE estado = 'fallido' AND compensado = 0")) {
      await compensar(i).catch(() => {});
    }
    for (const p of await saga.mongo.pagos.find({ estado: 'autorizado' }).toArray()) {
      const [i] = await my.query('SELECT * FROM e5_intento WHERE id = ?', [p.intento_id]);
      if (i?.estado === 'completado') await finalizarPago(p.intento_id, i.compra_id).catch(() => {});
    }
  }

  // ---------------- observación ----------------
  async function foto(intentoId) {
    const [i] = await my.query('SELECT estado, compensado FROM e5_intento WHERE id = ?', [intentoId]);
    const compras = (await my.query('SELECT COUNT(*) AS n FROM e5_compra WHERE intento_id = ?', [intentoId]))[0].n;
    const pago = await sano.pagos.findOne({ intento_id: intentoId });
    const eventos = (await sano.eventos.find({ intento_id: intentoId }).sort({ _id: 1 }).toArray()).map((e) => e.tipo).join('→');
    return { intento: `${i.estado}${i.compensado ? '+compensado' : ''}`, compras: Number(compras), pago: pago?.estado ?? '—', eventos: eventos || '—' };
  }
  const resumen = (x) => `intento ${x.intento}; compras ${x.compras}; pago ${x.pago}; eventos ${x.eventos}`;
  const stock = async () => (await my.query('SELECT cantidad FROM e5_inventario WHERE id_producto = 1'))[0].cantidad;

  async function invariantes() {
    const compras = await my.query('SELECT id, total FROM e5_compra');
    const pagos = await sano.pagos.find({}).toArray();
    const aprobados = pagos.filter((p) => p.estado === 'aprobado');
    const porCompra = new Map();
    for (const p of aprobados) porCompra.set(String(p.compra_id), (porCompra.get(String(p.compra_id)) || 0) + 1);
    const ids = new Set(compras.map((c) => String(c.id)));
    const cent = (v) => Math.round(Number(v) * 100);
    return {
      I1: compras.every((c) => porCompra.get(String(c.id)) === 1),
      I2: aprobados.every((p) => ids.has(String(p.compra_id))),
      I3: pagos.every((p) => p.estado !== 'autorizado'),
      I4: STOCK_INICIAL - Number(await stock()) === compras.length,
      I5: compras.reduce((a, c) => a + cent(c.total), 0) === aprobados.reduce((a, p) => a + cent(p.monto.toString()), 0),
      compras: compras.length, pagos: pagos.length,
    };
  }

  const filas = [];
  const fila = (n, nombre, falla, inmediato, tras, ok) => filas.push({ n, nombre, falla, inmediato, tras, ok: ok ? '✔' : '✘' });
  const usuario = (n) => 100 + n; // un usuario distinto por escenario: los locks no se mezclan

  // S0 — sin falla
  {
    const u = usuario(0); const id = await nuevoIntento(u); const s0 = await stock();
    const r = await checkout({ usuarioId: u, intentoId: id });
    const x = await foto(id);
    const ok = chequear('S0 sin falla: pedido confirmado, pago aprobado, un descuento de stock',
      !!r.compraId && x.compras === 1 && x.pago === 'aprobado' && x.eventos === 'autorizado→aprobado' && (s0 - await stock()) === 1, resumen(x));
    fila('S0', 'Sin falla (referencia)', '—', resumen(x), '—', ok);
  }

  // S1 — doble clic / dos ventanas: 20 confirmaciones simultáneas del mismo intento
  {
    const u = usuario(1); const id = await nuevoIntento(u); const s0 = await stock();
    const res = await Promise.allSettled(Array.from({ length: 20 }, () => checkout({ usuarioId: u, intentoId: id })));
    const exitos = res.filter((x) => x.status === 'fulfilled');
    const x = await foto(id);
    const reutilizadas = exitos.filter((e) => e.value.reutilizado).length;
    const ok = chequear('S1 20 confirmaciones simultáneas del mismo intento: un pedido, un pago, un descuento',
      exitos.length === 20 && reutilizadas === 19 && x.compras === 1 && x.pago === 'aprobado' && (s0 - await stock()) === 1,
      `${exitos.length} respondieron (${reutilizadas} reutilizadas); ${resumen(x)}`);
    fila('S1', 'Doble clic: 20 confirmaciones simultáneas, mismo intento', '—', `${exitos.length}/20 respondieron, ${reutilizadas} con el resultado guardado; ${resumen(x)}`, '—', ok);
  }

  // S2 — Mongo se cae (corte de red) antes de autorizar el pago
  {
    const u = usuario(2); const id = await nuevoIntento(u); const s0 = await stock();
    await sano.pagos.findOne({}); await viaRed.pagos.findOne({}); // el cliente de la saga ya tenía conexiones abiertas cuando cae
    await proxy.cortar();
    // Según el estado del pool el fallo puede ser inmediato (conexión reseteada → MongoNetworkError) o tardar
    // serverSelectionTimeoutMS por intento (MongoServerSelectionError). Se deja que el monitor del driver
    // (heartbeat de 500 ms) marque el servidor como caído para medir de forma repetible el segundo caso, el peor.
    await viaRed.pagos.findOne({}, { maxTimeMS: 500 }).catch(() => {});
    await esperar(1500);
    const t0 = ahoraMs();
    let error = null;
    try { await checkout({ usuarioId: u, intentoId: id }); } catch (err) { error = err; }
    const ms = ahoraMs() - t0;
    const inmediato = await foto(id); // la foto lee por la vía directa: no depende del corte
    await proxy.reanudar();           // "Mongo vuelve": el driver se reconecta por sí solo
    await barrer({ umbralMs: 0 });
    const tras = await foto(id);
    const ok = chequear('S2 Mongo caído: el checkout falla cerrado (sin pedido, sin pago, stock intacto) y la compensación pendiente se completa al volver Mongo',
      !!error && inmediato.compras === 0 && inmediato.pago === '—' && inmediato.intento.startsWith('fallido') && (s0 - await stock()) === 0 && tras.intento === 'fallido+compensado',
      `error: ${error?.name}; ${(ms / 1000).toFixed(1)} s hasta fallar; tras volver: ${tras.intento}`);
    fila('S2', 'Corte de red hacia Mongo antes de autorizar el pago', `proxy cortado; serverSelectionTimeoutMS=1500, ${registro.reintentosMongo} intentos`,
      `${error?.name} tras ${(ms / 1000).toFixed(1)} s (incluye el intento de compensación); ${resumen(inmediato)}`, resumen(tras), ok);
    notas.push(`S2: con Mongo inalcanzable el checkout tardó ${(ms / 1000).toFixed(1)} s en fallar (serverSelectionTimeoutMS=1500, ${registro.reintentosMongo} intentos, más un intento de compensación). El valor por defecto del driver es 30 000 ms: sin configurarlo, el usuario esperaría con su fila bloqueada hasta que venza la transacción interactiva de Prisma (15 s en checkoutIntentoService.js).`);
  }

  // S3 — MySQL falla tras autorizar en Mongo
  {
    const u = usuario(3); const id = await nuevoIntento(u); const s0 = await stock();
    let error = null;
    try { await checkout({ usuarioId: u, intentoId: id }, { mysqlFalla: true }); } catch (err) { error = err; }
    const x = await foto(id);
    const ok = chequear('S3 MySQL falla tras autorizar en Mongo: el pago se anula en línea, sin pedido ni descuento',
      !!error && x.pago === 'anulado' && x.eventos === 'autorizado→anulado' && x.compras === 0 && x.intento === 'fallido+compensado' && (s0 - await stock()) === 0, resumen(x));
    fila('S3', 'Falla de MySQL tras autorizar el pago en Mongo', 'error antes del COMMIT', resumen(x), '—', ok);
  }

  // S4 — rechazo de negocio (stock insuficiente) tras autorizar
  {
    const u = usuario(4); const id = await nuevoIntento(u); const s0 = await stock();
    let error = null;
    try { await checkout({ usuarioId: u, intentoId: id, cantidad: STOCK_INICIAL * 10 }); } catch (err) { error = err; }
    const x = await foto(id);
    const ok = chequear('S4 stock insuficiente después de autorizar: pago anulado, sin pedido',
      error instanceof ErrorNegocio && x.pago === 'anulado' && x.compras === 0 && (s0 - await stock()) === 0, resumen(x));
    fila('S4', 'Stock insuficiente (rechazo de negocio) tras autorizar', 'UPDATE condicional afecta 0 filas', resumen(x), '—', ok);
  }

  // S5 — el proceso muere entre Mongo y el COMMIT
  {
    const u = usuario(5); const id = await nuevoIntento(u); const s0 = await stock();
    let error = null;
    try { await checkout({ usuarioId: u, intentoId: id }, { muerteTrasMongo: true }); } catch (err) { error = err; }
    const inmediato = await foto(id);
    await barrer({ umbralMs: 60000 }); // barrido prematuro: el intento aún puede estar en vuelo, no se toca
    const prematuro = await foto(id);
    await barrer({ umbralMs: 0 });     // el intento "ya venció"
    const tras = await foto(id);
    const ok1 = chequear('S5 proceso muerto tras autorizar: queda un pago huérfano visible (ventana abierta, sin compensación en línea)',
      error instanceof Muerte && inmediato.pago === 'autorizado' && inmediato.intento === 'pendiente' && inmediato.compras === 0, resumen(inmediato));
    const ok2 = chequear('S5 un barrido antes del umbral NO anula (no se compensa a ciegas)', prematuro.pago === 'autorizado' && prematuro.intento === 'pendiente');
    const ok3 = chequear('S5 el barrido tras el umbral anula el pago y cierra el intento',
      tras.pago === 'anulado' && tras.intento === 'fallido+compensado' && tras.compras === 0 && (s0 - await stock()) === 0, resumen(tras));
    fila('S5', 'El proceso muere entre la autorización en Mongo y el COMMIT', 'excepción sin compensación en línea',
      `${resumen(inmediato)}; un barrido prematuro (umbral 60 s) no cambia nada`, resumen(tras), ok1 && ok2 && ok3);
  }

  // S6 — respuesta de Mongo perdida, el servidor sí escribió
  {
    const u = usuario(6); const id = await nuevoIntento(u); const s0 = await stock();
    const r = await checkout({ usuarioId: u, intentoId: id }, { ackPerdidoMongo: true });
    const x = await foto(id);
    const cuantos = await sano.pagos.countDocuments({ intento_id: id });
    const ok = chequear('S6 respuesta de Mongo perdida: el reintento choca con la clave única (E11000) y se trata como éxito; un solo pago',
      !!r.compraId && cuantos === 1 && x.eventos === 'autorizado→aprobado' && x.compras === 1 && (s0 - await stock()) === 1, resumen(x));
    fila('S6', 'Mongo escribió el pago pero la respuesta se perdió', 'excepción de red tras el insert', resumen(x), '—', ok);
  }

  // S7 — COMMIT de MySQL aplicado, respuesta perdida
  {
    const u = usuario(7); const id = await nuevoIntento(u); const s0 = await stock();
    const r = await checkout({ usuarioId: u, intentoId: id }, { commitAmbiguo: true });
    const x = await foto(id);
    const otra = await checkout({ usuarioId: u, intentoId: id });
    const x2 = await foto(id);
    const ok = chequear('S7 COMMIT ambiguo: no se anula el pago (el pedido sí existe); el reintento devuelve el pedido guardado',
      r.compraId === otra.compraId && otra.reutilizado === true && x.pago === 'aprobado' && x2.compras === 1 && (s0 - await stock()) === 1, resumen(x2));
    fila('S7', 'COMMIT de MySQL aplicado pero la respuesta se perdió', 'excepción tras el COMMIT', resumen(x), `reintento: pedido ${otra.compraId} reutilizado, sin escrituras nuevas`, ok);
  }

  // S8 — COMMIT correcto, Mongo no puede aprobar el pago justo después
  {
    const u = usuario(8); const id = await nuevoIntento(u); const s0 = await stock();
    const r = await checkout({ usuarioId: u, intentoId: id }, { finalizarFalla: true });
    const inmediato = await foto(id);
    await barrer({ umbralMs: 0 });
    const tras = await foto(id);
    const ok = chequear('S8 pedido confirmado con el pago aún "autorizado": el barrido lo aprueba sin duplicar eventos',
      !!r.compraId && inmediato.pago === 'autorizado' && inmediato.compras === 1 && tras.pago === 'aprobado' && tras.eventos === 'autorizado→aprobado' && (s0 - await stock()) === 1,
      `inmediato: ${resumen(inmediato)}`);
    fila('S8', 'Pedido confirmado pero Mongo no puede aprobar el pago en ese instante', 'excepción al aprobar', resumen(inmediato), resumen(tras), ok);
  }

  // S9 — orden alternativo: pedido primero y Mongo como PROYECCIÓN vía outbox (Opción C del ADR)
  {
    const u = usuario(9); const id = randomUUID();
    await enTx(async (cx) => {
      await bloquear(cx, u);
      const c = await cx.query('INSERT INTO e5_compra (id_usuario, total, intento_id) VALUES (?, ?, ?)', [u, '25.00', id]);
      await cx.query('UPDATE e5_inventario SET cantidad = cantidad - 1 WHERE id_producto = 1');
      await cx.query('INSERT INTO e5_pago_outbox (intento_id, payload) VALUES (?, ?)', [id, JSON.stringify({ compra_id: c.insertId, usuario_id: u, monto: '25.00' })]);
    });
    const relevar = async (mongo, { caerTrasEscribir = false } = {}) => {
      for (const o of await my.query('SELECT * FROM e5_pago_outbox WHERE procesado_en IS NULL ORDER BY id')) {
        try {
          const p = parse(o.payload);
          await mongo.pagos.updateOne({ intento_id: o.intento_id }, { $setOnInsert: { usuario_id: p.usuario_id, compra_id: p.compra_id,
            monto: Decimal128.fromString(p.monto), estado: 'aprobado', origen: 'outbox' } }, { upsert: true });
          if (caerTrasEscribir) throw new Error('el relevo cae tras escribir en Mongo y antes de marcar procesado (simulado)');
          await my.query('UPDATE e5_pago_outbox SET procesado_en = CURRENT_TIMESTAMP(3) WHERE id = ?', [o.id]);
        } catch { await my.query('UPDATE e5_pago_outbox SET intentos = intentos + 1 WHERE id = ?', [o.id]); }
      }
    };
    await proxy.cortar();
    await relevar(viaRed);
    const [a] = await my.query('SELECT procesado_en, intentos FROM e5_pago_outbox WHERE intento_id = ?', [id]);
    const sinMongo = (await sano.pagos.countDocuments({ intento_id: id })) === 0 && a.procesado_en === null && a.intentos === 1;
    await proxy.reanudar();
    await relevar(viaRed, { caerTrasEscribir: true });
    await relevar(viaRed);
    const [b] = await my.query('SELECT procesado_en, intentos FROM e5_pago_outbox WHERE intento_id = ?', [id]);
    const unico = (await sano.pagos.countDocuments({ intento_id: id })) === 1;
    const ok = chequear('S9 outbox hacia Mongo: con Mongo caído la fila queda pendiente; la entrega duplicada (caída tras escribir) deja un solo documento',
      sinMongo && unico && b.procesado_en !== null, `pendiente con Mongo caído: ${sinMongo}; documentos tras reentrega: 1; intentos fallidos registrados: ${b.intentos}`);
    fila('S9', 'Variante outbox (Mongo como proyección): Mongo caído y relevo que cae tras escribir', 'Mongo inalcanzable; caída antes de marcar procesado',
      `fila pendiente (intentos=${a.intentos}); pedido ya confirmado`, `documentos=${unico ? 1 : '≠1'}, procesada=${b.procesado_en !== null}`, ok);
  }

  // Invariantes globales tras todos los escenarios (y un último barrido)
  await barrer({ umbralMs: 0 });
  const inv = await invariantes();
  chequear('Invariante I1: cada pedido tiene exactamente un pago aprobado', inv.I1);
  chequear('Invariante I2: no hay pagos aprobados sin pedido', inv.I2);
  chequear('Invariante I3: no queda ningún pago "autorizado" tras el barrido', inv.I3);
  chequear('Invariante I4: el stock descontado equivale a los pedidos confirmados', inv.I4);
  chequear('Invariante I5: Σ total de pedidos == Σ monto de pagos aprobados', inv.I5);
  notas.push(`Estado final: ${inv.compras} pedidos y ${inv.pagos} documentos de pago (S9 agrega un pago proyectado sin pasar por los estados autorizado/anulado).`);

  await clienteRed.close().catch(() => {});
  await proxy.cortar().catch(() => {});
  return {
    titulo: 'E5 — Saga de pago en Mongo con fallas inyectadas',
    checks,
    tablas: [{ titulo: 'Escenarios', md: tabla(
      [{ clave: 'n', titulo: '#' }, { clave: 'nombre', titulo: 'Escenario' }, { clave: 'falla', titulo: 'Falla inyectada' },
        { clave: 'inmediato', titulo: 'Estado inmediato' }, { clave: 'tras', titulo: 'Tras el barrido' }, { clave: 'ok', titulo: 'OK' }], filas) }],
    notas,
    datos: { escenarios: filas, invariantes: inv },
  };
}

module.exports = { ejecutar };
