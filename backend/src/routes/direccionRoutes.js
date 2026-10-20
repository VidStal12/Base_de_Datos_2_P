const express = require('express');
const { requireAuth } = require('../middleware/auth');
const direccionService = require('../services/direccionService');
const { responderError } = require('../utils/http');

const router = express.Router();
router.use(requireAuth);

router.post('/', async (req, res) => {
  try {
    const direccion = await direccionService.crear(req.usuario.id_usuario, req.body);
    res.status(201).json(direccion);
  } catch (err) {
    responderError(res, err, 400);
  }
});

router.get('/', async (req, res) => {
  const direcciones = await direccionService.listar(req.usuario.id_usuario);
  res.json(direcciones);
});

router.delete('/:id', async (req, res) => {
  try {
    await direccionService.eliminar(req.usuario.id_usuario, Number(req.params.id));
    res.status(204).send();
  } catch (err) {
    responderError(res, err, 404);
  }
});

module.exports = router;
