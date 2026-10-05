const express = require('express');
const { checkout } = require('../services/checkoutService');
const { requireAuth } = require('../middleware/auth');
const { controlPedidos } = require('../middleware/controlPedidos');
const { cuerpoDeError } = require('../utils/http');

const router = express.Router();

// aceptaNoReventa: la aceptación del aviso de no reventa que el frontend les
// muestra a las cuentas que pueden vender (ver compromisoService.js). Solo
// cuenta el booleano `true`, no cualquier valor "verdadero".
//
// controlPedidos (ver middleware/controlPedidos.js): tope de pedidos por hora y, si la
// cuenta está bajo revisión, su contraseña en cada pedido y el tope de monto que
// checkout() hace cumplir dentro de la transacción.
router.post('/', requireAuth, controlPedidos, async (req, res) => {
  try {
    const { direccionId, metodoPagoId, items, aceptaNoReventa } = req.body;
    const resultado = await checkout({
      usuarioId: req.usuario.id_usuario,
      direccionId,
      metodoPagoId,
      items,
      aceptaNoReventa: aceptaNoReventa === true,
      montoMaximo: req.limitesPedido?.montoMaximo ?? undefined,
    });
    res.status(201).json(resultado);
  } catch (err) {
    res.status(err.status || 400).json(cuerpoDeError(err));
  }
});

module.exports = router;
