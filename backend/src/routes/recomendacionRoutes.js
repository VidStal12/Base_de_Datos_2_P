const express = require('express');
const { requireAuth } = require('../middleware/auth');
const tendenciaService = require('../services/tendenciaService');
const { cuerpoDeError } = require('../utils/http');

const router = express.Router();

// Siempre sobre el usuario del token — nunca un :usuarioId en la URL, la
// recomendación de una persona no es algo que otra debería poder pedir.
router.get('/', requireAuth, async (req, res) => {
  try {
    const resultado = await tendenciaService.recomendar(req.usuario.id_usuario);
    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:productoId/comprar', requireAuth, async (req, res) => {
  try {
    const { cantidad, direccionId, metodoPagoId, aceptaNoReventa } = req.body;
    const resultado = await tendenciaService.comprar(req.usuario.id_usuario, Number(req.params.productoId), {
      cantidad,
      direccionId,
      metodoPagoId,
      aceptaNoReventa: aceptaNoReventa === true,
    });
    res.status(201).json(resultado);
  } catch (err) {
    res.status(err.status || 400).json(cuerpoDeError(err));
  }
});

module.exports = router;
