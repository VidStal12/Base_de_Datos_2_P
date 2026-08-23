const express = require('express');
const cors = require('cors');
const authRoutes = require('./routes/authRoutes');
const direccionRoutes = require('./routes/direccionRoutes');
const metodoPagoRoutes = require('./routes/metodoPagoRoutes');
const checkoutRoutes = require('./routes/checkoutRoutes');

const app = express();

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    mensaje: 'TiendaYa API — todavía no hay frontend, este backend solo expone /api/*',
    endpoints: [
      'GET /api/health',
      'POST /api/auth/registro',
      'POST /api/auth/login',
      'GET /api/auth/me (requiere token)',
      'POST|GET /api/direcciones (requiere token)',
      'DELETE /api/direcciones/:id (requiere token)',
      'POST|GET /api/metodos-pago (requiere token)',
      'DELETE /api/metodos-pago/:id (requiere token)',
      'POST /api/checkout (requiere token)',
    ],
  });
});
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.use('/api/auth', authRoutes);
app.use('/api/direcciones', direccionRoutes);
app.use('/api/metodos-pago', metodoPagoRoutes);
app.use('/api/checkout', checkoutRoutes);

module.exports = app;
