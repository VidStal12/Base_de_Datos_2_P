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
    version: { type: Number, default: 1 },
  },
  { timestamps: { createdAt: false, updatedAt: 'actualizado_en' } }
);

module.exports = model('Producto', productoSchema, 'productos');
