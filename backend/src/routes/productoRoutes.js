const express = require('express');
const { requireAuth, requireRole, optionalAuth } = require('../middleware/auth');
const productoService = require('../services/productoService');
const catalogoLectura = require('../services/catalogoLecturaService');
const resenaService = require('../services/resenaService');
const { responderError } = require('../utils/http');

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
  // Con Mongo apagado el catálogo se sirve del índice de búsqueda (catalogoLecturaService.js).
  const productos = await catalogoLectura.listar({ ...req.query, mostrarInactivos });
  res.json(productos);
});

// Antes de "/:id" a propósito — si no, Express intenta leer "estadisticas"
// como un id numérico y nunca llega acá.
// Solo administrador: es el widget «Productos más editados» del panel administrativo, y revela con
// qué frecuencia edita cada vendedor (y, de rebote, qué productos le importan a la competencia).
router.get('/estadisticas/ediciones', requireAuth, requireRole('administrador'), async (req, res) => {
  const desde = req.query.desde ? new Date(req.query.desde) : undefined;
  const estadisticas = await productoService.estadisticasEdiciones({ desde });
  res.json(estadisticas);
});

// Pública, pero el producto de un vendedor suspendido "no existe" para el público
// mientras dure la suspensión (ver productoService.listar y suspensionService): vuelve
// solo al levantarse. Un administrador sí lo ve — el panel necesita poder abrirlo —,
// y por eso la ruta mira el token (optionalAuth) sin exigirlo; igual que en el listado,
// a él se le marca como oculto para que la pantalla lo diga. Si quien pregunta tiene
// sesión y el producto sí le quedó visible Y está activo, se registra como su actividad
// reciente (catalogoLecturaService.js) para poder sugerírselo si después busca algo sin
// sentido; uno pausado (inactivo) se abre por su URL pero no queda como «lo último que viste».
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const producto = await catalogoLectura.obtener(Number(req.params.id));
    const oculto = await productoService.vendedorOculto(producto.vendedor_id);
    if (oculto && req.usuario?.rol !== 'administrador') {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }
    if (!oculto && producto.estado === 'activo') catalogoLectura.registrarVistaProducto(req.usuario?.id_usuario, producto.id);
    res.json(oculto ? { ...producto, vendedor_suspendido: true } : producto);
  } catch (err) {
    responderError(res, err, 404);
  }
});

// Historial de cambios (ver ADR-003). Sin ?fecha, devuelve la línea de tiempo
// completa de eventos; con ?fecha=AAAA-MM-DD, el snapshot vigente en esa fecha.
// Solo el vendedor DUEÑO del producto o un administrador: incluye precio/stock por
// versión y quién editó, que no es algo que un comprador —ni otro vendedor, que es
// su competencia— debería poder curiosear (historial de precios, patrones de
// reabastecimiento). El rol no alcanza: verificarPermiso comprueba el dueño contra MySQL.
router.get('/:id/historial', requireAuth, requireRole('vendedor', 'administrador'), async (req, res) => {
  try {
    const productoId = Number(req.params.id);
    if (!Number.isInteger(productoId) || productoId < 1) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }
    await productoService.verificarPermiso(req.usuario, productoId, 'ver el historial de');
    if (req.query.fecha) {
      const snapshot = await productoService.historialEnFecha(productoId, new Date(req.query.fecha));
      res.json(snapshot);
    } else {
      const eventos = await productoService.historialCompleto(productoId);
      res.json(eventos);
    }
  } catch (err) {
    responderError(res, err, 404);
  }
});
// Reseñas (reference, ver ADR-002 §6.1 y Resena.js) — listar es público,
// crear requiere sesión (cualquier rol, no solo comprador).
router.get('/:id/resenas', async (req, res) => {
  try {
    const resenas = await resenaService.listarPorProducto(Number(req.params.id));
    res.json(resenas);
  } catch (err) {
    responderError(res, err, 400);
  }
});

router.post('/:id/resenas', requireAuth, async (req, res) => {
  try {
    const resena = await resenaService.crear(req.usuario, Number(req.params.id), req.body);
    res.status(201).json(resena);
  } catch (err) {
    responderError(res, err, 400);
  }
});

router.post('/', requireAuth, requireRole('vendedor', 'administrador'), async (req, res) => {
  try {
    const producto = await productoService.crear(req.usuario, req.body);
    res.status(201).json(producto);
  } catch (err) {
    responderError(res, err, 400);
  }
});

router.patch('/:id', requireAuth, requireRole('vendedor', 'administrador'), async (req, res) => {
  try {
    const producto = await productoService.actualizar(req.usuario, Number(req.params.id), req.body);
    res.json(producto);
  } catch (err) {
    responderError(res, err, 400);
  }
});

module.exports = router;
