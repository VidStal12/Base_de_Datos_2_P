const test = require('node:test');
const assert = require('node:assert/strict');
const { cargar } = require('./redisHelpers');
const { ServicioNoDisponible } = require('../src/utils/resiliencia');

// Si Mongo estaba apagado cuando se confirmó un pedido, la copia del stock y de total_vendido
// queda atrás (la compra ya es definitiva en MySQL). Antes solo la corregía a mano el botón de
// «recalcular» del administrador; ahora los productos afectados se anotan y se recalculan
// desde MySQL en cuanto Mongo responde — y solo ésos (reconciliacionMongoService.js).
function servicio({ recalculos }) {
  const llamadas = [];
  const modulo = cargar('../src/services/reconciliacionMongoService.js', {
    './catalogoSyncService': {
      recalcularInventario: async ({ productoIds }) => { llamadas.push(['inventario', [...productoIds]]); return recalculos(); },
      recalcularVentas: async ({ productoIds }) => { llamadas.push(['ventas', [...productoIds]]); return recalculos(); },
    },
  }, {}, { setInterval, clearInterval });
  return { ...modulo, llamadas };
}

const lista = (valor) => Array.from(valor);

test('los productos anotados se recalculan desde MySQL (inventario Y ventas) y salen de la lista', async () => {
  const s = servicio({ recalculos: async () => ({}) });
  s.encolar([3, 5, 3]);
  assert.deepEqual(lista(s.pendientes()).sort(), [3, 5], 'sin repetidos');
  const r = await s.reconciliar();
  assert.equal(r.reconciliados, 2);
  assert.deepEqual(s.llamadas.map(([quien, ids]) => [quien, lista(ids).sort()]), [['inventario', [3, 5]], ['ventas', [3, 5]]]);
  assert.deepEqual(lista(s.pendientes()), []);
  s.detener();
});

test('mientras Mongo siga apagado nada se pierde: la lista se conserva y se reintenta', async () => {
  let caido = true;
  const s = servicio({ recalculos: async () => { if (caido) throw new ServicioNoDisponible('mongo'); return {}; } });
  s.encolar([7]);
  const original = console.error;
  console.error = () => {};
  try {
    const fallido = await s.reconciliar();
    assert.equal(fallido.reconciliados, 0);
    assert.deepEqual(lista(s.pendientes()), [7], 'el producto sigue anotado');
  } finally {
    console.error = original;
  }
  caido = false;
  assert.equal((await s.reconciliar()).reconciliados, 1, 'al volver Mongo se reconcilia sin intervención');
  assert.deepEqual(lista(s.pendientes()), []);
  s.detener();
});

test('sin pendientes reconciliar() no toca ninguna base', async () => {
  const s = servicio({ recalculos: async () => assert.fail('no hay nada que recalcular') });
  assert.deepEqual(plano(await s.reconciliar()), { reconciliados: 0 });
  assert.deepEqual(s.llamadas, []);
});

test('dos reconciliaciones simultáneas comparten una sola ejecución', async () => {
  let ejecuciones = 0;
  const s = servicio({ recalculos: async () => { ejecuciones += 1; } });
  s.encolar([1]);
  await Promise.all([s.reconciliar(), s.reconciliar()]);
  assert.equal(ejecuciones, 2, 'inventario y ventas, una sola vez cada uno');
  s.detener();
});

function plano(valor) {
  return JSON.parse(JSON.stringify(valor));
}
