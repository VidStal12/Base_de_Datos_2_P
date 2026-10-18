// E8 — Migración de datos reales: los pagos que hoy existen en MySQL (`tiendaya.pago`) se cargan a una
// colección temporal de Mongo para ensayar la fase 1 del escenario del ADR-005 (espejo de solo lectura):
// carga idempotente, conciliación (conteo, suma exacta y huella por fila) y reparación de una divergencia.
//
// La fuente se lee con una sesión READ ONLY. El destino es `tiendaya_poc_pagos.pagos_migrados`.
const { createHash } = require('node:crypto');
const { Decimal128 } = require('mongodb');
const { nuevoRegistro, tabla, ahoraMs } = require('./util');

const CONSULTA = `SELECT p.id, p.id_compra, p.id_metodo_pago, CAST(p.monto AS CHAR) AS monto, p.estado,
  DATE_FORMAT(p.fecha_pago, '%Y-%m-%dT%H:%i:%s.%f') AS fecha, p.referencia_transaccion,
  c.id_usuario, m.marca, m.ultimos_4_digitos
  FROM pago p JOIN compra c ON c.id = p.id_compra JOIN metodo_pago m ON m.id = p.id_metodo_pago ORDER BY p.id`;

// El snapshot del método de pago NO copia `titular` ni `token_pasarela`: minimización de datos.
const aDocumento = (r) => ({
  legacy_id: r.id, intento_id: `legacy-pago-${r.id}`, compra_id: r.id_compra, usuario_id: r.id_usuario,
  monto: Decimal128.fromString(r.monto), estado: r.estado, fecha_pago: new Date(`${r.fecha.slice(0, 23)}Z`),
  referencia_transaccion: r.referencia_transaccion,
  metodo_pago: { id: r.id_metodo_pago, marca: r.marca, ultimos_4: r.ultimos_4_digitos },
  origen: 'migracion',
});

// Línea canónica de una fila: se calcula igual desde MySQL y desde Mongo.
const linea = (id, compra, usuario, monto, estado, fecha, mp, marca, ult4) =>
  [id, compra, usuario, monto, estado, fecha, mp, marca, ult4].join('|');
const huella = (lineas) => createHash('sha256').update(lineas.join('\n')).digest('hex');

async function ejecutar({ db, origen }) {
  const { checks, chequear } = nuevoRegistro();
  const notas = [];

  const filas = await origen.query(CONSULTA);
  const lineasOrigen = filas.map((r) => linea(r.id, r.id_compra, r.id_usuario, r.monto, r.estado, r.fecha.slice(0, 23), r.id_metodo_pago, r.marca, r.ultimos_4_digitos));
  const sumaOrigen = (await origen.query('SELECT CAST(SUM(monto) AS CHAR) AS t, COUNT(*) AS n FROM pago'))[0];
  const [tam] = await origen.query("SELECT ROUND((data_length + index_length) / 1024, 1) AS kb FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'pago'");

  const col = await db.createCollection('pagos_migrados');
  await col.createIndex({ legacy_id: 1 }, { unique: true });
  await col.createIndex({ intento_id: 1 }, { unique: true });
  await col.createIndex({ compra_id: 1 }, { unique: true, partialFilterExpression: { estado: 'aprobado' } });
  await col.createIndex({ usuario_id: 1, compra_id: -1 });

  const cargar = async () => {
    const t0 = ahoraMs();
    const r = await col.bulkWrite(filas.map((x) => {
      const doc = aDocumento(x);
      // $set (no $setOnInsert): en la fase 1 MySQL manda, así que la carga también REPARA divergencias.
      return { updateOne: { filter: { legacy_id: doc.legacy_id }, update: { $set: doc, $setOnInsert: { migrado_en: new Date() } }, upsert: true } };
    }), { ordered: false });
    return { upserted: r.upsertedCount, modified: r.modifiedCount, ms: ahoraMs() - t0 };
  };
  const conciliar = async () => {
    const docs = await col.find({}).sort({ legacy_id: 1 }).toArray();
    const suma = (await col.aggregate([{ $group: { _id: null, t: { $sum: '$monto' } } }]).next())?.t.toString() ?? '0';
    const lineasDestino = docs.map((d) => linea(d.legacy_id, d.compra_id, d.usuario_id, d.monto.toString(), d.estado,
      d.fecha_pago.toISOString().slice(0, 23), d.metodo_pago.id, d.metodo_pago.marca, d.metodo_pago.ultimos_4));
    const distintas = lineasDestino.length === lineasOrigen.length
      ? lineasOrigen.flatMap((l, i) => (l === lineasDestino[i] ? [] : [Number(l.split('|')[0])])) : null;
    return { conteo: docs.length, suma, huella: huella(lineasDestino), distintas };
  };

  const original = { conteo: filas.length, suma: sumaOrigen.t, huella: huella(lineasOrigen) };
  chequear('La fuente trae el mismo número de filas que COUNT(*) de pago', filas.length === Number(sumaOrigen.n), `${filas.length} filas`);

  const c1 = await cargar();
  chequear(`Carga inicial: ${original.conteo} documentos insertados, ninguno modificado`, c1.upserted === original.conteo && c1.modified === 0, `upserted=${c1.upserted}, modified=${c1.modified}, ${c1.ms.toFixed(0)} ms`);
  const r1 = await conciliar();
  chequear('Conciliación: mismo conteo', r1.conteo === original.conteo, `${r1.conteo} vs ${original.conteo}`);
  chequear('Conciliación: misma suma exacta de montos', r1.suma === original.suma, `${r1.suma} vs ${original.suma}`);
  chequear('Conciliación: misma huella SHA-256 de todas las filas', r1.huella === original.huella, r1.huella.slice(0, 16));

  const c2 = await cargar();
  chequear('Segunda carga: idempotente (0 insertados, 0 modificados)', c2.upserted === 0 && c2.modified === 0, `upserted=${c2.upserted}, modified=${c2.modified}`);
  chequear('Segunda carga: la huella no cambia', (await conciliar()).huella === original.huella);

  // Divergencia silenciosa: un monto alterado en el destino. El conteo no la ve; la suma y la huella sí.
  const victima = filas[Math.floor(filas.length / 2)];
  await col.updateOne({ legacy_id: victima.id }, { $set: { monto: Decimal128.fromString('9999.99') } });
  const rd = await conciliar();
  chequear('Divergencia de un monto: el conteo NO la detecta', rd.conteo === original.conteo);
  chequear('Divergencia de un monto: la suma y la huella SÍ la detectan', rd.suma !== original.suma && rd.huella !== original.huella);
  chequear('La comparación fila a fila identifica exactamente el pago alterado', rd.distintas?.length === 1 && rd.distintas[0] === victima.id, `legacy_id ${rd.distintas?.join(',')}`);
  await col.deleteOne({ legacy_id: filas[0].id });
  const rb = await conciliar();
  chequear('Borrado accidental de un documento: el conteo lo detecta', rb.conteo === original.conteo - 1);
  const c3 = await cargar();
  chequear('Reejecutar la carga repara ambas divergencias (1 insertado, 1 modificado)', c3.upserted === 1 && c3.modified === 1, `upserted=${c3.upserted}, modified=${c3.modified}`);
  const rf = await conciliar();
  chequear('Tras reparar, conteo, suma y huella vuelven a coincidir', rf.conteo === original.conteo && rf.suma === original.suma && rf.huella === original.huella);

  // Restricciones sobre datos reales: el índice único parcial ("un aprobado por compra") no rechazó ninguno.
  chequear('Los datos reales cumplen el índice único parcial "un pago aprobado por compra"', c1.upserted === original.conteo);

  const stats = await db.command({ collStats: 'pagos_migrados' });
  const porEstado = filas.reduce((a, r) => ({ ...a, [r.estado]: (a[r.estado] || 0) + 1 }), {});
  const fechas = filas.map((r) => r.fecha).sort();
  notas.push(`Fuente: ${original.conteo} pagos (estados: ${Object.entries(porEstado).map(([k, v]) => `${k} ${v}`).join(', ')}), Σ monto = ${original.suma}, del ${fechas[0].slice(0, 10)} al ${fechas[fechas.length - 1].slice(0, 10)}.`);
  notas.push(`Tamaño: tabla MySQL \`pago\` ≈ ${tam.kb} KB (datos + índices) vs colección Mongo ≈ ${(stats.storageSize / 1024).toFixed(1)} KB de almacenamiento + ${(stats.totalIndexSize / 1024).toFixed(1)} KB de índices (${stats.avgObjSize} B por documento).`);
  notas.push(`Huella de conciliación (SHA-256 de ${original.conteo} filas): ${original.huella}.`);

  return {
    titulo: 'E8 — Migración de los pagos reales (ensayo de la fase 1)',
    checks,
    tablas: [{ titulo: 'Cargas y conciliaciones', md: tabla(
      [{ clave: 'paso', titulo: 'Paso' }, { clave: 'res', titulo: 'Resultado' }],
      [
        { paso: 'Carga inicial', res: `${c1.upserted} insertados, ${c1.modified} modificados (${c1.ms.toFixed(0)} ms)` },
        { paso: 'Conciliación', res: `conteo ${r1.conteo}/${original.conteo}, Σ ${r1.suma}, huella ${r1.huella === original.huella ? 'igual' : 'DISTINTA'}` },
        { paso: 'Segunda carga', res: `${c2.upserted} insertados, ${c2.modified} modificados` },
        { paso: 'Monto alterado en destino', res: `conteo igual; Σ ${rd.suma} (esperada ${original.suma}); fila ${rd.distintas?.join(',')} identificada` },
        { paso: 'Documento borrado', res: `conteo ${rb.conteo}/${original.conteo}` },
        { paso: 'Reparación (tercera carga)', res: `${c3.upserted} insertado, ${c3.modified} modificado; huella ${rf.huella === original.huella ? 'igual' : 'DISTINTA'}` },
      ]) }],
    notas,
    datos: { original, c1, c2, c3, porEstado, kbMysql: Number(tam.kb), kbMongo: stats.storageSize / 1024, kbIndicesMongo: stats.totalIndexSize / 1024, avgObjSize: stats.avgObjSize },
  };
}

module.exports = { ejecutar };
