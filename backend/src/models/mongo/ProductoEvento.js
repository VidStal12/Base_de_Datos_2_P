const { Schema, model } = require('mongoose');

// Append-only: nunca se actualiza ni se borra un documento de esta colección.
// Cada evento es un snapshot completo del contenido descriptivo del producto
// en ese momento (no un delta) — ver ADR-003 §2 sobre por qué.
const productoEventoSchema = new Schema({
  producto_id: { type: Number, required: true },
  version: { type: Number, required: true },
  tipo: { type: String, enum: ['creacion', 'edicion'], required: true },
  fecha: { type: Date, required: true, default: Date.now },
  usuario_id: { type: Number, required: true },
  campos_modificados: [{ type: String }],
  snapshot: { type: Schema.Types.Mixed, required: true },
});

// El índice que pide el PRD como requerimiento técnico de Entrega 1 — sale
// directo del patrón de consulta de la reconstrucción por fecha (ADR-003 §3.4).
productoEventoSchema.index({ producto_id: 1, fecha: -1 });

module.exports = model('ProductoEvento', productoEventoSchema, 'producto_eventos');
