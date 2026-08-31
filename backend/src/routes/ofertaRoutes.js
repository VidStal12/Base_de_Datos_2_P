const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const ofertaFlashService = require('../services/ofertaFlashService');

const router = express.Router();

// Pública (sin auth) — el remanente EN VIVO de una oferta, mismo criterio que
// ver el precio normal de un producto. En /:productoId/stock, no en
// /:productoId, para que quede claro que esto es solo el contador en vivo,
// no la configuración completa (ver ofertaFlashService.consultarStock).
router.get('/:productoId/stock', async (req, res) => {
  try {
    const info = await ofertaFlashService.consultarStock(Number(req.params.productoId));
    res.json(info);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// Configurar/pausar la oferta — misma regla de pertenencia que editar el
// producto en sí (vendedor dueño o administrador).
router.patch('/:productoId', requireAuth, requireRole('vendedor', 'administrador'), async (req, res) => {
  try {
    const producto = await ofertaFlashService.actualizar(req.usuario, Number(req.params.productoId), req.body);
    res.json(producto);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// Compra directa de una oferta flash — separada del carrito/checkout normal
// a propósito (ver ENTREGA-2-PLAN.md §4.2). Cualquier usuario autenticado,
// no solo compradores: nada en el resto del catálogo restringe comprar por
// rol tampoco.
router.post('/:productoId/comprar', requireAuth, async (req, res) => {
  try {
    const { cantidad, direccionId, metodoPagoId } = req.body;
    const resultado = await ofertaFlashService.comprar(req.usuario.id_usuario, Number(req.params.productoId), {
      cantidad,
      direccionId,
      metodoPagoId,
    });
    res.status(201).json(resultado);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

module.exports = router;
