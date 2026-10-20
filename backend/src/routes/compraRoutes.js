const express = require('express');
const { requireAuth } = require('../middleware/auth');
const compraService = require('../services/compraService');
const { responderError } = require('../utils/http');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const compras = await compraService.listarPorUsuario(req.usuario.id_usuario);
  res.json(compras);
});

router.get('/:id', async (req, res) => {
  try {
    const compra = await compraService.obtener(req.usuario.id_usuario, Number(req.params.id));
    res.json(compra);
  } catch (err) {
    responderError(res, err, 404);
  }
});

module.exports = router;
