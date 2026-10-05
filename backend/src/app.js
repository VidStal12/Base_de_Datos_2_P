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
const ofertaRoutes = require('./routes/ofertaRoutes');
const recomendacionRoutes = require('./routes/recomendacionRoutes');
const busquedaRoutes = require('./routes/busquedaRoutes');

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
            'GET /api/productos/:id/resenas (reseñas de un producto, público)',
      'POST /api/productos/:id/resenas (requiere token — {calificacion, comentario})',
      'POST /api/productos (requiere token, rol vendedor/administrador)',
      'PATCH /api/productos/:id (requiere token, rol vendedor/administrador — dueño del producto o administrador)',
      'GET /api/carrito (requiere token — copia propia en Redis; MySQL solo al recuperar la caché)',
      'POST /api/carrito/revisar (requiere token — actualiza información y valida disponibilidad al entrar al checkout)',
      'POST /api/carrito/items (requiere token — {productoId, cantidad}, suma a lo ya existente, clamp contra stock)',
      'PATCH /api/carrito/items/:productoId (requiere token — {cantidad}, fija la cantidad exacta)',
      'DELETE /api/carrito/items/:productoId (requiere token)',
      'DELETE /api/carrito (requiere token — vaciar completo)',
      'POST /api/checkout (requiere token — {direccionId, metodoPagoId, items?, aceptaNoReventa?}; 403 si algún producto es del propio comprador; las cuentas vendedor/administrador deben mandar aceptaNoReventa:true o reciben 400 con codigo COMPROMISO_NO_REVENTA, ver IA/PLAN-NEO4J-DETECCION-FRAUDE.md §19)',
      'GET /api/compras (requiere token — pedidos del usuario autenticado)',
      'GET /api/compras/:id (requiere token)',
      'GET /api/admin/ventas (solo administrador — desde/hasta inclusivos, intervalo dia/semana/mes, productoId, minUnidades)',
      'GET /api/admin/fraude (solo administrador — reseñas coordinadas, gasto anómalo, categoría inusual, cuentas de una misma persona (mismo nombre o mismo buzón de correo), ráfaga de gasto, autocompra y reventa de lo comprado, ver IA/PLAN-NEO4J-DETECCION-FRAUDE.md §17-§19)',
      'POST /api/admin/recalcular-ventas (requiere token, rol administrador — recalcula total_vendido desde compra_detalle, sobrescribe la caché)',
      'POST /api/admin/recalcular-inventario (requiere token, rol administrador — recalcula precio/cantidad desde inventario (MySQL), sobrescribe la caché)',
      'GET /api/ofertas/:productoId/stock (datos propios de la oferta en Redis y remanente en vivo)',
      'PATCH /api/ofertas/:productoId (requiere token, rol vendedor/administrador — dueño del producto o administrador; configura/pausa la oferta)',
      'POST /api/ofertas/:productoId/comprar (requiere token — {cantidad, direccionId, metodoPagoId, precioEsperado?, aceptaNoReventa?}, compra directa al precio de oferta; mismas reglas de producto propio y de compromiso de no reventa que el checkout)',
      'GET /api/recomendaciones (requiere token — analiza el historial de compras del usuario y encuentra productos similares de otros vendedores, ver IA/ENTREGA-2-PLAN.md §4.5)',
      'POST /api/recomendaciones/:productoId/comprar (requiere token — {cantidad, direccionId, metodoPagoId, aceptaNoReventa?}, compra al precio recomendado, cupo personal limitado; mismas reglas de producto propio y de compromiso de no reventa que el checkout)',
      'GET /api/busqueda (Elasticsearch — ?q=, ?categoriaId=, ?subcategoriaId=, ?atributos=<JSON>, ?precioMin=, ?precioMax=, ?ordenarPor=masVendidos; tolerancia ortográfica + facetas agregadas, ver IA/PLAN-ELASTICSEARCH-BUSQUEDA.md)',
      'GET /api/busqueda/sugerencias?q= (autocompletado — completion suggester con tolerancia a errores, solo productos activos)',
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
app.use('/api/ofertas', ofertaRoutes);
app.use('/api/recomendaciones', recomendacionRoutes);
app.use('/api/busqueda', busquedaRoutes);

module.exports = app;
