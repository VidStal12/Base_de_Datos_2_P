const test = require('node:test');
const assert = require('node:assert/strict');
const { cargar } = require('./redisHelpers');

function escenario(flash = false) {
  let pedidos = 0;
  let controles = 0;
  let completado = false;
  const respuesta = { compra: { id: 11 }, pago: { id: 12 } };
  const intentos = {
    async recuperar(usuarioId, intentoId, datos) {
      assert.equal(usuarioId, 7);
      if (!intentoId) throw Object.assign(new Error('Prepará el checkout'), { status: 400, codigo: 'CHECKOUT_REQUERIDO' });
      if (flash) assert.equal(datos.productoId, 3);
      return completado ? respuesta : null;
    },
    reutilizado: () => false,
  };
  const comprar = async (...args) => {
    const datos = flash ? args[2] : args[0];
    assert.equal(datos.intentoId, 'intento-1');
    pedidos++;
    completado = true;
    return respuesta;
  };
  const ruta = cargar(flash ? '../src/routes/ofertaRoutes.js' : '../src/routes/checkoutRoutes.js', {
    '../middleware/auth': { requireAuth: (req, res, next) => { req.usuario = { id_usuario: 7 }; next(); }, requireRole: () => (req, res, next) => next() },
    '../middleware/controlPedidos': { controlPedidos: (req, res, next) => { controles++; next(); } },
    '../services/checkoutIntentoService': intentos,
    '../services/checkoutService': { checkout: comprar },
    '../services/ofertaFlashService': { comprar },
  });
  const enviar = (body) => new Promise((resolve, reject) => {
    const res = { locals: {}, status(codigo) { this.codigo = codigo; return this; }, json(datos) { resolve({ status: this.codigo || 200, datos }); } };
    ruta.handle({ method: 'POST', url: flash ? '/3/comprar' : '/', body }, res, reject);
  });
  return { enviar, pedidos: () => pedidos, controles: () => controles };
}
for (const flash of [false, true]) {
  const nombre = flash ? 'flash' : 'normal';
  test(`HTTP ${nombre}: no se puede eludir la protección omitiendo el intento`, async () => {
    const e = escenario(flash);
    const r = await e.enviar({ cantidad: 1 });
    assert.equal(r.status, 400);
    assert.equal(r.datos.codigo, 'CHECKOUT_REQUERIDO');
    assert.equal(e.pedidos(), 0);
  });
  test(`HTTP ${nombre}: el reenvío devuelve el pedido sin ejecutar otra compra ni gastar cuota por hora`, async () => {
    const e = escenario(flash);
    const datos = { intentoId: 'intento-1', cantidad: 1 };
    const a = await e.enviar(datos);
    const b = await e.enviar(datos);
    assert.equal(a.status, 201);
    assert.equal(b.status, 200);
    assert.equal(b.datos.compra.id, a.datos.compra.id);
    assert.equal(e.pedidos(), 1);
    assert.equal(e.controles(), 1);
  });
}
