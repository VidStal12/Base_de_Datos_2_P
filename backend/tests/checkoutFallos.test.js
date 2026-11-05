const test = require('node:test');
const assert = require('node:assert/strict');
const { cargar } = require('./redisHelpers');
const { ServicioNoDisponible } = require('../src/utils/resiliencia');

const datos = { usuarioId: 7, intentoId: 'demo', direccionId: 1, metodoPagoId: 2,
  items: [{ productoId: 3, cantidad: 1, precioEsperado: 50 }] };

function escenario({ detenerEn, redisInicial = true } = {}) {
  let estado = { stock: 5, pedidos: 0, pagos: 0, carrito: 1, outbox: 0 };
  let respuestaGuardada;
  let enTransaccion = false;
  let mysql = true;
  let redis = redisInicial;
  let proyecciones = 0;
  const pausas = [];
  const reutilizadas = new WeakSet();
  const tx = {
    direcciones: { findUnique: async () => ({ id_usuario: 7 }) },
    metodo_pago: { findUnique: async () => ({ id_usuario: 7 }) },
    inventario: {
      findUnique: async () => ({ cantidad: estado.stock, precio: 50 }),
      updateMany: async () => { estado.stock--; return { count: 1 }; },
    },
    compra: { create: async () => { estado.pedidos++; return { id: 11, compra_detalles: [{ id: 8, id_producto: 3, precio_final: 50 }] }; } },
    pago: { create: async () => { estado.pagos++; return { id: 12, estado: 'aprobado' }; } },
    carrito: { deleteMany: async () => { estado.carrito = 0; } },
  };
  const intentos = {
    async recuperar() {
      if (!respuestaGuardada) return null;
      const r = structuredClone(respuestaGuardada);
      reutilizadas.add(r);
      return r;
    },
    reutilizado: (r) => reutilizadas.has(r),
    async transaccion(_, operacion) {
      if (!mysql) throw new ServicioNoDisponible('mysql');
      enTransaccion = true;
      const anterior = structuredClone(estado);
      try {
        const r = await operacion(tx);
        respuestaGuardada = structuredClone(r);
        return r;
      } catch (err) { estado = anterior; throw err; }
      finally { enTransaccion = false; }
    },
    guardarAdvertencias: async (_, __, r) => { respuestaGuardada = structuredClone(r); },
  };
  const servicio = cargar('../src/services/checkoutService.js', {
    '../config/prisma': { usuarios: { findUnique: async () => ({ rol: { tipo_rol: 'comprador' } }) } },
    '../config/mongo': { conectar: async () => {} },
    '../models/mongo/Producto': {
      updateOne: async () => { proyecciones++; },
      findOne: () => ({ select: () => ({ lean: async () => null }) }),
    },
    './cartService': {
      bloquearUsuario: async () => {}, avanzarVersion: async () => {},
      invalidarCache: async () => { assert.equal(enTransaccion, false); return redis; },
    },
    './productoService': {
      verificarNoEsPropio: async () => {}, verificarVendedoresActivos: async () => {},
      estadoPublicacion: async () => new Map([[3, { estado: 'activo' }]]),
    },
    './compromisoService': { exigirCompromiso: async () => ({ aceptadoEn: null }) },
    './ventasOutboxService': { encolarCompra: async () => { estado.outbox++; } },
    './fraudeSyncService': {}, './reconciliacionMongoService': {}, './popularidadService': { marcarVentas() {} },
    './checkoutIntentoService': intentos,
    './checkoutDemoService': { pausar: async (etapa) => {
      assert.equal(enTransaccion, false, 'la pausa nunca retiene una transacción abierta');
      pausas.push(etapa);
      if (etapa !== detenerEn) return;
      detenerEn = undefined;
      if (etapa === 'before_transaction') mysql = false;
      else { assert.equal(estado.pedidos, 1); assert.equal(estado.carrito, 0); redis = false; }
    } },
  });
  return { comprar: () => servicio.checkout(datos), estado: () => estado, pausas, proyecciones: () => proyecciones,
    restaurar: () => { mysql = true; redis = true; } };
}

test('Redis cae después del commit: confirma, avisa y reenviar no duplica pedido, pago ni inventario', async () => {
  const e = escenario({ detenerEn: 'after_commit_before_redis' });
  const r = await e.comprar();
  assert.equal(r.advertencias[0].codigo, 'CARRITO_CACHE_PENDIENTE');
  assert.match(r.advertencias[0].mensaje, /No necesitás repetir/);
  assert.deepEqual(e.estado(), { stock: 4, pedidos: 1, pagos: 1, carrito: 0, outbox: 1 });
  e.restaurar();
  const repetida = await e.comprar();
  assert.equal(repetida.compra.id, r.compra.id);
  assert.equal(repetida.advertencias[0].codigo, 'CARRITO_CACHE_PENDIENTE');
  assert.deepEqual(e.estado(), { stock: 4, pedidos: 1, pagos: 1, carrito: 0, outbox: 1 });
  assert.equal(e.proyecciones(), 1);
  assert.equal(e.pausas.length, 2, 'el reenvío confirmado tampoco vuelve a pausar');
});

test('MySQL cae antes de la transacción: no deja escrituras parciales y se reanuda con el mismo intento', async () => {
  const e = escenario({ detenerEn: 'before_transaction' });
  await assert.rejects(e.comprar(), (err) => err.componente === 'mysql');
  assert.deepEqual(e.estado(), { stock: 5, pedidos: 0, pagos: 0, carrito: 1, outbox: 0 });
  assert.equal(e.proyecciones(), 0);
  e.restaurar();
  const r = await e.comprar();
  assert.equal(r.compra.id, 11);
  assert.deepEqual(e.estado(), { stock: 4, pedidos: 1, pagos: 1, carrito: 0, outbox: 1 });
});

test('camino sano: confirma sin advertencias', async () => {
  const e = escenario();
  const r = await e.comprar();
  assert.equal(r.advertencias, undefined);
  assert.equal(e.estado().pedidos, 1);
});

test('la pausa requiere activación y no funciona en producción ni con esperas inválidas', async () => {
  for (const entorno of [{}, { CHECKOUT_DEMO_ENABLED: 'false' },
    { CHECKOUT_DEMO_ENABLED: 'true', NODE_ENV: 'production' },
    ...['-1', '0', '60001', 'NaN', '1.5'].map((ms) => ({ CHECKOUT_DEMO_ENABLED: 'true', CHECKOUT_DEMO_PAUSE_MS: ms }))]) {
    let esperas = 0;
    const demo = cargar('../src/services/checkoutDemoService.js', {
      'node:timers/promises': { setTimeout: async () => { esperas++; } },
    }, entorno);
    await demo.pausar('after_commit_before_redis');
    assert.equal(esperas, 0);
  }
});

test('la espera asíncrona solo ocurre en la etapa elegida y deja un log identificable', async () => {
  const esperas = [];
  const logs = [];
  const demo = cargar('../src/services/checkoutDemoService.js', {
    'node:timers/promises': { setTimeout: async (ms) => { esperas.push(ms); } },
  }, { CHECKOUT_DEMO_ENABLED: 'true', CHECKOUT_DEMO_PAUSE_AT: 'before_transaction', CHECKOUT_DEMO_PAUSE_MS: '12000' },
  { console: { log: (...args) => logs.push(args.join(' ')), error() {} } });
  await demo.pausar('after_commit_before_redis', { compraId: 11 });
  await demo.pausar('before_transaction', { usuarioId: 7, intentoId: 'demo' });
  assert.deepEqual(esperas, [12000]);
  assert.match(logs[0], /PAUSA.*demo.*docker compose stop mysql/);
  assert.match(logs[1], /CONTINÚA/);
});
