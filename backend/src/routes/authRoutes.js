const express = require('express');
const { registrar, login, obtenerPerfil } = require('../services/authService');
const { requireAuth } = require('../middleware/auth');
const { responderError } = require('../utils/http');
const { componenteCaido } = require('../utils/resiliencia');

const router = express.Router();

router.post('/registro', async (req, res) => {
  try {
    const usuario = await registrar(req.body);
    res.status(201).json(usuario);
  } catch (err) {
    responderError(res, err, 400);
  }
});

router.post('/login', async (req, res) => {
  try {
    const resultado = await login(req.body);
    res.json(resultado);
  } catch (err) {
    // Una base apagada NO es «credenciales inválidas»: 503 con el aviso de qué falta
    // (antes devolvía 401 con el mensaje crudo de Prisma, y la interfaz mostraba eso).
    if (componenteCaido(err)) return responderError(res, err);
    // 401 para credenciales inválidas; 403 con `codigo` si la cuenta está
    // suspendida (la interfaz reacciona al código, no al texto).
    res.status(err.status ?? 401).json({ error: err.message, ...(err.codigo && { codigo: err.codigo, hasta: err.hasta }) });
  }
});

router.get('/me', requireAuth, async (req, res) => {
  try {
    const usuario = await obtenerPerfil(req.usuario.id_usuario);
    res.json(usuario);
  } catch (err) {
    // 404 solo si la cuenta no existe: con MySQL apagado es 503, y la interfaz NO debe
    // interpretarlo como «sesión inválida» y cerrarla.
    responderError(res, err, 404);
  }
});

module.exports = router;
