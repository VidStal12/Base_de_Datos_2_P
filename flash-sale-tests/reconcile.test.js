const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePurchases, createSnapshotReader, assessIntegrity, reconcile } = require('./reconcile');

function sale(id, changes = {}) {
  return { purchaseId: id, userRef: `buyer${id}`, channel: 'flash', paid: true, units: 1, detailIds: [id], ...changes };
}

function attempt(id, outcome = 'success', changes = {}) {
  return {
    attemptId: `attempt-${id}`, userRef: `buyer${id}`, channel: 'flash', quantity: 1, outcome,
    status: { success: 201, timeout: null, sold_out: 409, unexpected_error: 400 }[outcome],
    body: outcome === 'success' ? { compra: { id } } : null,
    ...changes,
  };
}

function inspect(snapshot, attempts = [], options = {}) {
  return assessIntegrity({ snapshot, attempts, initialInventory: 100, offerStock: 20, ...options });
}

const allPassed = result => result.invariants.every(item => item.passed);

function simulate(read, attempts = [], options = {}) {
  let clock = 0;
  return reconcile({
    initialInventory: 100, offerStock: 20, offerExpiresAt: 1000000, initialRedisMissing: true,
    timeoutMs: 40, stableForMs: 10, pollIntervalMs: 5, readTimeoutMs: 1000,
    readSnapshot: () => read(clock),
    attempts, now: () => clock, wait: async ms => { clock += ms; },
    ...options,
  });
}

test('13 respuestas exitosas, un timeout comprado y seis errores aprueban si las 14 unidades concilian', () => {
  const purchases = Array.from({ length: 14 }, (_, i) => sale(i + 1));
  const attempts = Array.from({ length: 100 }, (_, i) =>
    attempt(i + 1, i < 13 ? 'success' : i === 13 ? 'timeout' : i < 20 ? 'unexpected_error' : 'sold_out'));
  const result = inspect({ purchases, mysqlAfter: 86, redisRaw: '6' }, attempts);
  assert.equal(allPassed(result), true);
  assert.equal(result.units, 14);
  assert.equal(result.purchasesWithoutHttp201, 1);
  assert.deepEqual(result.uncertainWithPurchase, [{ attemptId: 'attempt-14', purchaseId: 14 }]);
});

test('21 ventas de oferta reprueban aunque todavía quede inventario MySQL positivo', () => {
  const purchases = Array.from({ length: 21 }, (_, i) => sale(i + 1));
  const result = inspect({ purchases, mysqlAfter: 79, redisRaw: '0' });
  assert.equal(result.hardViolation, true);
  assert.equal(result.invariants.find(item => item.name === 'Sin sobreventa del cupo de oferta').passed, false);
});

test('no se aprueba si MySQL descontó menos o más unidades que las guardadas', () => {
  for (const mysqlAfter of [100, 98]) {
    assert.equal(allPassed(inspect({ purchases: [sale(1)], mysqlAfter, redisRaw: '19' })), false);
  }
});

test('una reserva que no fue comprada ni devuelta reprueba por inconsistencia', () => {
  assert.equal(allPassed(inspect({ purchases: [sale(1)], mysqlAfter: 99, redisRaw: '18' })), false);
});

test('inventario negativo o contador Redis negativo nunca aprueban', () => {
  for (const values of [{ mysqlAfter: -1, redisRaw: '20' }, { mysqlAfter: 100, redisRaw: '-1' }]) {
    const result = inspect({ purchases: [], ...values });
    assert.equal(result.hardViolation, true);
    assert.equal(allPassed(result), false);
  }
});

test('HTTP 201 sin su pedido persistido reprueba aun con inventario intacto', () => {
  const result = inspect({ purchases: [], mysqlAfter: 100, redisRaw: '20' }, [attempt(1)]);
  assert.equal(allPassed(result), false);
});

test('compras sin pago aprobado o de compradores ajenos no se dan por conciliadas', () => {
  for (const changes of [{ paid: false }, { userRef: null }, { channel: null }]) {
    assert.equal(allPassed(inspect({ purchases: [sale(1, changes)], mysqlAfter: 99, redisRaw: '19' })), false);
  }
});

test('el checkout normal descuenta inventario pero no consume cupo flash', () => {
  const result = inspect({
    purchases: [sale(1, { units: 2 }), sale(2, { channel: 'checkout', units: 3 })],
    mysqlAfter: 95, redisRaw: '18',
  });
  assert.equal(allPassed(result), true);
  assert.equal(result.units, 5);
  assert.equal(result.flashUnits, 2);
});

test('varios pagos aprobados no duplican las unidades del mismo pedido', () => {
  const compra = {
    usuario: { correo: 'test@example.com' },
    pagos: [1, 2].map(() => ({ estado: 'aprobado', referencia_transaccion: 'TX-OFERTA-7-123' })),
  };
  const rows = [
    { id: 10, id_compra: 7, cantidad: 2, compra },
    { id: 11, id_compra: 7, cantidad: 3, compra },
  ];
  const purchases = normalizePurchases(rows, new Map([['test@example.com', 'buyer7']]));
  assert.equal(purchases.length, 1);
  assert.equal(purchases[0].units, 5);
  assert.equal(purchases[0].channel, 'flash');
});

test('el lector excluye los IDs históricos y usa un snapshot SQL consistente', async () => {
  let filter;
  const prisma = {
    inventario: { findUnique: () => Promise.resolve({ cantidad: 100 }) },
    compra_detalle: { findMany: ({ where }) => { filter = where; return Promise.resolve([]); } },
    $transaction: (reads, options) => {
      assert.equal(options.isolationLevel, 'RepeatableRead');
      return Promise.all(reads);
    },
  };
  const read = createSnapshotReader({ prisma, redis: { get: async () => null }, productId: 5,
    baselineDetailIds: [7, 9], buyerRefsByEmail: new Map() });
  assert.deepEqual(await read(), { mysqlAfter: 100, redisRaw: null, purchases: [] });
  assert.deepEqual(filter, { id_producto: 5, id: { notIn: [7, 9] } });
});

test('espera una compra tardía en lugar de comparar solo contra las respuestas HTTP', async () => {
  const result = await simulate(clock => clock < 15
    ? { purchases: [sale(1)], mysqlAfter: 99, redisRaw: '18' }
    : { purchases: [sale(1), sale(2)], mysqlAfter: 98, redisRaw: '18' }, [attempt(1), attempt(2, 'timeout')]);
  assert.equal(result.passed, true);
  assert.ok(result.durationMs >= 25);
  assert.equal(result.assessment.units, 2);
});

test('un timeout sin compra observada espera toda la ventana y puede aprobar con inventario intacto', async () => {
  const result = await simulate(() => ({ purchases: [], mysqlAfter: 100, redisRaw: null }), [attempt(1, 'timeout')]);
  assert.equal(result.passed, true);
  assert.equal(result.durationMs, 40);
  assert.equal(result.reason, 'observation_window_elapsed');
  assert.deepEqual(result.assessment.uncertainWithoutPurchase, ['attempt-1']);
});

test('una misma compra no resuelve dos solicitudes con timeout', async () => {
  const result = await simulate(() => ({ purchases: [sale(1)], mysqlAfter: 99, redisRaw: '19' }), [
    attempt(1, 'timeout'), attempt(2, 'timeout', { userRef: 'buyer1' }),
  ]);
  assert.equal(result.durationMs, 40);
  assert.equal(result.assessment.uncertainWithPurchase.length, 1);
  assert.equal(result.assessment.uncertainWithoutPurchase.length, 1);
});

test('una clave Redis ausente es válida solo antes de admitir compras y con oferta vigente', async () => {
  const snapshot = { purchases: [], mysqlAfter: 100, redisRaw: null };
  assert.equal((await simulate(() => snapshot)).passed, true);
  assert.equal((await simulate(() => snapshot, [], { initialRedisMissing: false })).passed, false);
  assert.equal((await simulate(() => snapshot, [], { offerExpiresAt: -1 })).passed, false);
  assert.equal((await simulate(() => ({ purchases: [sale(1)], mysqlAfter: 99, redisRaw: null }))).passed, false);
});

test('una clave que desaparece durante la observación no se interpreta como cupo intacto', async () => {
  const result = await simulate(clock => ({ purchases: [], mysqlAfter: 100, redisRaw: clock < 5 ? '20' : null }));
  assert.equal(result.passed, false);
});

test('una sobreventa observada no queda oculta aunque después se reponga el inventario', async () => {
  const result = await simulate(clock => clock < 5
    ? { purchases: [], mysqlAfter: -1, redisRaw: '-1' }
    : { purchases: [], mysqlAfter: 100, redisRaw: '20' });
  assert.equal(result.passed, false);
  assert.equal(result.completed, true);
});

test('si no se pueden leer las bases, la conciliación reprueba', async () => {
  const result = await simulate(() => { throw new Error('MySQL no disponible'); });
  assert.equal(result.passed, false);
  assert.equal(result.completed, false);
  assert.ok(result.readErrors.length > 0);
});

test('una lectura bloqueada termina sin aprobar ni acumular nuevas consultas', async () => {
  let reads = 0;
  const result = await simulate(() => { reads++; return new Promise(() => {}); }, [], { readTimeoutMs: 5 });
  assert.equal(result.passed, false);
  assert.equal(result.reason, 'read_timeout');
  assert.equal(reads, 1);
});

test('un cambio al final de la ventana exige estabilidad antes de aprobar', async () => {
  const result = await simulate(clock => ({ purchases: [], mysqlAfter: clock, redisRaw: '20' }), [attempt(1, 'timeout')]);
  assert.equal(result.completed, false);
  assert.equal(result.passed, false);
});

test('rechaza una ventana que no permite comprobar estabilidad', async () => {
  await assert.rejects(simulate(() => ({}), [], { stableForMs: 40 }), /stableForMs/);
});
