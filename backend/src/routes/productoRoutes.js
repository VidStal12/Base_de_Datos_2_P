const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const productoService = require('../services/productoService');

const router = express.Router();

router.get('/', async (req, res) => {
  const productos = await productoService.listar(req.query);
  res.json(productos);
});

// Antes de "/:id" a propósito — si no, Express intenta leer "estadisticas"
// como un id numérico y nunca llega acá.
router.get('/estadisticas/ediciones', async (req, res) => {
  const desde = req.query.desde ? new Date(req.query.desde) : undefined;
  const estadisticas = await productoService.estadisticasEdiciones({ desde });
  res.json(estadisticas);
});

router.get('/:id', async (req, res) => {
  try {
    const producto = await productoService.obtener(Number(req.params.id));
    res.json(producto);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// Historial de cambios (ver ADR-003). Sin ?fecha, devuelve la línea de tiempo
// completa de eventos; con ?fecha=AAAA-MM-DD, el snapshot vigente en esa fecha.
router.get('/:id/historial', async (req, res) => {
  try {
    const productoId = Number(req.params.id);
    if (req.query.fecha) {
      const snapshot = await productoService.historialEnFecha(productoId, new Date(req.query.fecha));
      res.json(snapshot);
    } else {
      const eventos = await productoService.historialCompleto(productoId);
      res.json(eventos);
    }
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

router.patch('/:id', requireAuth, requireRole('vendedor', 'administrador'), async (req, res) => {
  try {
    const producto = await productoService.actualizar(req.usuario, Number(req.params.id), req.body);
    res.json(producto);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

module.exports = router;
