const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { recalcularVentas, recalcularInventario } = require('../services/catalogoSyncService');

const router = express.Router();

// Reconciliación, no adición: recalcula total_vendido desde compra_detalle
// (MySQL) y SOBRESCRIBE el valor cacheado en Mongo. Ver catalogoSyncService.js.
router.post('/recalcular-ventas', requireAuth, requireRole('administrador'), async (req, res) => {
  try {
    const resultado = await recalcularVentas();
    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reconciliación de precio/cantidad (caché en Mongo) desde inventario
// (MySQL) — mismo espíritu que recalcular-ventas. Ver catalogoSyncService.js.
router.post('/recalcular-inventario', requireAuth, requireRole('administrador'), async (req, res) => {
  try {
    const resultado = await recalcularInventario();
    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
