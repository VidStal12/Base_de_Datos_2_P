const test = require('node:test');
const assert = require('node:assert/strict');
const { cargar, productoFalso, compromisoFalso } = require('./redisHelpers');

// `propios`: ids de producto que pertenecen a quien compra; `vendedores`: las
// cuentas que pueden vender y por lo tanto deben aceptar el compromiso de no
// reventa (ver compromisoService.js).
function escenario({ propios = [], vendedores = [], suspendidos = [] } = {}) {
  const producto = { id: 1, vendedor_id: 2, estado: 'activo', descripcion: 'Flash', oferta_flash: { activo: true, precio_oferta: 8, stock_oferta: 2, vigente_desde: new Date(Date.now() - 1000), vigente_hasta: new Date(Date.now() + 60000) } };
  let restante = 2;
  let reintegros = 0;
  let falla = false;
  const pedidos = [];
  const servicio = cargar('../src/services/ofertaFlashService.js', {
    './checkoutIntentoService': {},
    '../config/redis': { conectar: () => ({
      get: async () => String(restante),
      decrementarOferta: async (k, inicial, ttl, cantidad) => { if (cantidad > restante) return -1; restante -= cantidad; return restante; },
      reintegrarOferta: async (k, cantidad) => { reintegros += cantidad; restante += cantidad; },
    }) },
    '../config/mongo': {}, '../models/mongo/Producto': {},
    './productoService': productoFalso({ propios, suspendidos, obtener: () => assert.fail('el camino caliente no lee el catálogo') }),
    './compromisoService': compromisoFalso({ vendedores }),
    './ofertaDatosService': { obtener: async () => producto },
    './checkoutService': { checkoutOferta: async (datos) => { pedidos.push(datos); if (falla) throw new Error('MySQL rechazó'); return { precioUnitario: datos.precioUnitario }; } },
  });
  return { servicio, producto, pedidos, restante: () => restante, reintegros: () => reintegros, fallar: () => { falla = true; } };
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

test('el dueño de la oferta no gasta cupo comprándola: se rechaza antes de Redis', async () => {
  const e = escenario({ propios: [1] });
  await assert.rejects(e.servicio.comprar(7, 1, { cantidad: 1 }), (err) => err.status === 403);
  assert.equal(e.restante(), 2);
  assert.equal(e.reintegros(), 0, 'no hubo nada que devolver: nunca se gastó');
  assert.equal(e.pedidos.length, 0);
});

test('un vendedor sin el compromiso de no reventa no gasta cupo; con él, la compra lo lleva al pedido', async () => {
  const e = escenario({ vendedores: [7] });
  await assert.rejects(e.servicio.comprar(7, 1, { cantidad: 1 }), (err) => err.status === 400 && err.codigo === 'COMPROMISO_NO_REVENTA');
  assert.equal(e.restante(), 2);
  assert.equal(e.pedidos.length, 0);

  await e.servicio.comprar(7, 1, { cantidad: 1, aceptaNoReventa: true });
  assert.equal(e.restante(), 1);
  assert.equal(e.pedidos[0].aceptaNoReventa, true, 'checkoutOferta recibe la aceptación para dejar la constancia');

  // Un comprador no tiene que aceptar nada.
  const otro = escenario({ vendedores: [7] });
  await otro.servicio.comprar(8, 1, { cantidad: 1 });
  assert.equal(otro.restante(), 1);
});

test('la oferta de un vendedor suspendido no se muestra ni se puede comprar, sin gastar cupo; vuelve al levantarse', async () => {
  const suspendidos = new Set();
  const e = escenario({ suspendidos });
  assert.equal((await e.servicio.consultarStock(1)).activo, true);

  suspendidos.add(2); // el vendedor del producto (2) se suspende
  await assert.rejects(e.servicio.consultarStock(1), /no encontrado/, 'para el público la oferta no existe');
  await assert.rejects(e.servicio.comprar(7, 1, { cantidad: 1 }), (err) => err.status === 409 && /no tiene una oferta flash activa/.test(err.message));
  assert.equal(e.restante(), 2, 'no se gastó cupo');
  assert.equal(e.pedidos.length, 0);

  suspendidos.delete(2);
  assert.equal((await e.servicio.consultarStock(1)).activo, true);
  await e.servicio.comprar(7, 1, { cantidad: 1 });
  assert.equal(e.restante(), 1);
});

test('el tope de monto de una cuenta con límites suaves llega hasta checkoutOferta, y si lo rechaza el cupo se devuelve', async () => {
  const e = escenario();
  await e.servicio.comprar(7, 1, { cantidad: 1, montoMaximo: 500 });
  assert.equal(e.pedidos[0].montoMaximo, 500, 'checkoutOferta recibe el tope para hacerlo cumplir dentro de la transacción');
  e.fallar(); // checkoutOferta rechaza (por el tope o por lo que sea)
  await assert.rejects(e.servicio.comprar(7, 1, { cantidad: 1, montoMaximo: 5 }), /MySQL/);
  assert.equal(e.restante(), 1, 'el segundo intento devolvió su cupo');
});
