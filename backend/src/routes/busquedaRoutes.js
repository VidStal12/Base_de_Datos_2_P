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

// Autocompletado — antes de "/", no colisiona (Express matchea el path
// completo, "/sugerencias" nunca cae en "/"), pero se deja acá al lado por
// legibilidad. Pública, mismo criterio que la búsqueda misma.
router.get('/sugerencias', async (req, res) => {
  try {
    const sugerencias = await busquedaService.sugerir(req.query.q);
    res.json({ sugerencias });
  } catch (err) {
    res.status(503).json({ error: 'No se pudo consultar el autocompletado: ' + err.message });
  }
});

module.exports = router;
