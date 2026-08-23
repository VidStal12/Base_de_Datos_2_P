const express = require('express');
const { registrar, login } = require('../services/authService');

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

module.exports = router;
