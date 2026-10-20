const express = require('express');
const { requireAuth } = require('../middleware/auth');
const cartService = require('../services/cartService');
const { responderError } = require('../utils/http');

const router = express.Router();
// Todo el carrito requiere sesión iniciada — decisión de Entrega 2 (ver
// IA/ENTREGA-2-PLAN.md §4.1): antes era anónimo (localStorage), ahora se
// clave por usuario.id_usuario, así que no hay carrito sin saber quién es.
router.use(requireAuth);

router.get('/', async (req, res) => {
  try { res.json(await cartService.obtener(req.usuario.id_usuario)); }
  catch (err) { responderError(res, err, 500); }
});

router.post('/revisar', async (req, res) => {
  try { res.json(await cartService.revisar(req.usuario.id_usuario)); }
  catch (err) { responderError(res, err, 500); }
});

router.post('/items', async (req, res) => {
  try {
    const { productoId, cantidad } = req.body;
    const carrito = await cartService.agregar(req.usuario.id_usuario, Number(productoId), Number(cantidad));
    res.status(201).json(carrito);
  } catch (err) {
    responderError(res, err, 400);
  }
});

router.patch('/items/:productoId', async (req, res) => {
  try {
    const carrito = await cartService.actualizarCantidad(
      req.usuario.id_usuario,
      Number(req.params.productoId),
      Number(req.body.cantidad)
    );
    res.json(carrito);
  } catch (err) {
    responderError(res, err, 400);
  }
});

router.delete('/items/:productoId', async (req, res) => {
  const carrito = await cartService.quitar(req.usuario.id_usuario, Number(req.params.productoId));
  res.json(carrito);
});

router.delete('/', async (req, res) => {
  await cartService.vaciar(req.usuario.id_usuario);
  res.status(204).send();
});

module.exports = router;
