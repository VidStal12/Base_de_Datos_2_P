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
const adminAccesoRoutes = require('./routes/adminAccesoRoutes');
const cartRoutes = require('./routes/cartRoutes');
const ofertaRoutes = require('./routes/ofertaRoutes');
const recomendacionRoutes = require('./routes/recomendacionRoutes');
const busquedaRoutes = require('./routes/busquedaRoutes');
const { manejarErrores } = require('./utils/http');
const saludRoutes = require('./routes/saludRoutes');

const app = express();

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    mensaje: 'TiendaYa API — todavía no hay frontend, este backend solo expone /api/*',
    endpoints: [
      'GET /api/health',
      'GET /api/health/componentes (qué base de datos responde ahora: mysql, mongo, redis, elasticsearch, neo4j, cassandra; estado completo/degradado/critico. Público solo con ok por componente; con token de administrador, también milisegundos y el texto del error)',
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
      'GET /api/productos/estadisticas/ediciones (requiere token de administrador — agregación: total de eventos por producto, ordenado por más editado; ?desde=AAAA-MM-DD opcional)',
      'GET /api/productos/:id',
      'GET /api/productos/:id/relacionados (productos parecidos por significado —vectores en Elasticsearch—; { modo: semantico | subcategoria | ninguno, subcategoria?, productos }; sesión opcional: con sesión no se ofrecen los productos del propio vendedor; ver IA/ADR-006)',
      'GET /api/productos/:id/historial (requiere token: el vendedor DUEÑO del producto o un administrador — ?fecha=AAAA-MM-DD para reconstrucción; sin fecha, línea de tiempo completa)',
            'GET /api/productos/:id/resenas (reseñas de un producto, público; el autor aparece como alias —«Ana G.»—, sin id ni nombre completo)',
      'POST /api/productos/:id/resenas (requiere token — {calificacion, comentario})',
      'POST /api/productos (requiere token, rol vendedor/administrador)',
      'PATCH /api/productos/:id (requiere token, rol vendedor/administrador — dueño del producto o administrador)',
      'GET /api/carrito (requiere token — copia propia en Redis; MySQL solo al recuperar la caché)',
      'POST /api/carrito/revisar (requiere token — actualiza información y valida disponibilidad al entrar al checkout)',
      'POST /api/carrito/items (requiere token — {productoId, cantidad}, suma a lo ya existente, clamp contra stock)',
      'PATCH /api/carrito/items/:productoId (requiere token — {cantidad}, fija la cantidad exacta)',
      'DELETE /api/carrito/items/:productoId (requiere token)',
      'DELETE /api/carrito (requiere token — vaciar completo)',
      'POST /api/checkout/intentos (requiere token — prepara o recupera el intento de la versión actual del carrito)',
      'GET /api/checkout/intentos/:id (requiere token del propietario — consulta estado y compraId)',
      'POST /api/checkout/intentos/:id/cancelar (requiere token del propietario — verifica el resultado antes de cancelar)',
      'POST /api/checkout (requiere token — {intentoId, direccionId, metodoPagoId, items, aceptaNoReventa?}; idempotente: 201 al crear, 200 al recuperar; 403 si algún producto es del propio comprador; vendedor/administrador deben aceptar el compromiso de no reventa)',
      'GET /api/compras (requiere token — pedidos del usuario autenticado)',
      'GET /api/compras/:id (requiere token)',
      'GET /api/admin/ventas (solo administrador — desde/hasta inclusivos, intervalo dia/semana/mes, productoId, minUnidades)',
      'GET /api/admin/fraude (solo administrador — reseñas coordinadas, gasto anómalo, categoría inusual, cuentas de una misma persona (mismo nombre o mismo buzón de correo), ráfaga de gasto, autocompra y reventa de lo comprado, ver IA/PLAN-NEO4J-DETECCION-FRAUDE.md §17-§19)',
      'GET /api/admin/bloqueos (solo administrador — cuentas suspendidas temporalmente por fraude de confianza alta, pendientes de revisión primero, más el historial; ver IA/PLAN-NEO4J-DETECCION-FRAUDE.md §20)',
      'POST /api/admin/bloqueos/evaluar (solo administrador — corre ahora el barrido que suspende cuentas con un hallazgo alto)',
      'POST /api/admin/bloqueos/:usuarioId/liberar (solo administrador — {nota?}, levanta la suspensión: era un falso positivo)',
      'POST /api/admin/bloqueos/:usuarioId/quitar-restriccion (solo administrador — {nota?}, quita los límites suaves de una cuenta bajo vigilancia: un hallazgo «posible»; ver IA/PLAN-NEO4J-DETECCION-FRAUDE.md §21)',
      'POST /api/admin/bloqueos/:usuarioId/extender (solo administrador — {horas, nota?}, mantiene la suspensión y le suma tiempo)',
      'POST /api/admin/recalcular-ventas (requiere token, rol administrador — recalcula total_vendido desde compra_detalle, sobrescribe la caché)',
      'POST /api/admin/recalcular-inventario (requiere token, rol administrador — recalcula precio/cantidad desde inventario (MySQL), sobrescribe la caché)',
      'GET /api/admin/permisos (solo administrador — la matriz de permisos: roles × rutas editables, lo que declara el código y lo que cambió un administrador; ver IA/ADR-007 §9)',
      'PUT /api/admin/permisos (solo administrador — {cambios:[{clave, rol, permitido}]}, todo o nada, auditado)',
      'POST /api/admin/permisos/restaurar (solo administrador — {clave?, rol?}: vuelve a lo que declara el código)',
      'GET /api/admin/permisos/simular (solo administrador — ?clave=GET /api/admin/ventas&rol=vendedor, o &usuarioId=: la misma decisión que aplica la API, con el motivo)',
      'POST /api/admin/roles | DELETE /api/admin/roles/:id (solo administrador — crea un rol sin permisos extra, o borra uno que nadie usa)',
      'GET /api/admin/usuarios (solo administrador — ?q=, ?pagina=, ?tamano=) | PATCH /api/admin/usuarios/:id/rol ({rol}; no la propia cuenta, siempre queda otro administrador)',
      'GET /api/admin/auditoria (solo administrador — ?tipo=cambios|regla|restaurar|rol_cuenta|rol_creado|rol_eliminado|denegacion, ?actor=, ?desde=, ?hasta=AAAA-MM-DD, ?pagina=) | GET /api/admin/auditoria/exportar (CSV)',
      'GET /api/ofertas/:productoId/stock (datos propios de la oferta en Redis y remanente en vivo)',
      'PATCH /api/ofertas/:productoId (requiere token, rol vendedor/administrador — dueño del producto o administrador; configura/pausa la oferta)',
      'POST /api/ofertas/:productoId/intentos (requiere token — prepara un intento compartido; {anteriorIntentoId} para otra compra explícita)',
      'POST /api/ofertas/:productoId/comprar (requiere token — {intentoId, cantidad, direccionId, metodoPagoId, precioEsperado?, aceptaNoReventa?}, compra idempotente al precio de oferta; mismas reglas de producto propio y de compromiso de no reventa que el checkout)',
      'GET /api/recomendaciones (requiere token — analiza el historial de compras del usuario y encuentra productos similares de otros vendedores, ver IA/ENTREGA-2-PLAN.md §4.5)',
      'POST /api/recomendaciones/:productoId/comprar (requiere token — {cantidad, direccionId, metodoPagoId, aceptaNoReventa?}, compra al precio recomendado, cupo personal limitado; mismas reglas de producto propio y de compromiso de no reventa que el checkout)',
      'GET /api/busqueda (Elasticsearch — búsqueda Y navegación por categorías en una sola consulta; ?q= (vacío = navegar), ?categoriaId=, ?subcategoriaId=, ?atributos=<JSON {nombre: valor | [valores]}>, ?precioMin=, ?precioMax=, ?ordenarPor=masVendidos|precioAsc|precioDesc, ?pagina=, ?tamano= (hasta 100); responde resultados + árbol de categorías con conteos + facetas de atributos y de precio calculadas con agregaciones disyuntivas, ver IA/PLAN-ELASTICSEARCH-BUSQUEDA.md §15; sesión OPCIONAL: con Authorization: Bearer y un texto sin resultados suma sugeridos + origenSugerencia, ver §16)',
      'GET /api/busqueda/sugerencias?q= (autocompletado — completion suggester con tolerancia a errores, solo productos activos)',
    ],
  });
});
// GET /api/health y GET /api/health/componentes (qué base responde ahora; ver saludRoutes.js).
app.use('/api/health', saludRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/direcciones', direccionRoutes);
app.use('/api/metodos-pago', metodoPagoRoutes);
app.use('/api/categorias', categoriaRoutes);
app.use('/api/productos', productoRoutes);
app.use('/api/carrito', cartRoutes);
app.use('/api/checkout', checkoutRoutes);
app.use('/api/compras', compraRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin', adminAccesoRoutes);
app.use('/api/ofertas', ofertaRoutes);
app.use('/api/recomendaciones', recomendacionRoutes);
app.use('/api/busqueda', busquedaRoutes);

// Último eslabón: una ruta que deja escapar un error (o una base caída) responde con un
// mensaje claro y el estado correcto, no con la traza de Express (ver utils/http.js).
app.use(manejarErrores);

module.exports = app;
