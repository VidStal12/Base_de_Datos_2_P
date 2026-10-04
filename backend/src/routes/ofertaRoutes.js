const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const ofertaFlashService = require('../services/ofertaFlashService');
const { cuerpoDeError } = require('../utils/http');

const router = express.Router();

// Pública (sin auth) — el remanente EN VIVO de una oferta, mismo criterio que
// ver el precio normal de un producto. Conserva la ruta /stock y devuelve
// también los datos propios de la oferta para pintar su checkout desde Redis.
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
// rol tampoco — salvo que nadie compra lo que él mismo vende
// (productoService.verificarNoEsPropio, responde 403) y que una cuenta que puede
// vender acepte el compromiso de no reventa (compromisoService, responde 400
// con codigo COMPROMISO_NO_REVENTA).
router.post('/:productoId/comprar', requireAuth, async (req, res) => {
  try {
    const { cantidad, direccionId, metodoPagoId, precioEsperado, aceptaNoReventa } = req.body;
    const resultado = await ofertaFlashService.comprar(req.usuario.id_usuario, Number(req.params.productoId), {
      cantidad,
      direccionId,
      metodoPagoId,
      precioEsperado,
      aceptaNoReventa: aceptaNoReventa === true,
    });
    res.status(201).json(resultado);
  } catch (err) {
    res.status(err.status || 400).json(cuerpoDeError(err));
  }
});

module.exports = router;
