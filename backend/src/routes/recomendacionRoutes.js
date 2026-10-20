const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { controlPedidos } = require('../middleware/controlPedidos');
const tendenciaService = require('../services/tendenciaService');
const { responderError } = require('../utils/http');

const router = express.Router();

// Siempre sobre el usuario del token — nunca un :usuarioId en la URL, la
// recomendación de una persona no es algo que otra debería poder pedir.
router.get('/', requireAuth, async (req, res) => {
  try {
    const resultado = await tendenciaService.recomendar(req.usuario.id_usuario);
    res.json(resultado);
  } catch (err) {
    responderError(res, err, 500);
  }
});

// controlPedidos: tope de pedidos por hora y límites suaves de una cuenta bajo revisión.
router.post('/:productoId/comprar', requireAuth, controlPedidos, async (req, res) => {
  try {
    const { cantidad, direccionId, metodoPagoId, aceptaNoReventa } = req.body;
    const resultado = await tendenciaService.comprar(req.usuario.id_usuario, Number(req.params.productoId), {
      cantidad,
      direccionId,
      metodoPagoId,
      aceptaNoReventa: aceptaNoReventa === true,
      montoMaximo: req.limitesPedido?.montoMaximo ?? undefined,
    });
    res.status(201).json(resultado);
  } catch (err) {
    responderError(res, err, 400);
  }
});

module.exports = router;
