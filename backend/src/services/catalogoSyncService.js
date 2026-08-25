const prisma = require('../config/prisma');
const { conectar } = require('../config/mongo');
const Categoria = require('../models/mongo/Categoria');
const Subcategoria = require('../models/mongo/Subcategoria');
const Producto = require('../models/mongo/Producto');
const ProductoEvento = require('../models/mongo/ProductoEvento');

// Sincronización ADITIVA: agrega a Mongo lo que exista en MySQL y todavía no
// tenga documento — nunca borra ni pisa lo que ya está en Mongo. Pensado para
// ejecutarse las veces que haga falta desde el panel de administrador.
//
// A propósito NO reusa scripts/etlCatalogoAMongo.js: ese script hace
// deleteMany() sobre las colecciones destino antes de escribir, lo cual
// reconstruye todo desde cero y borra el historial de eventos acumulado — solo
// es seguro para el bootstrap inicial o para desarrollo. Exponerlo tal cual
// como botón de administrador borraría el historial real cada vez que alguien
// lo tocara. Ver ADR-002 §8 para el detalle de esta decisión.
async function sincronizarFaltantes() {
  await conectar();

  const resultado = {
    categorias_creadas: 0,
    subcategorias_creadas: 0,
    productos_creados: 0,
    productos_omitidos: [],
  };

  const categoriasRelacionales = await prisma.categoria.findMany();
  const mapaCategoria = new Map(); // id MySQL -> ObjectId Mongo
  for (const cat of categoriasRelacionales) {
    let doc = await Categoria.findOne({ categoria: cat.categoria });
    if (!doc) {
      doc = await Categoria.create({ categoria: cat.categoria });
      resultado.categorias_creadas += 1;
    }
    mapaCategoria.set(cat.id, doc._id);
  }

  const subcategoriasRelacionales = await prisma.subcategoria.findMany({
    include: { atributos_categoria: true },
  });
  const mapaSubcategoria = new Map(); // id MySQL -> ObjectId Mongo
  const mapaNombreAtributo = new Map(); // atributo_categoria.id (MySQL) -> nombre
  for (const sub of subcategoriasRelacionales) {
    const categoriaMongoId = mapaCategoria.get(sub.id_categoria);
    let doc = await Subcategoria.findOne({ categoria_id: categoriaMongoId, subcategoria: sub.subcategoria });
    if (!doc) {
      doc = await Subcategoria.create({
        categoria_id: categoriaMongoId,
        subcategoria: sub.subcategoria,
        atributos_definidos: sub.atributos_categoria.map((a) => a.atributo),
      });
      resultado.subcategorias_creadas += 1;
    }
    mapaSubcategoria.set(sub.id, doc._id);
    for (const attr of sub.atributos_categoria) {
      mapaNombreAtributo.set(attr.id, attr.atributo);
    }
  }

  const productosRelacionales = await prisma.producto.findMany({
    include: { vendedor: true, categoria_productos: true, atributos_producto: true },
  });

  for (const prod of productosRelacionales) {
    const yaExiste = await Producto.exists({ producto_id: prod.id });
    if (yaExiste) continue;

    const asignacion = prod.categoria_productos[0];
    if (!asignacion) {
      resultado.productos_omitidos.push({ id: prod.id, descripcion: prod.descripcion, motivo: 'sin subcategoría asignada en MySQL' });
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

    await ProductoEvento.create({
      producto_id: prod.id,
      version: 1,
      tipo: 'creacion',
      fecha: doc.actualizado_en,
      usuario_id: prod.id_vendedor,
      campos_modificados: [],
      snapshot: { descripcion: doc.descripcion, estado: doc.estado, atributos: doc.atributos, imagenes: doc.imagenes },
    });

    resultado.productos_creados += 1;
  }

  return resultado;
}

// Recalcula total_vendido (caché en Mongo, ver Producto.js) desde la fuente de
// verdad real: compra_detalle en MySQL. A diferencia de sincronizarFaltantes(),
// ESTO SÍ SOBRESCRIBE un valor ya existente — es una reconciliación, no una
// adición. Seguro de re-correr las veces que haga falta porque siempre
// recalcula la suma real en vez de incrementar a ciegas; corrige cualquier
// desvío que haya dejado un fallo silencioso del paso en checkoutRoutes.js.
async function recalcularVentas() {
  await conectar();

  const sumas = await prisma.compra_detalle.groupBy({
    by: ['id_producto'],
    _sum: { cantidad: true },
  });
  const mapaVentas = new Map(sumas.map((s) => [s.id_producto, s._sum.cantidad || 0]));

  const productos = await Producto.find().select('producto_id');
  let actualizados = 0;
  for (const { producto_id } of productos) {
    const total = mapaVentas.get(producto_id) || 0;
    await Producto.updateOne({ producto_id }, { $set: { total_vendido: total } });
    actualizados += 1;
  }

  return { productos_actualizados: actualizados };
}

module.exports = { sincronizarFaltantes, recalcularVentas };
