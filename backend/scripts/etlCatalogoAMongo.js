require('dotenv').config();
const prisma = require('../src/config/prisma');
const { conectar } = require('../src/config/mongo');
const Categoria = require('../src/models/mongo/Categoria');
const Subcategoria = require('../src/models/mongo/Subcategoria');
const Producto = require('../src/models/mongo/Producto');
const ProductoEvento = require('../src/models/mongo/ProductoEvento');

// ETL relacional → documental del catálogo descriptivo (ver ADR-002/ADR-003).
// precio/cantidad NO se migran — se quedan en `inventario` (MySQL) sin tocar.
// Reproducible: limpia las colecciones destino antes de escribir, así se puede
// correr de nuevo tantas veces como haga falta durante el desarrollo.
async function main() {
  await conectar();

  console.log('Limpiando colecciones destino...');
  await Promise.all([
    Categoria.deleteMany({}),
    Subcategoria.deleteMany({}),
    Producto.deleteMany({}),
    ProductoEvento.deleteMany({}),
  ]);

  // --- categorías ---
  const categoriasRelacionales = await prisma.categoria.findMany();
  const mapaCategoria = new Map(); // id MySQL -> ObjectId Mongo
  for (const cat of categoriasRelacionales) {
    const doc = await Categoria.create({ categoria: cat.categoria });
    mapaCategoria.set(cat.id, doc._id);
  }
  console.log(`Categorías migradas: ${categoriasRelacionales.length}`);

  // --- subcategorías (con sus atributos definidos embebidos) ---
  const subcategoriasRelacionales = await prisma.subcategoria.findMany({
    include: { atributos_categoria: true },
  });
  const mapaSubcategoria = new Map(); // id MySQL -> ObjectId Mongo
  // atributo_categoria.id (MySQL) -> nombre del atributo, para resolver atributo_producto después
  const mapaNombreAtributo = new Map();
  for (const sub of subcategoriasRelacionales) {
    const doc = await Subcategoria.create({
      categoria_id: mapaCategoria.get(sub.id_categoria),
      subcategoria: sub.subcategoria,
      atributos_definidos: sub.atributos_categoria.map((a) => a.atributo),
    });
    mapaSubcategoria.set(sub.id, doc._id);
    for (const attr of sub.atributos_categoria) {
      mapaNombreAtributo.set(attr.id, attr.atributo);
    }
  }
  console.log(`Subcategorías migradas: ${subcategoriasRelacionales.length}`);

  // --- productos (contenido descriptivo) + evento inicial de creación ---
  const productosRelacionales = await prisma.producto.findMany({
    include: {
      vendedor: true,
      categoria_productos: true,
      atributos_producto: true,
    },
  });

  let migrados = 0;
  for (const prod of productosRelacionales) {
    const asignacion = prod.categoria_productos[0];
    if (!asignacion) {
      console.warn(`Producto ${prod.id} sin subcategoría asignada — se omite.`);
      continue;
    }

    const atributos = prod.atributos_producto.map((ap) => ({
      nombre: mapaNombreAtributo.get(ap.id_atributo_categoria) || `atributo_${ap.id_atributo_categoria}`,
      valor: ap.valor,
    }));

    const imagenes = prod.imagen_url
      ? [{ url: prod.imagen_url, alt: prod.descripcion, orden: 1, principal: true }]
      : [];

    const doc = await Producto.create({
      producto_id: prod.id,
      descripcion: prod.descripcion,
      estado: prod.estado,
      subcategoria_id: mapaSubcategoria.get(asignacion.id_subcategoria),
      vendedor_id: prod.id_vendedor,
      vendedor_nombre: `${prod.vendedor.nombres} ${prod.vendedor.apellidos}`,
      atributos,
      imagenes,
      version: 1,
    });

    // Evento inicial: no se conoce la fecha de creación original (no se
    // rastreaba en el modelo relacional), así que el evento de migración usa
    // "ahora" como fecha — una aproximación documentada, no un dato inventado
    // como si fuera real.
    await ProductoEvento.create({
      producto_id: prod.id,
      version: 1,
      tipo: 'creacion',
      fecha: doc.actualizado_en,
      usuario_id: prod.id_vendedor,
      campos_modificados: [],
      snapshot: {
        descripcion: doc.descripcion,
        estado: doc.estado,
        atributos: doc.atributos,
        imagenes: doc.imagenes,
      },
    });

    migrados += 1;
  }
  console.log(`Productos migrados: ${migrados} de ${productosRelacionales.length}`);

  console.log('ETL completo.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit();
  });
