// E2 — Idempotencia: la clave única es lo que vuelve seguro reintentar un pago.
// Se prueba en Mongo (índice único + índice único parcial) y, para no atribuirle
// a Mongo algo que MySQL también hace, el equivalente en MySQL (UNIQUE + columna generada).
const { randomUUID } = require('node:crypto');
const { Decimal128 } = require('mongodb');
const { nuevoRegistro, tabla } = require('./util');

const duplicadoMongo = (err) => err?.code === 11000;
const duplicadoMysql = (err) => err?.errno === 1062;

async function codigoDeError(fn) {
  // MySQL: errno numérico (1062); Mongo: code numérico (11000). Se prefiere el número a la etiqueta.
  try { await fn(); return null; } catch (err) { return err.errno ?? err.code ?? err.name; }
}

async function ejecutar({ db, my }, { rapido }) {
  const { checks, chequear } = nuevoRegistro();
  const notas = [];
  const RONDAS = rapido ? 5 : 20;
  const PARALELO = 50;
  const monto = () => Decimal128.fromString('10.00');

  async function coleccion(nombre) {
    const c = await db.createCollection(nombre);
    await c.createIndex({ intento_id: 1 }, { unique: true, name: 'uq_intento' });
    // "Un solo pago APROBADO por compra": único parcial, así anulados y reembolsos no chocan.
    await c.createIndex({ compra_id: 1 }, { unique: true, name: 'uq_compra_aprobada', partialFilterExpression: { estado: 'aprobado' } });
    return c;
  }

  // --- Mongo A: N inserciones simultáneas con el MISMO intento, varias rondas.
  const a = await coleccion('e2_simultaneas');
  let exitos = 0; let dups = 0; let otros = 0;
  for (let r = 0; r < RONDAS; r++) {
    const intento = randomUUID();
    const res = await Promise.allSettled(Array.from({ length: PARALELO }, () =>
      a.insertOne({ intento_id: intento, usuario_id: 1, monto: monto(), estado: 'autorizado' })));
    for (const x of res) {
      if (x.status === 'fulfilled') exitos++; else if (duplicadoMongo(x.reason)) dups++; else otros++;
    }
  }
  chequear(`Mongo: ${RONDAS} rondas × ${PARALELO} inserciones simultáneas del mismo intento → 1 éxito por ronda`,
    exitos === RONDAS && dups === RONDAS * (PARALELO - 1) && otros === 0, `${exitos} éxitos, ${dups} E11000, ${otros} otros`);
  chequear('Mongo: queda un solo documento por intento', (await a.countDocuments({})) === RONDAS);

  // --- Mongo B: upsert simultáneo (patrón alternativo a insert + capturar E11000).
  const b = await coleccion('e2_upsert');
  const intentoU = randomUUID();
  const upserts = await Promise.allSettled(Array.from({ length: PARALELO }, () =>
    b.updateOne({ intento_id: intentoU }, { $setOnInsert: { usuario_id: 1, monto: monto(), estado: 'autorizado' } }, { upsert: true })));
  const insertaron = upserts.filter((x) => x.status === 'fulfilled' && x.value.upsertedCount === 1).length;
  const dupVisible = upserts.filter((x) => x.status === 'rejected' && duplicadoMongo(x.reason)).length;
  const otrosU = upserts.filter((x) => x.status === 'rejected' && !duplicadoMongo(x.reason)).length;
  chequear('Mongo: upsert simultáneo deja exactamente un documento', (await b.countDocuments({ intento_id: intentoU })) === 1);
  chequear('Mongo: upsert simultáneo no produce errores distintos de E11000', otrosU === 0);
  notas.push(`Upsert ×${PARALELO} sobre la misma clave: ${insertaron} lo insertó, ${dupVisible} E11000 visibles para el cliente, ${otrosU} otros errores.`);

  // --- Mongo C: único parcial "un aprobado por compra".
  const c = await coleccion('e2_parcial');
  const nuevo = (extra) => c.insertOne({ intento_id: randomUUID(), usuario_id: 1, monto: monto(), ...extra });
  await nuevo({ compra_id: 7, estado: 'aprobado' });
  chequear('Mongo: segundo pago APROBADO de la misma compra → E11000', (await codigoDeError(() => nuevo({ compra_id: 7, estado: 'aprobado' }))) === 11000);
  chequear('Mongo: un pago ANULADO de esa compra sí se admite', (await codigoDeError(() => nuevo({ compra_id: 7, estado: 'anulado' }))) === null);
  chequear('Mongo: un APROBADO de otra compra sí se admite', (await codigoDeError(() => nuevo({ compra_id: 8, estado: 'aprobado' }))) === null);

  // --- Mongo D: respuesta perdida. El servidor escribió pero el cliente no lo supo; el reintento
  // choca con la clave única y se trata como ÉXITO (devuelve el documento original).
  const d = await coleccion('e2_ack_perdido');
  async function registrarIdempotente(datos, { perderRespuestaUnaVez }) {
    let perdida = false;
    const intentar = async () => {
      try {
        const r = await d.insertOne({ ...datos }); // copia: insertOne agrega _id al objeto recibido
        if (perderRespuestaUnaVez && !perdida) {
          perdida = true;
          throw new Error('ECONNRESET simulado: el servidor escribió, el cliente no vio la respuesta');
        }
        return { reutilizado: false, id: r.insertedId };
      } catch (err) {
        if (!duplicadoMongo(err)) throw err;
        return { reutilizado: true, id: (await d.findOne({ intento_id: datos.intento_id }))._id };
      }
    };
    for (let i = 0; ; i++) {
      try { return await intentar(); } catch (err) { if (i >= 2) throw err; }
    }
  }
  const resultado = await registrarIdempotente({ intento_id: randomUUID(), usuario_id: 1, monto: monto(), estado: 'autorizado' },
    { perderRespuestaUnaVez: true });
  chequear('Mongo: tras perder la respuesta, el reintento devuelve el documento original (reutilizado)', resultado.reutilizado === true);
  chequear('Mongo: la respuesta perdida no duplica el pago', (await d.countDocuments({})) === 1);

  // --- MySQL: el equivalente. UNIQUE sobre la clave de idempotencia + UNIQUE sobre una columna
  // generada que solo vale algo cuando el pago está aprobado (los NULL no chocan entre sí).
  await my.query(`CREATE TABLE e2_pago (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, id_compra INT NOT NULL, intento_id CHAR(36) NULL,
    estado VARCHAR(191) NOT NULL, monto DECIMAL(10,2) NOT NULL,
    compra_aprobada INT GENERATED ALWAYS AS (IF(estado = 'aprobado', id_compra, NULL)) STORED,
    UNIQUE KEY uq_intento (intento_id), UNIQUE KEY uq_compra_aprobada (compra_aprobada)) ENGINE=InnoDB`);
  const insertarMysql = (extra) => my.query(
    'INSERT INTO e2_pago (id_compra, intento_id, estado, monto) VALUES (?, ?, ?, ?)',
    [extra.compra, extra.intento ?? randomUUID(), extra.estado, '10.00']);
  let exitosMy = 0; let dupsMy = 0; let otrosMy = 0;
  for (let r = 0; r < RONDAS; r++) {
    const intento = randomUUID();
    const res = await Promise.allSettled(Array.from({ length: PARALELO }, () => insertarMysql({ compra: 1000 + r, intento, estado: 'autorizado' })));
    for (const x of res) {
      if (x.status === 'fulfilled') exitosMy++; else if (duplicadoMysql(x.reason)) dupsMy++; else otrosMy++;
    }
  }
  chequear(`MySQL: ${RONDAS} rondas × ${PARALELO} inserciones simultáneas del mismo intento → 1 éxito por ronda`,
    exitosMy === RONDAS && dupsMy === RONDAS * (PARALELO - 1) && otrosMy === 0, `${exitosMy} éxitos, ${dupsMy} ER_DUP_ENTRY, ${otrosMy} otros`);
  await insertarMysql({ compra: 7, estado: 'aprobado' });
  chequear('MySQL: segundo pago APROBADO de la misma compra → ER_DUP_ENTRY (1062)', (await codigoDeError(() => insertarMysql({ compra: 7, estado: 'aprobado' }))) === 1062);
  chequear('MySQL: un pago ANULADO de esa compra sí se admite', (await codigoDeError(() => insertarMysql({ compra: 7, estado: 'anulado' }))) === null);

  // --- Integridad referencial: aquí la diferencia SÍ es estructural. MySQL la impone con claves foráneas
  // (hoy: pago→compra y pago→metodo_pago, ambas RESTRICT); Mongo no tiene FK, así que la integridad pasa a ser
  // responsabilidad del código (en la saga, de los invariantes y del barrido de E5).
  await my.query('CREATE TABLE e2_compra (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY) ENGINE=InnoDB');
  await my.query(`CREATE TABLE e2_pago_fk (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, id_compra INT NOT NULL,
    CONSTRAINT e2_fk FOREIGN KEY (id_compra) REFERENCES e2_compra (id) ON DELETE RESTRICT) ENGINE=InnoDB`);
  const compra = await my.query('INSERT INTO e2_compra () VALUES ()');
  chequear('MySQL: un pago con id_compra inexistente se rechaza (FK, error 1452)',
    (await codigoDeError(() => my.query('INSERT INTO e2_pago_fk (id_compra) VALUES (?)', [999999]))) === 1452);
  await my.query('INSERT INTO e2_pago_fk (id_compra) VALUES (?)', [compra.insertId]);
  chequear('MySQL: no se puede borrar una compra que ya tiene pagos (RESTRICT, error 1451)',
    (await codigoDeError(() => my.query('DELETE FROM e2_compra WHERE id = ?', [compra.insertId]))) === 1451);
  chequear('Mongo: un pago con compra_id inexistente SE ACEPTA (no hay claves foráneas: la integridad pasa a ser del código)',
    (await codigoDeError(() => c.insertOne({ intento_id: randomUUID(), usuario_id: 1, monto: monto(), estado: 'aprobado', compra_id: 999999 }))) === null);
  const compraMongo = await db.collection('e2_compras').insertOne({ n: 1 });
  await c.insertOne({ intento_id: randomUUID(), usuario_id: 1, monto: monto(), estado: 'anulado', compra_ref: compraMongo.insertedId });
  chequear('Mongo: borrar la compra a la que apunta un pago no se impide (no hay RESTRICT)',
    (await db.collection('e2_compras').deleteOne({ _id: compraMongo.insertedId })).deletedCount === 1);

  const filas = [
    { m: 'Clave de idempotencia única, 50 escrituras simultáneas', mongo: `${exitos / RONDAS} éxito por ronda (${dups} E11000)`, mysql: `${exitosMy / RONDAS} éxito por ronda (${dupsMy} ER_DUP_ENTRY)` },
    { m: '"Un aprobado por compra"', mongo: 'índice único parcial', mysql: 'UNIQUE sobre columna generada' },
    { m: 'Anulado/reembolso de la misma compra', mongo: 'admitido', mysql: 'admitido' },
    { m: 'Pago con compra inexistente / borrar una compra con pagos', mongo: 'se acepta / se permite (sin FK)', mysql: 'rechazado 1452 / rechazado 1451 (FK RESTRICT)' },
    { m: 'Requiere cambio de esquema hoy', mongo: 'colección nueva', mysql: 'ALTER TABLE pago (columna + 2 UNIQUE)' },
  ];
  return {
    titulo: 'E2 — Idempotencia',
    checks,
    tablas: [{ titulo: 'Idempotencia: Mongo vs MySQL', md: tabla(
      [{ clave: 'm', titulo: 'Mecanismo' }, { clave: 'mongo', titulo: 'MongoDB 7.0' }, { clave: 'mysql', titulo: 'MySQL 8.4' }], filas) }],
    notas,
    datos: { RONDAS, PARALELO, mongo: { exitos, dups, otros, insertaron, dupVisible }, mysql: { exitosMy, dupsMy, otrosMy } },
  };
}

module.exports = { ejecutar };
