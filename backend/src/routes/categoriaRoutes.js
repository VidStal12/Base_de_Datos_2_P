const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const categoriaService = require('../services/categoriaService');

const router = express.Router();

router.get('/', async (req, res) => {
  const categorias = await categoriaService.listar();
  res.json(categorias);
});

router.post('/', requireAuth, requireRole('vendedor', 'administrador'), async (req, res) => {
  try {
    const categoria = await categoriaService.crear(req.body);
    res.status(201).json(categoria);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// El id de la URL ahora es un ObjectId de Mongo (string) — ver ADR-002.
router.post('/:id/subcategorias', requireAuth, requireRole('vendedor', 'administrador'), async (req, res) => {
  try {
    const subcategoria = await categoriaService.crearSubcategoria(req.params.id, req.body);
    res.status(201).json(subcategoria);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post(
  '/subcategorias/:id/atributos',
  requireAuth,
  requireRole('vendedor', 'administrador'),
  async (req, res) => {
    try {
      const atributo = await categoriaService.crearAtributo(req.params.id, req.body);
      res.status(201).json(atributo);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

module.exports = router;
