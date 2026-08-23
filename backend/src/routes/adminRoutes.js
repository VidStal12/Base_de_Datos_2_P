const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { sincronizarFaltantes } = require('../services/catalogoSyncService');

const router = express.Router();

// Aditivo, no destructivo (ver catalogoSyncService.js) — a diferencia del
// script de bootstrap scripts/etlCatalogoAMongo.js, seguro de ejecutar las
// veces que haga falta desde el panel de administrador.
router.post('/sync-catalogo', requireAuth, requireRole('administrador'), async (req, res) => {
  try {
    const resultado = await sincronizarFaltantes();
    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
