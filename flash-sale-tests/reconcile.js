const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(name, expected, actual, passed) {
  return { name, expected, actual, passed };
}

function normalizePurchases(details, buyerRefsByEmail) {
  const purchases = new Map();
  for (const detail of details) {
    let purchase = purchases.get(detail.id_compra);
    if (!purchase) {
      const payments = detail.compra.pagos.filter((payment) => payment.estado === 'aprobado');
      const references = payments.map((payment) => payment.referencia_transaccion || '');
      const channel = references.some((reference) => reference.startsWith('TX-OFERTA-'))
        ? 'flash'
        : references.some((reference) => /^TX-\d+-/.test(reference)) ? 'checkout' : null;
      purchase = {
        purchaseId: detail.id_compra,
        userRef: buyerRefsByEmail.get(detail.compra.usuario.correo) || null,
        channel,
        paid: payments.length > 0,
        units: 0,
        detailIds: [],
      };
      purchases.set(detail.id_compra, purchase);
    }
    purchase.units += detail.cantidad;
    purchase.detailIds.push(detail.id);
  }
  return [...purchases.values()].sort((a, b) => a.purchaseId - b.purchaseId);
}

// MySQL se lee en un único snapshot. La lista de IDs anterior a la ráfaga
// excluye el historial sin depender del reloj ni del orden de los commits.
function createSnapshotReader({ prisma, redis, productId, baselineDetailIds, buyerRefsByEmail }) {
  return async () => {
    const [inventory, details] = await prisma.$transaction([
      prisma.inventario.findUnique({ where: { id_producto: productId }, select: { cantidad: true } }),
      prisma.compra_detalle.findMany({
        where: { id_producto: productId, id: { notIn: baselineDetailIds } },
        select: {
          id: true, id_compra: true, cantidad: true,
          compra: { select: {
            usuario: { select: { correo: true } },
            pagos: { select: { estado: true, referencia_transaccion: true } },
          } },
        },
        orderBy: { id: 'asc' },
      }),
    ], { isolationLevel: 'RepeatableRead' });
    if (!inventory) throw new Error(`No existe inventario para el producto ${productId}`);
    const redisRaw = await redis.get(`oferta:${productId}:stock`);
    return {
      mysqlAfter: inventory.cantidad,
      redisRaw,
      purchases: normalizePurchases(details, buyerRefsByEmail),
    };
  };
}

function assessIntegrity({ snapshot, attempts, initialInventory, offerStock, allowMissingRedis = false }) {
  const purchases = snapshot.purchases;
  const units = purchases.reduce((total, purchase) => total + purchase.units, 0);
  const flashUnits = purchases.filter((purchase) => purchase.channel === 'flash')
    .reduce((total, purchase) => total + purchase.units, 0);
  // Redis inicializa el contador al admitir la primera compra. Una clave que
  // ya existía y desaparece, o que falta después de vender, no equivale a stock.
  const redisRemaining = snapshot.redisRaw === null
    ? allowMissingRedis && flashUnits === 0 ? offerStock : null
    : Number(snapshot.redisRaw);
  const mysqlDelta = initialInventory - snapshot.mysqlAfter;
  const acknowledged = attempts.filter((attempt) => attempt.outcome === 'success');
  const acknowledgedIds = new Set(acknowledged.map((attempt) => attempt.body?.compra?.id));
  const unacknowledged = purchases.filter((purchase) => !acknowledgedIds.has(purchase.purchaseId));
  const available = [...unacknowledged];
  const uncertain = attempts.filter((attempt) => attempt.outcome === 'timeout' || attempt.status === null);
  const uncertainWithPurchase = [];
  const uncertainWithoutPurchase = [];
  // Cada pedido solo puede resolver un intento. Con intentos iguales de un
  // mismo comprador la asociación es por cantidad/canal, no por request ID.
  for (const attempt of uncertain) {
    const index = available.findIndex((purchase) => purchase.userRef === attempt.userRef
      && purchase.channel === (attempt.channel || 'flash') && purchase.units === attempt.quantity && purchase.paid);
    if (index >= 0) {
      uncertainWithPurchase.push({ attemptId: attempt.attemptId, purchaseId: available[index].purchaseId });
      available.splice(index, 1);
    } else {
      uncertainWithoutPurchase.push(attempt.attemptId);
    }
  }
  const acknowledgedPresent = acknowledged.every((attempt) => purchases.some((purchase) =>
    purchase.purchaseId === attempt.body?.compra?.id && purchase.userRef === attempt.userRef
    && purchase.channel === (attempt.channel || 'flash') && purchase.units === attempt.quantity && purchase.paid));
  const validPurchases = purchases.every((purchase) => purchase.paid && purchase.userRef !== null
    && ['flash', 'checkout'].includes(purchase.channel) && Number.isInteger(purchase.units) && purchase.units > 0);
  const invariants = [
    check('Compras persistidas identificadas y con pago aprobado', true, validPurchases, validPurchases),
    check('Sin sobreventa del cupo de oferta', `<= ${offerStock}`, flashUnits, flashUnits <= offerStock),
    check('Sin sobreventa del inventario real', `<= ${initialInventory}`, units, units <= initialInventory),
    check('Inventario MySQL no negativo', '>= 0', snapshot.mysqlAfter, snapshot.mysqlAfter >= 0),
    check('Descuento MySQL coincide con unidades persistidas', units, mysqlDelta, mysqlDelta === units),
    check('Contador Redis dentro del cupo', `0..${offerStock}`, redisRemaining,
      Number.isInteger(redisRemaining) && redisRemaining >= 0 && redisRemaining <= offerStock),
    check('Redis coincide con las unidades flash persistidas', offerStock - flashUnits,
      redisRemaining, redisRemaining !== null && redisRemaining === offerStock - flashUnits),
    check('Respuestas HTTP 201 respaldadas por compras persistidas', true, acknowledgedPresent, acknowledgedPresent),
  ];
  return {
    invariants, units, flashUnits, mysqlDelta, redisRemaining,
    purchaseCount: purchases.length,
    purchasesWithoutHttp201: unacknowledged.length,
    uncertainWithPurchase, uncertainWithoutPurchase,
    hardViolation: flashUnits > offerStock || units > initialInventory || snapshot.mysqlAfter < 0
      || (redisRemaining !== null && redisRemaining < 0),
  };
}

async function readWithin(readSnapshot, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(readSnapshot),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`La lectura de conciliación excedió ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function reconcile({ readSnapshot, attempts, initialInventory, offerStock, offerExpiresAt,
  initialRedisMissing, timeoutMs = 30000, pollIntervalMs = 500, stableForMs = 2000,
  readTimeoutMs = 5000, now = Date.now, wait = sleep }) {
  for (const [name, value] of Object.entries({ timeoutMs, pollIntervalMs, stableForMs, readTimeoutMs })) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} de conciliación debe ser un entero positivo`);
  }
  if (stableForMs >= timeoutMs) throw new Error('stableForMs debe ser menor que timeoutMs');
  const started = now();
  const deadline = started + timeoutMs;
  let signature;
  let stableSince = started;
  let snapshot = null;
  let assessment = null;
  let redisSeen = !initialRedisMissing;
  let observedViolation = false;
  let lastReadOk = false;
  let completed = false;
  let reason = 'observation_window_elapsed';
  const samples = [];
  const readErrors = [];

  while (now() < deadline) {
    try {
      snapshot = await readWithin(readSnapshot, Math.min(readTimeoutMs, deadline - now()));
      lastReadOk = true;
      redisSeen ||= snapshot.redisRaw !== null;
      const offerActive = Number.isFinite(offerExpiresAt) && now() < offerExpiresAt;
      assessment = assessIntegrity({ snapshot, attempts, initialInventory, offerStock,
        allowMissingRedis: !redisSeen && offerActive });
      observedViolation ||= assessment.hardViolation;
      const nextSignature = JSON.stringify(snapshot);
      if (nextSignature !== signature) {
        signature = nextSignature;
        stableSince = now();
      }
      samples.push({ at: new Date(now()).toISOString(), mysqlAfter: snapshot.mysqlAfter,
        redisRemaining: assessment.redisRemaining, redisKeyExists: snapshot.redisRaw !== null,
        purchaseIds: snapshot.purchases.map((purchase) => purchase.purchaseId),
        units: assessment.units, flashUnits: assessment.flashUnits });
      if (now() - stableSince >= stableForMs && assessment.uncertainWithoutPurchase.length === 0) {
        completed = true;
        reason = 'stable_with_no_unresolved_requests';
        break;
      }
    } catch (error) {
      lastReadOk = false;
      signature = undefined;
      stableSince = now();
      readErrors.push({ at: new Date(now()).toISOString(), error: error.message });
      // Evita acumular nuevas consultas si una lectura sigue bloqueada.
      if (error.message.startsWith('La lectura de conciliación excedió')) {
        reason = 'read_timeout';
        break;
      }
    }
    const remaining = deadline - now();
    if (remaining > 0) await wait(Math.min(pollIntervalMs, remaining));
  }
  if (!completed && reason === 'observation_window_elapsed') {
    // Un timeout sin pedido se observa durante TODA la ventana. No se declara
    // cancelado: solo se informa que no apareció una compra en ese intervalo.
    completed = lastReadOk && now() - stableSince >= stableForMs;
  }
  const invariants = [
    check('Conciliación con lecturas estables', true, completed, completed),
    check('Sin sobreventa ni stock negativo durante la observación', false, observedViolation, !observedViolation),
    ...(assessment?.invariants || [check('Datos de MySQL y Redis disponibles', true, false, false)]),
  ];
  return {
    completed, reason, durationMs: now() - started,
    policy: { timeoutMs, pollIntervalMs, stableForMs, readTimeoutMs },
    readErrors, samples, snapshot, assessment, invariants,
    passed: invariants.every((item) => item.passed),
  };
}

module.exports = { normalizePurchases, createSnapshotReader, assessIntegrity, reconcile };
