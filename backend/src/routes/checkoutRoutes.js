const express = require('express');
const { checkout } = require('../services/checkoutService');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.post('/', requireAuth, async (req, res) => {
  try {
    const { direccionId, metodoPagoId, items } = req.body;
    const resultado = await checkout({
      usuarioId: req.usuario.id_usuario,
      direccionId,
      metodoPagoId,
      items,
    });
    res.status(201).json(resultado);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

module.exports = router;
