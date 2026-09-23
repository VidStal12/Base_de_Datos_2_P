const express = require('express');
const busquedaService = require('../services/busquedaService');

const router = express.Router();

// Búsqueda de productos (Entrega 3, ver IA/PLAN-ELASTICSEARCH-BUSQUEDA.md) —
// pública, mismo criterio que GET /api/productos.
router.get('/', async (req, res) => {
  try {
    const resultado = await busquedaService.buscar(req.query);
    res.json(resultado);
  } catch (err) {
    res.status(503).json({ error: 'No se pudo consultar el buscador: ' + err.message });
  }
});

module.exports = router;
