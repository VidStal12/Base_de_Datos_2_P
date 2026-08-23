const express = require('express');
const { registrar, login, obtenerPerfil } = require('../services/authService');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.post('/registro', async (req, res) => {
  try {
    const usuario = await registrar(req.body);
    res.status(201).json(usuario);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const resultado = await login(req.body);
    res.json(resultado);
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

router.get('/me', requireAuth, async (req, res) => {
  try {
    const usuario = await obtenerPerfil(req.usuario.id_usuario);
    res.json(usuario);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

module.exports = router;
