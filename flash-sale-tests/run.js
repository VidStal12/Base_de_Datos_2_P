const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createSnapshotReader, reconcile } = require('./reconcile');

const testsDir = __dirname;
const projectRoot = path.resolve(testsDir, '..');
const preparedStatePath = path.join(testsDir, 'prepared-state.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

async function httpJson(baseUrl, pathname, { method = 'GET', token, body, timeoutMs = 5000 } = {}) {
  const startedAt = new Date();
  const started = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const rawBody = await response.text();
    let responseBody = null;
    try {
      responseBody = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      responseBody = rawBody;
    }

    return {
      ok: response.ok,
      status: response.status,
      body: responseBody,
      error: null,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      latencyMs: Math.round((performance.now() - started) * 100) / 100,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      body: null,
      error: error.name === 'AbortError' ? `timeout después de ${timeoutMs}ms` : error.message,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      latencyMs: Math.round((performance.now() - started) * 100) / 100,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function requireHttp(result, description, acceptedStatuses = [200, 201]) {
  if (!acceptedStatuses.includes(result.status)) {
    const detail = result.body?.error || result.error || JSON.stringify(result.body);
    throw new Error(`${description}: HTTP ${result.status ?? 'sin respuesta'} - ${detail}`);
  }
  return result.body;
}

async function login(baseUrl, account, timeoutMs) {
  return httpJson(baseUrl, '/auth/login', {
    method: 'POST',
    timeoutMs,
    body: { correo: account.email, contrasena: account.password },
  });
}

async function provisionBuyer(baseUrl, buyer, timeoutMs) {
  let loginResult = await login(baseUrl, buyer, timeoutMs);

  if (loginResult.status === 401) {
    const registration = await httpJson(baseUrl, '/auth/registro', {
      method: 'POST',
      timeoutMs,
      body: {
        nombres: buyer.profile.nombres,
        apellidos: buyer.profile.apellidos,
        correo: buyer.email,
        contrasena: buyer.password,
        fecha_nacimiento: buyer.profile.fecha_nacimiento,
      },
    });
    requireHttp(registration, `No se pudo registrar ${buyer.ref}`, [201]);
    loginResult = await login(baseUrl, buyer, timeoutMs);
  }

  const { token } = requireHttp(loginResult, `No se pudo iniciar sesión con ${buyer.ref}`, [200]);

  const addressesResult = await httpJson(baseUrl, '/direcciones', { token, timeoutMs });
  let addresses = requireHttp(addressesResult, `No se pudieron consultar las direcciones de ${buyer.ref}`, [200]);
  if (addresses.length === 0) {
    const created = await httpJson(baseUrl, '/direcciones', {
      method: 'POST',
      token,
      timeoutMs,
      body: buyer.address,
    });
    addresses = [requireHttp(created, `No se pudo crear la dirección de ${buyer.ref}`, [201])];
  }

  const paymentsResult = await httpJson(baseUrl, '/metodos-pago', { token, timeoutMs });
  let payments = requireHttp(paymentsResult, `No se pudieron consultar los métodos de pago de ${buyer.ref}`, [200]);
  if (payments.length === 0) {
    const created = await httpJson(baseUrl, '/metodos-pago', {
      method: 'POST',
      token,
      timeoutMs,
      body: buyer.payment,
    });
    payments = [requireHttp(created, `No se pudo crear el método de pago de ${buyer.ref}`, [201])];
  }

  return {
    ref: buyer.ref,
    token,
    addressId: addresses[0].id,
    paymentMethodId: payments[0].id,
  };
}

async function loadPreparedBuyer(baseUrl, buyer, timeoutMs) {
  const loginResult = await login(baseUrl, buyer, timeoutMs);
  const { token } = requireHttp(
    loginResult,
    `No se pudo iniciar sesión con ${buyer.ref}; ejecutá primero prepare.js`,
    [200]
  );

  const addressesResult = await httpJson(baseUrl, '/direcciones', { token, timeoutMs });
  const addresses = requireHttp(addressesResult, `No se pudieron consultar las direcciones de ${buyer.ref}`, [200]);
  const paymentsResult = await httpJson(baseUrl, '/metodos-pago', { token, timeoutMs });
  const payments = requireHttp(paymentsResult, `No se pudieron consultar los métodos de pago de ${buyer.ref}`, [200]);

  if (addresses.length === 0 || payments.length === 0) {
    throw new Error(`${buyer.ref} no está preparado; ejecutá primero node .\\flash-sale-tests\\prepare.js`);
  }

  return {
    ref: buyer.ref,
    token,
    addressId: addresses[0].id,
    paymentMethodId: payments[0].id,
  };
}

async function resolveTestProduct(baseUrl, scenario, sellerToken, timeoutMs) {
  const spec = scenario.prepare.product;
  if (!spec) {
    if (!Number.isInteger(scenario.productId) || scenario.productId <= 0) {
      throw new Error('El escenario necesita productId o prepare.product');
    }
    const existing = await httpJson(baseUrl, `/productos/${scenario.productId}`, { timeoutMs });
    requireHttp(existing, `No se pudo consultar el producto ${scenario.productId}`, [200]);
    return scenario.productId;
  }

  const productsResult = await httpJson(baseUrl, `/productos?q=${encodeURIComponent(spec.description)}`, {
    token: sellerToken,
    timeoutMs,
  });
  const products = requireHttp(productsResult, 'No se pudo buscar el producto sintético', [200]);
  const existingProduct = products.find((product) => product.descripcion === spec.description);
  if (existingProduct) return existingProduct.id;

  const categoriesResult = await httpJson(baseUrl, '/categorias', { timeoutMs });
  const categories = requireHttp(categoriesResult, 'No se pudieron consultar las categorías', [200]);
  let category = categories.find((item) => item.categoria === spec.category);

  if (!category) {
    const created = await httpJson(baseUrl, '/categorias', {
      method: 'POST',
      token: sellerToken,
      timeoutMs,
      body: { categoria: spec.category },
    });
    category = { ...requireHttp(created, 'No se pudo crear la categoría sintética', [201]), subcategorias: [] };
  }

  let subcategory = category.subcategorias?.find((item) => item.subcategoria === spec.subcategory);
  if (!subcategory) {
    const created = await httpJson(baseUrl, `/categorias/${category.id}/subcategorias`, {
      method: 'POST',
      token: sellerToken,
      timeoutMs,
      body: { subcategoria: spec.subcategory },
    });
    subcategory = requireHttp(created, 'No se pudo crear la subcategoría sintética', [201]);
  }

  const createdProduct = await httpJson(baseUrl, '/productos', {
    method: 'POST',
    token: sellerToken,
    timeoutMs,
    body: {
      descripcion: spec.description,
      estado: 'activo',
      subcategoriaId: subcategory.id,
      precio: spec.normalPrice,
      cantidad: scenario.prepare.initialInventory,
      atributos: [],
    },
  });
  const product = requireHttp(createdProduct, 'No se pudo crear el producto sintético', [201]);
  return product.id;
}

async function prepareScenario(baseUrl, scenario, sellerToken, timeoutMs) {
  const productResult = await httpJson(baseUrl, `/productos/${scenario.productId}`, { timeoutMs });
  const product = requireHttp(productResult, `No se pudo consultar el producto ${scenario.productId}`, [200]);

  if (scenario.prepare.resetInventory) {
    const resetResult = await httpJson(baseUrl, `/productos/${scenario.productId}`, {
      method: 'PATCH',
      token: sellerToken,
      timeoutMs,
      body: { cantidad: scenario.prepare.initialInventory },
    });
    requireHttp(resetResult, `No se pudo restaurar el inventario del producto ${scenario.productId}`, [200]);
  }

  const now = Date.now();
  const offerResult = await httpJson(baseUrl, `/ofertas/${scenario.productId}`, {
    method: 'PATCH',
    token: sellerToken,
    timeoutMs,
    body: {
      activo: true,
      precio_oferta: scenario.prepare.offerPrice,
      stock_oferta: scenario.prepare.offerStock,
      vigente_desde: new Date(now - 5000).toISOString(),
      vigente_hasta: new Date(now + scenario.prepare.offerDurationSeconds * 1000).toISOString(),
    },
  });
  requireHttp(offerResult, `No se pudo configurar la oferta del producto ${scenario.productId}`, [200]);

  const stockResult = await httpJson(baseUrl, `/ofertas/${scenario.productId}/stock`, { timeoutMs });
  const liveOffer = requireHttp(stockResult, 'No se pudo consultar el stock inicial de la oferta', [200]);
  if (!liveOffer.activo || liveOffer.restante !== scenario.prepare.offerStock) {
    throw new Error(
      `La oferta no quedó preparada correctamente: restante=${liveOffer.restante}, esperado=${scenario.prepare.offerStock}`
    );
  }

  return { product, liveOffer };
}

function classifyAttempt(result) {
  if (result.status === 201) return 'success';
  if (result.status === 409 && /no quedan unidades en oferta/i.test(result.body?.error || '')) return 'sold_out';
  if (result.error?.startsWith('timeout')) return 'timeout';
  return 'unexpected_error';
}

async function executeAttempt(baseUrl, scenario, attempt, buyer, commonStart) {
  const scheduledAtMs = commonStart + attempt.delayMs;
  await sleep(scheduledAtMs - Date.now());
  const actualStartMs = Date.now();

  const isNormalCheckout = attempt.channel === 'checkout';
  const pathname = isNormalCheckout ? '/checkout' : `/ofertas/${scenario.productId}/comprar`;
  const body = isNormalCheckout
    ? {
        direccionId: buyer.addressId,
        metodoPagoId: buyer.paymentMethodId,
        items: [{ productoId: scenario.productId, cantidad: attempt.quantity }],
      }
    : {
        cantidad: attempt.quantity,
        direccionId: buyer.addressId,
        metodoPagoId: buyer.paymentMethodId,
      };

  const result = await httpJson(baseUrl, pathname, {
    method: 'POST',
    token: buyer.token,
    body,
    timeoutMs: scenario.requestTimeoutMs,
  });

  return {
    attemptId: attempt.id,
    userRef: attempt.userRef,
    channel: attempt.channel || 'flash',
    quantity: attempt.quantity,
    delayMs: attempt.delayMs,
    scheduledAt: new Date(scheduledAtMs).toISOString(),
    actualStartAt: new Date(actualStartMs).toISOString(),
    schedulingDriftMs: actualStartMs - scheduledAtMs,
    ...result,
    outcome: classifyAttempt(result),
  };
}

async function probeApplication(baseUrl, scenario, stopState, results) {
  while (!stopState.stop) {
    const [health, offerStock] = await Promise.all([
      httpJson(baseUrl, '/health', { timeoutMs: scenario.probes.timeoutMs }),
      httpJson(baseUrl, `/ofertas/${scenario.productId}/stock`, { timeoutMs: scenario.probes.timeoutMs }),
    ]);
    results.push({ at: new Date().toISOString(), health, offerStock });
    await sleep(scenario.probes.intervalMs);
  }
}

function invariant(name, expected, actual, passed) {
  return { name, expected, actual, passed };
}

async function main() {
  const prepareOnly = process.argv.includes('--prepare-only');
  const scenarioArg = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
  const scenarioPath = scenarioArg
    ? path.resolve(process.cwd(), scenarioArg)
    : path.join(testsDir, 'scenarios', 'combined.json');
  const scenario = readJson(scenarioPath);
  const usersPath = path.resolve(path.dirname(scenarioPath), scenario.usersFile);
  const accounts = readJson(usersPath);
  const baseUrl = scenario.baseUrl.replace(/\/$/, '');

  const dotenv = require(path.join(projectRoot, 'backend', 'node_modules', 'dotenv'));
  dotenv.config({ path: path.join(projectRoot, 'backend', '.env'), quiet: true });
  const prisma = require(path.join(projectRoot, 'backend', 'src', 'config', 'prisma'));
  const { conectar: conectarRedis } = require(path.join(projectRoot, 'backend', 'src', 'config', 'redis'));

  const runStartedAt = new Date();
  let redis;
  try {
    console.log(`Escenario: ${scenario.name}`);
    console.log(`API: ${baseUrl}`);

    const health = await httpJson(baseUrl, '/health', { timeoutMs: scenario.requestTimeoutMs });
    requireHttp(health, 'El backend no está disponible', [200]);

    const buyerRefs = new Set(scenario.attempts.map((attempt) => attempt.userRef));
    const selectedBuyers = accounts.buyers.filter((buyer) => buyerRefs.has(buyer.ref));
    if (selectedBuyers.length !== buyerRefs.size) {
      const found = new Set(selectedBuyers.map((buyer) => buyer.ref));
      const missing = [...buyerRefs].filter((ref) => !found.has(ref));
      throw new Error(`Faltan usuarios en ${path.basename(usersPath)}: ${missing.join(', ')}`);
    }

    if (prepareOnly) {
      const sellerLogin = await login(baseUrl, accounts.seller, scenario.requestTimeoutMs);
      const { token: sellerToken } = requireHttp(sellerLogin, 'No se pudo iniciar sesión con el vendedor', [200]);

      console.log(`Creando o verificando ${selectedBuyers.length} compradores sintéticos...`);
      for (const account of selectedBuyers) {
        await provisionBuyer(baseUrl, account, scenario.requestTimeoutMs);
      }

      scenario.productId = await resolveTestProduct(baseUrl, scenario, sellerToken, scenario.requestTimeoutMs);
      console.log(`Producto sintético resuelto con ID ${scenario.productId}.`);
      console.log('Restaurando inventario y configurando su oferta...');
      await prepareScenario(baseUrl, scenario, sellerToken, scenario.requestTimeoutMs);

      const preparedInventory = await prisma.inventario.findUnique({ where: { id_producto: scenario.productId } });
      const preparedState = {
        ready: true,
        scenario: scenario.name,
        productId: scenario.productId,
        preparedAt: new Date().toISOString(),
        initialInventory: preparedInventory.cantidad,
        offerStock: scenario.prepare.offerStock,
      };
      fs.writeFileSync(preparedStatePath, JSON.stringify(preparedState, null, 2) + '\n');

      console.log('');
      console.log('PREPARACIÓN COMPLETADA');
      console.log(`Inventario MySQL: ${preparedState.initialInventory}`);
      console.log(`Stock de oferta: ${preparedState.offerStock}`);
      console.log('Ahora ejecutá: node .\\flash-sale-tests\\run.js');
      return;
    }

    if (!fs.existsSync(preparedStatePath)) {
      throw new Error('No hay una preparación vigente. Ejecutá primero node .\\flash-sale-tests\\prepare.js');
    }
    const preparedState = readJson(preparedStatePath);
    if (!preparedState.ready || preparedState.scenario !== scenario.name
        || preparedState.offerStock !== scenario.prepare.offerStock) {
      throw new Error('La preparación ya fue consumida o pertenece a otro escenario. Ejecutá node .\\flash-sale-tests\\prepare.js');
    }
    scenario.productId = preparedState.productId;

    console.log(`Usando el producto sintético preparado con ID ${scenario.productId}.`);
    console.log(`Iniciando sesión con ${selectedBuyers.length} compradores...`);
    const buyers = new Map();
    for (const account of selectedBuyers) {
      const buyer = await loadPreparedBuyer(baseUrl, account, scenario.requestTimeoutMs);
      buyers.set(buyer.ref, buyer);
    }

    const [initialInventory, baselineDetails] = await prisma.$transaction([
      prisma.inventario.findUnique({ where: { id_producto: scenario.productId } }),
      prisma.compra_detalle.findMany({ where: { id_producto: scenario.productId }, select: { id: true } }),
    ], { isolationLevel: 'RepeatableRead' });
    if (!initialInventory) throw new Error(`No existe inventario MySQL para el producto ${scenario.productId}`);

    const initialOfferResult = await httpJson(baseUrl, `/ofertas/${scenario.productId}/stock`, {
      timeoutMs: scenario.requestTimeoutMs,
    });
    const initialOffer = requireHttp(initialOfferResult, 'No se pudo consultar la oferta preparada', [200]);
    if (initialInventory.cantidad !== preparedState.initialInventory) {
      throw new Error(
        `El inventario cambió desde la preparación (${preparedState.initialInventory} -> ${initialInventory.cantidad}). Ejecutá prepare.js otra vez.`
      );
    }
    if (!initialOffer.activo || initialOffer.restante !== preparedState.offerStock) {
      throw new Error(
        `La oferta ya no está preparada (restante=${initialOffer.restante ?? 'no disponible'}). Ejecutá prepare.js otra vez.`
      );
    }

    redis = conectarRedis();
    const redisKey = `oferta:${scenario.productId}:stock`;
    const initialRedisMissing = await redis.get(redisKey) === null;

    fs.writeFileSync(
      preparedStatePath,
      JSON.stringify({ ...preparedState, ready: false, executionStartedAt: new Date().toISOString() }, null, 2) + '\n'
    );
    const commonStart = Date.now() + scenario.startDelayMs;
    console.log(`Lanzando ${scenario.attempts.length} intentos a las ${new Date(commonStart).toISOString()}...`);

    const probes = [];
    const stopState = { stop: false };
    const probePromise = probeApplication(baseUrl, scenario, stopState, probes);
    const attempts = await Promise.all(
      scenario.attempts.map((attempt) =>
        executeAttempt(baseUrl, scenario, attempt, buyers.get(attempt.userRef), commonStart)
      )
    );
    stopState.stop = true;
    await probePromise;

    // Conservar las respuestas aunque la conciliación no consiga leer las bases.
    const timestamp = runStartedAt.toISOString().replace(/[:.]/g, '-');
    const outputDir = path.join(testsDir, 'results', `${timestamp}-${scenario.name.replace(/[^a-z0-9_-]+/gi, '-')}`);
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'attempts.jsonl'), attempts.map((attempt) => JSON.stringify(attempt)).join('\n') + '\n');
    fs.writeFileSync(path.join(outputDir, 'probes.json'), JSON.stringify(probes, null, 2) + '\n');

    console.log('Conciliando compras persistidas, inventario y Redis después de las respuestas HTTP...');
    const reconciliation = await reconcile({
      ...scenario.reconciliation,
      readSnapshot: createSnapshotReader({
        prisma, redis, productId: scenario.productId,
        baselineDetailIds: baselineDetails.map((detail) => detail.id),
        buyerRefsByEmail: new Map(selectedBuyers.map((buyer) => [buyer.email, buyer.ref])),
      }),
      attempts,
      initialInventory: initialInventory.cantidad,
      offerStock: preparedState.offerStock,
      offerExpiresAt: Date.parse(initialOffer.vigente_hasta),
      initialRedisMissing,
    });
    const confirmed = reconciliation.assessment;
    const mysqlAfter = reconciliation.snapshot?.mysqlAfter ?? null;
    const redisRemaining = confirmed?.redisRemaining ?? null;

    const successes = attempts.filter((attempt) => attempt.outcome === 'success');
    const soldOut = attempts.filter((attempt) => attempt.outcome === 'sold_out');
    const timeouts = attempts.filter((attempt) => attempt.outcome === 'timeout');
    const unexpected = attempts.filter((attempt) => attempt.outcome === 'unexpected_error');
    const successfulUnits = successes.reduce((sum, attempt) => sum + attempt.quantity, 0);
    const attemptLatencies = attempts.map((attempt) => attempt.latencyMs);
    const probeLatencies = probes.flatMap((probe) => [probe.health.latencyMs, probe.offerStock.latencyMs]);
    const probesOk = probes.length > 0 && probes.every(
      (probe) => probe.health.status === 200 && probe.offerStock.status === 200 && !probe.health.error && !probe.offerStock.error
    );

    // Diagnósticos informativos: no deciden APROBADO/REPROBADO.
    const diagnostics = [
      invariant('Sin timeouts', 0, timeouts.length, timeouts.length === 0),
      invariant('Sin errores inesperados', 0, unexpected.length, unexpected.length === 0),
      invariant('Sondas disponibles durante la ráfaga', true, probesOk, probesOk),
    ];
    if (scenario.thresholds?.maxProbeP95Ms !== undefined) {
      const probeP95 = percentile(probeLatencies, 95);
      diagnostics.push(
        invariant('Latencia p95 de sondas', `<= ${scenario.thresholds.maxProbeP95Ms}ms`, probeP95,
          probeP95 !== null && probeP95 <= scenario.thresholds.maxProbeP95Ms)
      );
    }
    const timeoutIds = new Set(timeouts.map((attempt) => attempt.attemptId));
    const timeoutsWithPurchase = confirmed?.uncertainWithPurchase.filter((item) => timeoutIds.has(item.attemptId)).length ?? null;
    const invariants = reconciliation.invariants;

    const summary = {
      scenario: scenario.name,
      criterion: 'no_overselling_and_inventory_consistency',
      runStartedAt: runStartedAt.toISOString(),
      runFinishedAt: new Date().toISOString(),
      productId: scenario.productId,
      requests: {
        total: attempts.length,
        successful: successes.length,
        soldOut: soldOut.length,
        timeouts: timeouts.length,
        unexpectedErrors: unexpected.length,
        successfulUnits,
      },
      inventory: {
        mysqlBefore: initialInventory.cantidad,
        mysqlAfter,
        mysqlDelta: confirmed?.mysqlDelta ?? null,
        offerStock: preparedState.offerStock,
        redisRemaining,
      },
      confirmedPurchases: {
        count: confirmed?.purchaseCount ?? null,
        units: confirmed?.units ?? null,
        flashUnits: confirmed?.flashUnits ?? null,
        withoutHttp201: confirmed?.purchasesWithoutHttp201 ?? null,
        timeoutsWithPurchase,
        timeoutsWithoutObservedPurchase: timeoutsWithPurchase === null ? null : timeouts.length - timeoutsWithPurchase,
      },
      reconciliation: {
        completed: reconciliation.completed,
        reason: reconciliation.reason,
        durationMs: reconciliation.durationMs,
        samples: reconciliation.samples.length,
        policy: reconciliation.policy,
        readErrors: reconciliation.readErrors,
        uncertainWithoutObservedPurchase: confirmed?.uncertainWithoutPurchase ?? [],
      },
      latencyMs: {
        min: Math.min(...attemptLatencies),
        p50: percentile(attemptLatencies, 50),
        p95: percentile(attemptLatencies, 95),
        p99: percentile(attemptLatencies, 99),
        max: Math.max(...attemptLatencies),
      },
      probes: {
        samples: probes.length,
        p95LatencyMs: percentile(probeLatencies, 95),
        allSuccessful: probesOk,
      },
      invariants,
      diagnostics,
      passed: reconciliation.passed,
    };

    fs.writeFileSync(path.join(outputDir, 'reconciliation.json'), JSON.stringify(reconciliation, null, 2) + '\n');
    fs.writeFileSync(path.join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');

    console.log('');
    console.log(`Resultado: ${summary.passed ? 'APROBADO' : 'REPROBADO'}`);
    console.log('Criterio: sin sobreventa e inventario consistente con las compras persistidas.');
    console.log(`Requests: ${attempts.length} | HTTP 201: ${successes.length} | HTTP 409 agotado: ${soldOut.length} | inesperados: ${unexpected.length} | timeouts: ${timeouts.length}`);
    console.log(`Compras en MySQL: ${confirmed?.purchaseCount ?? 'no verificable'} | unidades: ${confirmed?.units ?? 'no verificable'} | unidades de oferta: ${confirmed?.flashUnits ?? 'no verificable'}/${preparedState.offerStock}`);
    console.log(`Sin respuesta HTTP 201: ${confirmed?.purchasesWithoutHttp201 ?? 'no verificable'} compras | timeouts con compra: ${timeoutsWithPurchase ?? 'no verificable'}`);
    console.log(`MySQL: ${initialInventory.cantidad} -> ${mysqlAfter ?? 'no verificable'} | Redis: ${redisRemaining ?? 'no verificable'}`);
    console.log(`Conciliación: ${reconciliation.completed ? 'estable' : 'incompleta'} | ${reconciliation.durationMs} ms | ${reconciliation.samples.length} lecturas`);
    if (confirmed?.uncertainWithoutPurchase.length) {
      console.log(`Solicitudes sin respuesta y sin compra observada en la ventana: ${confirmed.uncertainWithoutPurchase.length} (no confirma cancelación del servidor)`);
    }
    console.log(`Latencia p50/p95/p99: ${summary.latencyMs.p50}/${summary.latencyMs.p95}/${summary.latencyMs.p99} ms`);
    console.log(`Sondas: ${probes.length} | disponibles: ${probesOk ? 'sí' : 'no'} | p95: ${summary.probes.p95LatencyMs} ms`);
    for (const failed of invariants.filter((item) => !item.passed)) {
      console.log(`FALLÓ: ${failed.name} | esperado: ${failed.expected} | observado: ${failed.actual}`);
    }
    for (const diagnostic of diagnostics.filter((item) => !item.passed)) {
      console.log(`DIAGNÓSTICO (no cambia el veredicto): ${diagnostic.name} | observado: ${diagnostic.actual}`);
    }
    console.log(`Reporte: ${outputDir}`);

    if (!summary.passed) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
    if (redis) redis.disconnect();
  }
}

main().catch((error) => {
  const operation = process.argv.includes('--prepare-only') ? 'PREPARACIÓN' : 'PRUEBA';
  console.error(`${operation} INTERRUMPIDA: ${error.message}`);
  process.exitCode = 1;
});
