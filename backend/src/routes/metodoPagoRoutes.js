const express = require('express');
const { requireAuth } = require('../middleware/auth');
const metodoPagoService = require('../services/metodoPagoService');
const { responderError } = require('../utils/http');

const router = express.Router();
router.use(requireAuth);

router.post('/', async (req, res) => {
  try {
    const metodo = await metodoPagoService.crear(req.usuario.id_usuario, req.body);
    res.status(201).json(metodo);
  } catch (err) {
    responderError(res, err, 400);
  }
});

router.get('/', async (req, res) => {
  const metodos = await metodoPagoService.listar(req.usuario.id_usuario);
  res.json(metodos);
});

router.delete('/:id', async (req, res) => {
  try {
    await metodoPagoService.eliminar(req.usuario.id_usuario, Number(req.params.id));
    res.status(204).send();
  } catch (err) {
    responderError(res, err, 404);
  }
});

module.exports = router;
