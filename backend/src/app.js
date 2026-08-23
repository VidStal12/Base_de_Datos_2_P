const express = require('express');
const cors = require('cors');
const authRoutes = require('./routes/authRoutes');
const direccionRoutes = require('./routes/direccionRoutes');
const metodoPagoRoutes = require('./routes/metodoPagoRoutes');
const categoriaRoutes = require('./routes/categoriaRoutes');
const productoRoutes = require('./routes/productoRoutes');
const checkoutRoutes = require('./routes/checkoutRoutes');
const compraRoutes = require('./routes/compraRoutes');

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
      'GET /api/categorias',
      'POST /api/categorias (requiere token, rol vendedor/administrador)',
      'POST /api/categorias/:id/subcategorias (requiere token, rol vendedor/administrador)',
      'POST /api/categorias/subcategorias/:id/atributos (requiere token, rol vendedor/administrador)',
      'GET /api/productos (filtros: ?categoriaId= o ?subcategoriaId=)',
      'GET /api/productos/:id',
      'POST /api/productos (requiere token, rol vendedor/administrador)',
      'PATCH /api/productos/:id/inventario (requiere token, rol vendedor/administrador)',
      'POST /api/checkout (requiere token)',
      'GET /api/compras (requiere token — pedidos del usuario autenticado)',
      'GET /api/compras/:id (requiere token)',
    ],
  });
});
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.use('/api/auth', authRoutes);
app.use('/api/direcciones', direccionRoutes);
app.use('/api/metodos-pago', metodoPagoRoutes);
app.use('/api/categorias', categoriaRoutes);
app.use('/api/productos', productoRoutes);
app.use('/api/checkout', checkoutRoutes);
app.use('/api/compras', compraRoutes);

module.exports = app;
