const express = require('express');
const { optionalAuth } = require('../middleware/auth');
const catalogoLectura = require('../services/catalogoLecturaService');
const { responderError } = require('../utils/http');

const router = express.Router();

// Búsqueda de productos (Entrega 3, ver IA/PLAN-ELASTICSEARCH-BUSQUEDA.md) —
// pública, mismo criterio que GET /api/productos. Con Elasticsearch apagado cae a una
// búsqueda básica sobre Mongo (`modo: 'basico'`, ver catalogoLecturaService.js) en vez de
// quedarse sin buscador. optionalAuth deja pasar sin sesión (req.usuario queda undefined):
// con sesión, permite personalizar la respuesta sin resultados (ver catalogoLecturaService.js).
router.get('/', optionalAuth, async (req, res) => {
  try {
    const resultado = await catalogoLectura.buscar(req.query, req.usuario?.id_usuario);
    res.json(resultado);
  } catch (err) {
    responderError(res, err, 503);
  }
});

// Autocompletado — antes de "/", no colisiona (Express matchea el path
// completo, "/sugerencias" nunca cae en "/"), pero se deja acá al lado por
// legibilidad. Pública, mismo criterio que la búsqueda misma.
router.get('/sugerencias', async (req, res) => {
  try {
    const sugerencias = await catalogoLectura.sugerir(req.query.q);
    res.json({ sugerencias });
  } catch (err) {
    responderError(res, err, 503);
  }
});

module.exports = router;