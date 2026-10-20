const express = require('express');
const { checkout } = require('../services/checkoutService');
const { requireAuth } = require('../middleware/auth');
const { controlPedidos } = require('../middleware/controlPedidos');
const { cuerpoDeError, responderError } = require('../utils/http');
const intentos = require('../services/checkoutIntentoService');

const router = express.Router();

// aceptaNoReventa: la aceptación del aviso de no reventa que el frontend les
// muestra a las cuentas que pueden vender (ver compromisoService.js). Solo
// cuenta el booleano `true`, no cualquier valor "verdadero".
//
// controlPedidos (ver middleware/controlPedidos.js): tope de pedidos por hora y, si la
// cuenta está bajo revisión, su contraseña en cada pedido y el tope de monto que
// checkout() hace cumplir dentro de la transacción.
router.post('/intentos', requireAuth, async (req, res) => {
  try { res.json(await intentos.preparar(req.usuario.id_usuario, { anteriorIntentoId: req.body.anteriorIntentoId })); }
  catch (err) { responderError(res, err, 503); }
});
router.get('/intentos/:id', requireAuth, async (req, res) => {
  try { res.json(await intentos.consultar(req.usuario.id_usuario, req.params.id)); }
  catch (err) { responderError(res, err, 503); }
});
router.post('/intentos/:id/cancelar', requireAuth, async (req, res) => {
  try {
    await intentos.resolverFallo(req.usuario.id_usuario, req.params.id, new Error('Compra cancelada para revisar los datos.'));
    res.json(await intentos.consultar(req.usuario.id_usuario, req.params.id));
  } catch (err) { responderError(res, err, 503); }
});

async function recuperarConfirmado(req, res, next) {
  try {
    const anterior = await intentos.recuperar(req.usuario.id_usuario, req.body.intentoId, req.body);
    if (anterior) return res.status(200).json(anterior);
    next();
  } catch (err) { responderError(res, err, 503); }
}
router.post('/', requireAuth, recuperarConfirmado, controlPedidos, async (req, res) => {
  try {
    const { direccionId, metodoPagoId, items, aceptaNoReventa } = req.body;
    const resultado = await checkout({
      usuarioId: req.usuario.id_usuario,
      direccionId,
      metodoPagoId,
      items,
      aceptaNoReventa: aceptaNoReventa === true,
      montoMaximo: req.limitesPedido?.montoMaximo ?? undefined,
      intentoId: req.body.intentoId,
    });
    res.locals.checkoutReutilizado = intentos.reutilizado(resultado);
    res.status(res.locals.checkoutReutilizado ? 200 : 201).json(resultado);
  } catch (err) {
    if (!err.status) {
      err.status = 503;
      err.codigo = 'CHECKOUT_INCIERTO';
      err.message = 'No pudimos verificar tu compra. Volvé a intentarlo para consultar su resultado.';
    }
    res.status(err.status).json(cuerpoDeError(err));
  }
});

module.exports = router;
