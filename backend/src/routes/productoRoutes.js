const express = require('express');
const { requireAuth, requireRole, optionalAuth } = require('../middleware/auth');
const productoService = require('../services/productoService');
const resenaService = require('../services/resenaService');

const router = express.Router();

// Pública (optionalAuth, no requireAuth) — pero un producto inactivo solo se
// incluye si quien pregunta demuestra con su propio token que tiene motivo
// para verlo: un administrador (ve cualquiera) o el vendedor dueño de esos
// productos (ve los suyos, filtrando por su propio vendedorId). Nunca se
// confía en un query param del cliente para esto — cualquiera podría mandar
// ?vendedorId=2 sin ser Luis; lo que importa es a quién dice el token que es.
router.get('/', optionalAuth, async (req, res) => {
  const mostrarInactivos =
    req.usuario?.rol === 'administrador' ||
    (req.usuario?.rol === 'vendedor' && String(req.usuario.id_usuario) === String(req.query.vendedorId));
  const productos = await productoService.listar({ ...req.query, mostrarInactivos });
  res.json(productos);
});

// Antes de "/:id" a propósito — si no, Express intenta leer "estadisticas"
// como un id numérico y nunca llega acá.
router.get('/estadisticas/ediciones', async (req, res) => {
  const desde = req.query.desde ? new Date(req.query.desde) : undefined;
  const estadisticas = await productoService.estadisticasEdiciones({ desde });
  res.json(estadisticas);
});

// Pública, pero el producto de un vendedor suspendido "no existe" para el público
// mientras dure la suspensión (ver productoService.listar y suspensionService): vuelve
// solo al levantarse. Un administrador sí lo ve — el panel necesita poder abrirlo —,
// y por eso la ruta mira el token (optionalAuth) sin exigirlo; igual que en el listado,
// a él se le marca como oculto para que la pantalla lo diga.
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const producto = await productoService.obtener(Number(req.params.id));
    const oculto = await productoService.vendedorOculto(producto.vendedor_id);
    if (oculto && req.usuario?.rol !== 'administrador') {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }
    res.json(oculto ? { ...producto, vendedor_suspendido: true } : producto);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// Historial de cambios (ver ADR-003). Sin ?fecha, devuelve la línea de tiempo
// completa de eventos; con ?fecha=AAAA-MM-DD, el snapshot vigente en esa fecha.
// Solo vendedor/administrador: ahora incluye precio/stock por versión, que no
// es algo que un comprador debería poder curiosear (historial de precios,
// patrones de reabastecimiento).
router.get('/:id/historial', requireAuth, requireRole('vendedor', 'administrador'), async (req, res) => {
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
// Reseñas (reference, ver ADR-002 §6.1 y Resena.js) — listar es público,
// crear requiere sesión (cualquier rol, no solo comprador).
router.get('/:id/resenas', async (req, res) => {
  try {
    const resenas = await resenaService.listarPorProducto(Number(req.params.id));
    res.json(resenas);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/resenas', requireAuth, async (req, res) => {
  try {
    const resena = await resenaService.crear(req.usuario, Number(req.params.id), req.body);
    res.status(201).json(resena);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
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
