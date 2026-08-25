const { Schema, model } = require('mongoose');

const atributoValorSchema = new Schema({ nombre: String, valor: String }, { _id: false });
const imagenSchema = new Schema(
  { url: String, alt: String, orden: Number, principal: Boolean },
  { _id: false }
);

// precio/cantidad NO viven acá — se quedan en `inventario` (MySQL). Ver
// ADR-002 §3.2: mover el stock a Mongo hubiera roto la atomicidad del
// checkout, que sigue siendo una sola transacción de Prisma sobre MySQL.
const productoSchema = new Schema(
  {
    // Entero de `producto.id` en MySQL, no un ObjectId — es lo que conecta
    // este documento con su fila relacional (id_vendedor, inventario).
    producto_id: { type: Number, required: true, unique: true },
    descripcion: { type: String, required: true },
    estado: { type: String, default: 'activo' },
    subcategoria_id: { type: Schema.Types.ObjectId, ref: 'Subcategoria', required: true },
    // Referencia cruzada hacia MySQL (usuarios.id_usuario) — no hay FK real
    // entre bases, ver ADR-002 §6.3. vendedor_nombre es una caché de lectura.
    vendedor_id: { type: Number, required: true },
    vendedor_nombre: { type: String, required: true },
    atributos: [atributoValorSchema],
    imagenes: [imagenSchema],
    resenas_resumen: {
      promedio: { type: Number, default: 0 },
      cantidad: { type: Number, default: 0 },
    },
    // Caché de solo lectura de MySQL (compra_detalle.cantidad, sumado por
    // producto) — igual que vendedor_nombre. Se actualiza en checkoutRoutes.js
    // después de que la compra ya se confirmó en MySQL, nunca al leer el
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

module.exports = model('Producto', productoSchema, 'productos');
