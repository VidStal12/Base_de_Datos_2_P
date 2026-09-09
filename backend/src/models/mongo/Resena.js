const { Schema, model } = require('mongoose');

// Reference, no embebido (ver ADR-002 §6.1: volumen no acotado — un producto
// puede acumular miles de reseñas, y cada reseña casi no se re-edita después
// de creada). Colección propia, referenciando producto_id — el resumen
// (promedio/cantidad) se sigue embebiendo en Producto.resenas_resumen como
// caché de solo lectura (computed reference), recalculada desde acá.
const resenaSchema = new Schema(
  {
    // Entero de `producto.id` en MySQL (mismo criterio que Producto.producto_id
    // en Producto.js) — no un ObjectId.
    producto_id: { type: Number, required: true },
    // Referencia cruzada hacia MySQL (usuarios.id_usuario), sin FK real entre
    // bases — mismo patrón que vendedor_id en Producto.js (ver ADR-002 §6.3).
    usuario_id: { type: Number, required: true },
    // Caché de solo lectura resuelta una vez al crear la reseña — igual que
    // vendedor_nombre en Producto.js, para no cruzar a MySQL en cada lectura.
    usuario_nombre: { type: String, required: true },
    calificacion: { type: Number, required: true, min: 1, max: 5 },
    comentario: { type: String, trim: true, maxlength: 1000, default: '' },
    fecha: { type: Date, required: true, default: Date.now },
  },
  { timestamps: false }
);

// Patrón de consulta real: reseñas de un producto, más recientes primero —
// mismo criterio que {producto_id, fecha} en ProductoEvento.js.
resenaSchema.index({ producto_id: 1, fecha: -1 });

module.exports = model('Resena', resenaSchema, 'resenas');