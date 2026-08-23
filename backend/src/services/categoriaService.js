const { conectar } = require('../config/mongo');
const Categoria = require('../models/mongo/Categoria');
const Subcategoria = require('../models/mongo/Subcategoria');

// Los ids ahora son ObjectId de Mongo (strings), no enteros — ver ADR-002.
async function listar() {
  await conectar();
  const categorias = await Categoria.find().lean();
  const subcategorias = await Subcategoria.find().lean();

  return categorias.map((cat) => ({
    id: String(cat._id),
    categoria: cat.categoria,
    subcategorias: subcategorias
      .filter((sub) => String(sub.categoria_id) === String(cat._id))
      .map((sub) => ({
        id: String(sub._id),
        id_categoria: String(sub.categoria_id),
        subcategoria: sub.subcategoria,
        atributos_categoria: sub.atributos_definidos,
      })),
  }));
}

async function crear({ categoria }) {
  if (!categoria) throw new Error('El nombre de la categoría es obligatorio');
  await conectar();
  const doc = await Categoria.create({ categoria });
  return { id: String(doc._id), categoria: doc.categoria };
}

async function crearSubcategoria(categoriaId, { subcategoria }) {
  if (!subcategoria) throw new Error('El nombre de la subcategoría es obligatorio');
  await conectar();
  const cat = await Categoria.findById(categoriaId);
  if (!cat) throw new Error('Categoría no encontrada');
  const doc = await Subcategoria.create({ categoria_id: cat._id, subcategoria, atributos_definidos: [] });
  return { id: String(doc._id), id_categoria: String(doc.categoria_id), subcategoria: doc.subcategoria };
}

async function crearAtributo(subcategoriaId, { atributo }) {
  if (!atributo) throw new Error('El nombre del atributo es obligatorio');
  await conectar();
  const sub = await Subcategoria.findById(subcategoriaId);
  if (!sub) throw new Error('Subcategoría no encontrada');
  if (sub.atributos_definidos.includes(atributo)) {
    throw new Error('Esta subcategoría ya tiene un atributo con ese nombre');
  }
  sub.atributos_definidos.push(atributo);
  await sub.save();
  return { subcategoria_id: String(sub._id), atributo };
}

module.exports = { listar, crear, crearSubcategoria, crearAtributo };
