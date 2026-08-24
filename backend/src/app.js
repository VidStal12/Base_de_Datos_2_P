const express = require('express');
const cors = require('cors');
const authRoutes = require('./routes/authRoutes');
const direccionRoutes = require('./routes/direccionRoutes');
const metodoPagoRoutes = require('./routes/metodoPagoRoutes');
const categoriaRoutes = require('./routes/categoriaRoutes');
const productoRoutes = require('./routes/productoRoutes');
const checkoutRoutes = require('./routes/checkoutRoutes');
const compraRoutes = require('./routes/compraRoutes');
const adminRoutes = require('./routes/adminRoutes');

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
      'DELETE /api/direcciones/:id (requiere token; 409 si tiene pedidos asociados)',
      'POST|GET /api/metodos-pago (requiere token)',
      'DELETE /api/metodos-pago/:id (requiere token; 409 si tiene pagos asociados)',
      'GET /api/categorias',
      'POST /api/categorias (requiere token, rol vendedor/administrador)',
      'POST /api/categorias/:id/subcategorias (requiere token, rol vendedor/administrador)',
      'POST /api/categorias/subcategorias/:id/atributos (requiere token, rol vendedor/administrador)',
      'GET /api/productos (filtros: ?categoriaId=, ?subcategoriaId=, ?q=, ?vendedorId=, ?atributos=<JSON {nombre:valor}>)',
      'GET /api/productos/estadisticas/ediciones (agregación: total de eventos por producto, ordenado por más editado; ?desde=AAAA-MM-DD opcional)',
      'GET /api/productos/:id',
      'GET /api/productos/:id/historial (?fecha=AAAA-MM-DD para reconstrucción; sin fecha, línea de tiempo completa)',
      'POST /api/productos (requiere token, rol vendedor/administrador)',
      'PATCH /api/productos/:id (requiere token, rol vendedor/administrador — dueño del producto o administrador)',
      'POST /api/checkout (requiere token)',
      'GET /api/compras (requiere token — pedidos del usuario autenticado)',
      'GET /api/compras/:id (requiere token)',
      'POST /api/admin/sync-catalogo (requiere token, rol administrador — agrega a Mongo lo que falte, no destructivo)',
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
app.use('/api/admin', adminRoutes);

module.exports = app;
