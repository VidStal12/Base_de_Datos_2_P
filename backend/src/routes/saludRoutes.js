const express = require('express');
const { optionalAuth } = require('../middleware/auth');
const estadoServicios = require('../services/estadoServiciosService');

const router = express.Router();

// Vivo: no toca ninguna base.
router.get('/', (req, res) => res.json({ status: 'ok' }));

// Qué base responde ahora (la interfaz avisa qué función está limitada; ver estadoServiciosService.js).
// Es pública —la franja de AvisoServicios la consulta sin sesión— pero solo con `ok` por componente: el
// texto del error del driver y los milisegundos los ve un administrador, con su token.
router.get('/componentes', optionalAuth, async (req, res) => {
  const estado = await estadoServicios.consultar();
  res.json(req.usuario?.rol === 'administrador' ? estado : estadoServicios.paraPublico(estado));
});

module.exports = router;
