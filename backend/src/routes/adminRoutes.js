const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { recalcularVentas, recalcularInventario } = require('../services/catalogoSyncService');
const { consultarVentas } = require('../services/ventasService');
const { consultarFraude } = require('../services/fraudeService');

const router = express.Router();

// Solo administradores pueden leer el informe. Cassandra caída es un error
// explícito: una respuesta vacía no debe confundirse con cero ventas.
router.get('/ventas', requireAuth, requireRole('administrador'), async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await consultarVentas(req.query));
  } catch (err) {
    const status = [400, 422].includes(err.status) ? err.status : 503;
    if (status === 503) console.error('No se pudo consultar el panel de ventas:', err.message);
    res.status(status).json({ error: status === 503 ? 'El informe de ventas no está disponible. Intenta nuevamente en unos momentos.' : err.message });
  }
});

// Señales de posible fraude (ver IA/PLAN-NEO4J-DETECCION-FRAUDE.md) — nunca
// una acusación, candidatos para revisión humana. Solo administrador, mismo
// criterio que /ventas.
router.get('/fraude', requireAuth, requireRole('administrador'), async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await consultarFraude());
  } catch (err) {
    console.error('No se pudo consultar las señales de fraude:', err.message);
    res.status(503).json({ error: 'Las señales de fraude no están disponibles. Intenta nuevamente en unos momentos.' });
  }
});

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
