const express = require('express');
const cors = require('cors');
const authRoutes = require('./routes/authRoutes');
const checkoutRoutes = require('./routes/checkoutRoutes');

const app = express();

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    mensaje: 'TiendaYa API — todavía no hay frontend, este backend solo expone /api/*',
    endpoints: ['GET /api/health', 'POST /api/auth/registro', 'POST /api/auth/login', 'POST /api/checkout'],
  });
});
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.use('/api/auth', authRoutes);
app.use('/api/checkout', checkoutRoutes);

module.exports = app;
