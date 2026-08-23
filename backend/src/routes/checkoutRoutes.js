const express = require('express');
const { checkout } = require('../services/checkoutService');

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const resultado = await checkout(req.body);
    res.status(201).json(resultado);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
