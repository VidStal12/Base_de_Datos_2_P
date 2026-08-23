const { Schema, model } = require('mongoose');

const subcategoriaSchema = new Schema({
  categoria_id: { type: Schema.Types.ObjectId, ref: 'Categoria', required: true },
  subcategoria: { type: String, required: true },
  // Plantilla de atributos que aplican a esta subcategoría (ver ADR-002 §3.1) —
  // reemplaza a la tabla relacional atributo_categoria.
  atributos_definidos: [{ type: String }],
});

module.exports = model('Subcategoria', subcategoriaSchema, 'subcategorias');
