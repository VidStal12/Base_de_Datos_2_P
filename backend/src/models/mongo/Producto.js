const { Schema, model } = require('mongoose');

const atributoValorSchema = new Schema({ nombre: String, valor: String }, { _id: false });
const imagenSchema = new Schema(
  { url: String, alt: String, orden: Number, principal: Boolean },
  { _id: false }
);
// Anidado (no dos campos sueltos) para que la forma coincida con la que ya
// usa snapshot.inventario en ProductoEvento.js — mismo objeto {precio,
// cantidad} en los dos lugares, en vez de una forma acá y otra ahí.
const inventarioSchema = new Schema(
  { precio: { type: Number, required: true }, cantidad: { type: Number, required: true, default: 0 } },
  { _id: false }
);

// Oferta flash (Entrega 2, ver IA/ENTREGA-2-PLAN.md §4.2) — un cupo limitado
// a precio rebajado, separado del precio/stock normal de arriba. `activo` es
// un interruptor independiente de la ventana de fechas (permite pausar sin
// tocar las fechas, o dejar una oferta preparada de antemano con activo:false)
// — comprar exige las dos cosas a la vez: activo Y estar dentro de
// [vigente_desde, vigente_hasta]. stock_oferta es el tamaño ORIGINAL del pool,
// no el remanente en vivo — ese vive únicamente en Redis
// (`oferta:{producto_id}:stock`, ver ofertaFlashService.js), con TTL atado a
// vigente_hasta. No required: la mayoría de los productos nunca tiene una.
const ofertaFlashSchema = new Schema(
  {
    activo: { type: Boolean, default: false },
    precio_oferta: Number,
    stock_oferta: Number,
    revision: String,
    vigente_desde: Date,
    vigente_hasta: Date,
  },
  { _id: false }
);

// inventario: MySQL (`inventario`, la tabla) sigue siendo la única fuente
// transaccional — checkout sigue siendo una sola transacción de Prisma ahí,
// sin tocar Mongo en el medio (ver ADR-002 §3.2/§3.3). Esto es una copia de
// lectura, reenviada por productoService.js/checkoutService.js después de
// cada escritura en MySQL — mismo patrón de caché de lectura que
// vendedor_nombre/total_vendido. Así listar()/obtener() dejan de tener que
// cruzar a MySQL en cada lectura del catálogo. Puede haber una ventana breve
// de desactualización entre que MySQL cambia y el reenvío llega (es reenvío
// después del hecho, no una transacción distribuida) — se recalcula desde
// MySQL vía POST /api/admin/recalcular-inventario si alguna vez se desincroniza.
const productoSchema = new Schema(
  {
    // Entero de `producto.id` en MySQL, no un ObjectId — es lo que conecta
    // este documento con su fila relacional (id_vendedor, inventario).
    producto_id: { type: Number, required: true, unique: true },
    nombre: { type: String, required: true, trim: true },
    descripcion: { type: String, default: '', trim: true },
    estado: { type: String, default: 'activo' },
    subcategoria_id: { type: Schema.Types.ObjectId, ref: 'Subcategoria', required: true },
    // Referencia cruzada hacia MySQL (usuarios.id_usuario) — no hay FK real
    // entre bases, ver ADR-002 §6.3. vendedor_nombre es una caché de lectura.
    vendedor_id: { type: Number, required: true },
    vendedor_nombre: { type: String, required: true },
    inventario: { type: inventarioSchema, required: true },
    oferta_flash: ofertaFlashSchema,
    atributos: [atributoValorSchema],
    imagenes: [imagenSchema],
    resenas_resumen: {
      promedio: { type: Number, default: 0 },
      cantidad: { type: Number, default: 0 },
    },
    // Caché de solo lectura de MySQL (compra_detalle.cantidad, sumado por
    // producto) — igual que vendedor_nombre. Se actualiza en checkoutService.js
    // después de que la transacción de MySQL ya se confirmó, nunca al leer el
    // catálogo. Puede desactualizarse si ese paso falla; se recalcula desde
    // MySQL vía POST /api/admin/recalcular-ventas (ver catalogoSyncService.js).
    total_vendido: { type: Number, default: 0 },
    version: { type: Number, default: 1 },
  },
  { timestamps: { createdAt: false, updatedAt: 'actualizado_en' } }
);

// Requerimiento técnico de Entrega 1 (índice compuesto mapeado a un patrón de
// consulta real, ver ENTREGA-1-TRAZABILIDAD.md §2.3): "más vendidos dentro de
// esta subcategoría" es exactamente igualdad en el primer campo + orden por
// el segundo, el mismo patrón que {producto_id, fecha} en ProductoEvento.js.
productoSchema.index({ subcategoria_id: 1, total_vendido: -1 });

// Mismo patrón que el índice anterior, para "productos en este rango de
// precio dentro de esta subcategoría" — listar() ahora filtra precio
// directamente acá (ver productoService.js), en vez de resolverlo en MySQL
// y pasar los ids como $in. Ruta con punto porque precio quedó anidado
// dentro de inventario, no un campo de primer nivel.
productoSchema.index({ subcategoria_id: 1, 'inventario.precio': 1 });

// Patrón de consulta de la página /ofertas (productoService.listar,
// soloOfertas): igualdad sobre activo + rango sobre vigente_hasta, mismo
// criterio que el índice de precio de arriba.
productoSchema.index({ 'oferta_flash.activo': 1, 'oferta_flash.vigente_hasta': 1 });

module.exports = model('Producto', productoSchema, 'productos');
