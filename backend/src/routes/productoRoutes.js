const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const productoService = require('../services/productoService');

const router = express.Router();

router.get('/', async (req, res) => {
  const productos = await productoService.listar(req.query);
  res.json(productos);
});

router.get('/:id', async (req, res) => {
  try {
    const producto = await productoService.obtener(Number(req.params.id));
    res.json(producto);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.post('/', requireAuth, requireRole('vendedor', 'administrador'), async (req, res) => {
  try {
    const producto = await productoService.crear(req.usuario, req.body);
    res.status(201).json(producto);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/:id/inventario', requireAuth, requireRole('vendedor', 'administrador'), async (req, res) => {
  try {
    const inventario = await productoService.actualizarInventario(req.usuario, Number(req.params.id), req.body);
    res.json(inventario);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

module.exports = router;
