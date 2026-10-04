const test = require('node:test');
const assert = require('node:assert/strict');
const { cargar } = require('./redisHelpers');

function escenario() {
  const producto = { id: 1, estado: 'activo', descripcion: 'Flash', oferta_flash: { activo: true, precio_oferta: 8, stock_oferta: 2, vigente_desde: new Date(Date.now() - 1000), vigente_hasta: new Date(Date.now() + 60000) } };
  let restante = 2;
  let reintegros = 0;
  let falla = false;
  const servicio = cargar('../src/services/ofertaFlashService.js', {
    '../config/redis': { conectar: () => ({
      get: async () => String(restante),
      decrementarOferta: async (k, inicial, ttl, cantidad) => { if (cantidad > restante) return -1; restante -= cantidad; return restante; },
      reintegrarOferta: async (k, cantidad) => { reintegros += cantidad; restante += cantidad; },
    }) },
    '../config/mongo': {}, '../models/mongo/Producto': {},
    './productoService': { obtener: () => assert.fail('el camino caliente no lee el catálogo') },
    './ofertaDatosService': { obtener: async () => producto },
    './checkoutService': { checkoutOferta: async ({ precioUnitario }) => { if (falla) throw new Error('MySQL rechazó'); return { precioUnitario }; } },
  });
  return { servicio, producto, restante: () => restante, reintegros: () => reintegros, fallar: () => { falla = true; } };
}

test('consulta y admisión flash usan los datos propios de la oferta y su precio del servidor', async () => {
  const e = escenario();
  assert.equal((await e.servicio.consultarStock(1)).precio_oferta, 8);
  assert.equal((await e.servicio.consultarStock(1)).producto.descripcion, 'Flash');
  const respuestas = await Promise.allSettled([1, 2, 3].map(() => e.servicio.comprar(7, 1, { cantidad: 1 })));
  assert.equal(respuestas.filter((r) => r.status === 'fulfilled').length, 2);
  assert.equal(e.restante(), 0);
  assert.equal(respuestas[0].value.precioUnitario, 8);
});

test('un precio flash distinto al mostrado se rechaza sin gastar cupo', async () => {
  const e = escenario();
  await assert.rejects(e.servicio.comprar(7, 1, { cantidad: 1, precioEsperado: 7 }), (err) => err.status === 409);
  assert.equal(e.restante(), 2);
});

test('rechaza un producto inactivo o una oferta vencida antes de gastar cupo', async () => {
  const e = escenario();
  e.producto.estado = 'inactivo';
  await assert.rejects(e.servicio.intentarComprar(1, 1), (err) => err.status === 409);
  e.producto.estado = 'activo';
  e.producto.oferta_flash.vigente_hasta = new Date(Date.now() - 1);
  await assert.rejects(e.servicio.intentarComprar(1, 1), /venció/);
  assert.equal(e.restante(), 2);
});

test('fallo SQL devuelve el cupo admitido', async () => {
  const e = escenario();
  e.fallar();
  await assert.rejects(e.servicio.comprar(7, 1, { cantidad: 1 }), /MySQL/);
  assert.equal(e.restante(), 2);
  assert.equal(e.reintegros(), 1);
});
