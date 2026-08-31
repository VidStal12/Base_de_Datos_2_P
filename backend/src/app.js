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
const cartRoutes = require('./routes/cartRoutes');

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
      'GET /api/productos (filtros: ?categoriaId=, ?subcategoriaId=, ?q=, ?vendedorId=, ?atributos=<JSON {nombre:valor}>, ?precioMin=, ?precioMax=, ?ordenarPor=masVendidos)',
      'GET /api/productos/estadisticas/ediciones (agregación: total de eventos por producto, ordenado por más editado; ?desde=AAAA-MM-DD opcional)',
      'GET /api/productos/:id',
      'GET /api/productos/:id/historial (requiere token, rol vendedor/administrador — ?fecha=AAAA-MM-DD para reconstrucción; sin fecha, línea de tiempo completa)',
      'POST /api/productos (requiere token, rol vendedor/administrador)',
      'PATCH /api/productos/:id (requiere token, rol vendedor/administrador — dueño del producto o administrador)',
      'GET /api/carrito (requiere token — Redis, TTL de 7.5 min por inactividad, ver IA/ENTREGA-2-PLAN.md §4.1)',
      'POST /api/carrito/items (requiere token — {productoId, cantidad}, suma a lo ya existente, clamp contra stock)',
      'PATCH /api/carrito/items/:productoId (requiere token — {cantidad}, fija la cantidad exacta)',
      'DELETE /api/carrito/items/:productoId (requiere token)',
      'DELETE /api/carrito (requiere token — vaciar completo)',
      'POST /api/checkout (requiere token)',
      'GET /api/compras (requiere token — pedidos del usuario autenticado)',
      'GET /api/compras/:id (requiere token)',
      'POST /api/admin/recalcular-ventas (requiere token, rol administrador — recalcula total_vendido desde compra_detalle, sobrescribe la caché)',
      'POST /api/admin/recalcular-inventario (requiere token, rol administrador — recalcula precio/cantidad desde inventario (MySQL), sobrescribe la caché)',
    ],
  });
});
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.use('/api/auth', authRoutes);
app.use('/api/direcciones', direccionRoutes);
app.use('/api/metodos-pago', metodoPagoRoutes);
app.use('/api/categorias', categoriaRoutes);
app.use('/api/productos', productoRoutes);
app.use('/api/carrito', cartRoutes);
app.use('/api/checkout', checkoutRoutes);
app.use('/api/compras', compraRoutes);
app.use('/api/admin', adminRoutes);

module.exports = app;
