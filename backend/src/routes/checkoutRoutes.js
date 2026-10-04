const express = require('express');
const { checkout } = require('../services/checkoutService');
const { requireAuth } = require('../middleware/auth');
const { cuerpoDeError } = require('../utils/http');

const router = express.Router();

// aceptaNoReventa: la aceptación del aviso de no reventa que el frontend les
// muestra a las cuentas que pueden vender (ver compromisoService.js). Solo
// cuenta el booleano `true`, no cualquier valor "verdadero".
router.post('/', requireAuth, async (req, res) => {
  try {
    const { direccionId, metodoPagoId, items, aceptaNoReventa } = req.body;
    const resultado = await checkout({
      usuarioId: req.usuario.id_usuario,
      direccionId,
      metodoPagoId,
      items,
      aceptaNoReventa: aceptaNoReventa === true,
    });
    res.status(201).json(resultado);
  } catch (err) {
    res.status(err.status || 400).json(cuerpoDeError(err));
  }
});

module.exports = router;
