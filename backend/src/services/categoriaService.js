const prisma = require('../config/prisma');

async function listar() {
  return prisma.categoria.findMany({
    include: { subcategorias: { include: { atributos_categoria: true } } },
  });
}

async function crear({ categoria }) {
  if (!categoria) throw new Error('El nombre de la categoría es obligatorio');
  return prisma.categoria.create({ data: { categoria } });
}

async function crearSubcategoria(categoriaId, { subcategoria }) {
  if (!subcategoria) throw new Error('El nombre de la subcategoría es obligatorio');
  const cat = await prisma.categoria.findUnique({ where: { id: categoriaId } });
  if (!cat) throw new Error('Categoría no encontrada');
  return prisma.subcategoria.create({ data: { id_categoria: categoriaId, subcategoria } });
}

async function crearAtributo(subcategoriaId, { atributo }) {
  if (!atributo) throw new Error('El nombre del atributo es obligatorio');
  const sub = await prisma.subcategoria.findUnique({ where: { id: subcategoriaId } });
  if (!sub) throw new Error('Subcategoría no encontrada');
  return prisma.atributo_categoria.create({ data: { id_subcategoria: subcategoriaId, atributo } });
}

module.exports = { listar, crear, crearSubcategoria, crearAtributo };
