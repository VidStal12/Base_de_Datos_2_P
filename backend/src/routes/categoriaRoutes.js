const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const categoriaService = require('../services/categoriaService');
const catalogoLectura = require('../services/catalogoLecturaService');
const { responderError } = require('../utils/http');

const router = express.Router();

router.get('/', async (req, res) => {
  // Con Mongo apagado las categorías se arman del índice de búsqueda.
  const categorias = await catalogoLectura.categorias();
  res.json(categorias);
});

router.post('/', requireAuth, requireRole('vendedor', 'administrador'), async (req, res) => {
  try {
    const categoria = await categoriaService.crear(req.body);
    res.status(201).json(categoria);
  } catch (err) {
    responderError(res, err, 400);
  }
});

// El id de la URL ahora es un ObjectId de Mongo (string) — ver ADR-002.
router.post('/:id/subcategorias', requireAuth, requireRole('vendedor', 'administrador'), async (req, res) => {
  try {
    const subcategoria = await categoriaService.crearSubcategoria(req.params.id, req.body);
    res.status(201).json(subcategoria);
  } catch (err) {
    responderError(res, err, 400);
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
      responderError(res, err, 400);
    }
  }
);

module.exports = router;
