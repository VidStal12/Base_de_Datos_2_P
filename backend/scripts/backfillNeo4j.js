require('dotenv').config();
const { textosParaGrafo } = require('../src/utils/textosProducto');
const mongoose = require('mongoose');
const prisma = require('../src/config/prisma');
const neo4j = require('../src/config/neo4j');
const { conectar: conectarMongo } = require('../src/config/mongo');
const Producto = require('../src/models/mongo/Producto');
const Resena = require('../src/models/mongo/Resena');
const fraudeSyncService = require('../src/services/fraudeSyncService');

// Backfill de datos históricos hacia Neo4j (ver
// IA/PLAN-NEO4J-DETECCION-FRAUDE.md §6) — el checkout/reseña en vivo solo
// cubre lo que pase de acá en adelante; esto cubre lo que ya existía antes
// de que el reenvío se agregara. Llama a las MISMAS funciones de
// fraudeSyncService.js que usa el camino en vivo, no una segunda
// implementación — MERGE, así que correrlo de nuevo (reconstrucción
// completa) es seguro.
const LOTE = 100;

// Rediseños de 2026-10-04 (ver PLAN-NEO4J-DETECCION-FRAUDE.md §16-§19): el
// grafo ya no guarda dirección de envío ni método de pago. Neo4j es una copia
// derivada (nunca la autoridad de nada), así que purgar lo viejo es seguro y se
// puede reconstruir con este mismo script. Idempotente: sobre un grafo ya
// limpio no borra nada. (`Correo` volvió en §18 — ya no es parte de lo que se
// purga — y `Articulo`, de la señal de reventa de §19, se reconstruye desde
// los productos publicados.)
async function limpiarModeloAnterior() {
  await neo4j.escribir('MATCH (n:Direccion) DETACH DELETE n');
  await neo4j.escribir('MATCH (n:MetodoPago) DETACH DELETE n');
  await neo4j.escribir('MATCH ()-[c:COMPRÓ]->() REMOVE c.direccion_texto, c.metodo_pago_token');
  // Un Articulo que ya no tiene ningún producto (porque se editó la descripción
  // de todos los que lo compartían) no sirve para nada: la señal de reventa
  // necesita DOS productos en el mismo artículo.
  await neo4j.escribir('MATCH (a:Articulo) WHERE NOT (a)<-[:ES_ARTICULO]-() DELETE a');
}

// Todos los productos publicados, no solo los comprados: la señal de reventa ve
// justamente la publicación que un vendedor hace después de comprarle a otro, y
// esa casi nunca tiene una compra (ver fraudeSyncService.registrarProducto).
// Va ANTES que las compras para que cada producto ya tenga su Articulo cuando
// llegue la arista COMPRÓ. Mismo `registrarProducto` que usa el alta/edición en
// vivo — una sola implementación.
async function backfillProductos() {
  let procesados = 0;
  let omitidos = 0;
  const productos = Producto.find({}).select('producto_id nombre descripcion subcategoria_id vendedor_id vendedor_nombre').lean().cursor();
  for await (const producto of productos) {
    try {
      await fraudeSyncService.registrarProducto({
        productoId: producto.producto_id,
        ...textosParaGrafo(producto),
        subcategoriaId: producto.subcategoria_id,
        vendedorId: producto.vendedor_id,
        vendedorNombre: producto.vendedor_nombre,
      });
      procesados += 1;
    } catch (err) {
      omitidos += 1;
      console.error(`Producto #${producto.producto_id} omitido: ${err.message}`);
    }
  }
  return { procesados, omitidos };
}

async function backfillCompras() {
  const cacheUsuarios = new Map();
  const cacheProductos = new Map();

  async function usuarioDe(id) {
    if (!cacheUsuarios.has(id)) {
      const u = await prisma.usuarios.findUnique({ where: { id_usuario: id }, include: { rol: true } });
      cacheUsuarios.set(id, u);
    }
    return cacheUsuarios.get(id);
  }
  async function productoDe(id) {
    if (!cacheProductos.has(id)) {
      const p = await Producto.findOne({ producto_id: id }).select('nombre descripcion subcategoria_id vendedor_id vendedor_nombre').lean();
      cacheProductos.set(id, p);
    }
    return cacheProductos.get(id);
  }

  let ultimoId = 0;
  let procesados = 0;
  let omitidos = 0;
  while (true) {
    const detalles = await prisma.compra_detalle.findMany({
      where: { id: { gt: ultimoId }, compra: { pagos: { some: { estado: 'aprobado' } } } },
      orderBy: { id: 'asc' },
      take: LOTE,
      include: { compra: { select: { fecha: true, id_usuario: true } } },
    });
    if (!detalles.length) break;

    for (const detalle of detalles) {
      const usuarioDb = await usuarioDe(detalle.compra.id_usuario);
      const producto = await productoDe(detalle.id_producto);
      if (!usuarioDb || !producto) {
        omitidos += 1;
        continue;
      }
      await fraudeSyncService.registrarCompra({
        detalleId: detalle.id,
        compraId: detalle.id_compra,
        usuarioId: detalle.compra.id_usuario,
        usuarioNombre: `${usuarioDb.nombres} ${usuarioDb.apellidos}`,
        usuarioRol: usuarioDb.rol.tipo_rol,
        vendedorId: producto.vendedor_id,
        vendedorNombre: producto.vendedor_nombre,
        productoId: detalle.id_producto,
        ...textosParaGrafo(producto),
        subcategoriaId: producto.subcategoria_id,
        fecha: detalle.compra.fecha,
        monto: detalle.precio_final,
      });
      procesados += 1;
    }
    ultimoId = detalles[detalles.length - 1].id;
  }
  return { procesados, omitidos };
}

async function backfillResenas() {
  const cacheUsuarios = new Map();
  const cacheProductos = new Map();

  async function usuarioDe(id) {
    if (!cacheUsuarios.has(id)) {
      const u = await prisma.usuarios.findUnique({ where: { id_usuario: id }, include: { rol: true } });
      cacheUsuarios.set(id, u);
    }
    return cacheUsuarios.get(id);
  }
  async function productoDe(id) {
    if (!cacheProductos.has(id)) {
      const p = await Producto.findOne({ producto_id: id }).select('nombre descripcion subcategoria_id vendedor_id vendedor_nombre').lean();
      cacheProductos.set(id, p);
    }
    return cacheProductos.get(id);
  }

  const resenas = await Resena.find({}).lean();
  let procesados = 0;
  let omitidos = 0;
  for (const resena of resenas) {
    const usuarioDb = await usuarioDe(resena.usuario_id);
    const producto = await productoDe(resena.producto_id);
    if (!usuarioDb || !producto) {
      omitidos += 1;
      continue;
    }
    await fraudeSyncService.registrarResena({
      usuarioId: resena.usuario_id,
      usuarioNombre: resena.usuario_nombre,
      usuarioRol: usuarioDb.rol.tipo_rol,
      vendedorId: producto.vendedor_id,
      vendedorNombre: producto.vendedor_nombre,
      productoId: resena.producto_id,
      ...textosParaGrafo(producto),
      subcategoriaId: producto.subcategoria_id,
      calificacion: resena.calificacion,
      fecha: resena.fecha,
    });
    procesados += 1;
  }
  return { procesados, omitidos };
}

async function main() {
  await conectarMongo();
  const soloProductos = process.argv.includes('--solo-productos');
  if (!soloProductos) await limpiarModeloAnterior();
  const productos = await backfillProductos();
  console.log(`Productos: ${productos.procesados} reenviados, ${productos.omitidos} omitidos.`);
  if (productos.omitidos) process.exitCode = 1;
  if (soloProductos) return;
  const compras = await backfillCompras();
  console.log(`Compras: ${compras.procesados} reenviadas, ${compras.omitidos} omitidas (sin usuario/producto resoluble).`);
  const resenas = await backfillResenas();
  console.log(`Reseñas: ${resenas.procesados} reenviadas, ${resenas.omitidos} omitidas.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await mongoose.disconnect();
    await neo4j.cerrar();
  });
