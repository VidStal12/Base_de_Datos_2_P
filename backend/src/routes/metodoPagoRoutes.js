const express = require('express');
const { requireAuth } = require('../middleware/auth');
const metodoPagoService = require('../services/metodoPagoService');

const router = express.Router();
router.use(requireAuth);

router.post('/', async (req, res) => {
  try {
    const metodo = await metodoPagoService.crear(req.usuario.id_usuario, req.body);
    res.status(201).json(metodo);
  } catch (err) {
    res.status(400).json({ error: err.message });
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
    res.status(err.status || 404).json({ error: err.message });
  }
});

module.exports = router;
