require('dotenv').config();
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
      const p = await Producto.findOne({ producto_id: id }).select('descripcion subcategoria_id').lean();
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
      include: {
        compra: {
          select: {
            fecha: true,
            id_usuario: true,
            direccion: true,
            pagos: { where: { estado: 'aprobado' }, select: { metodo_pago: true }, take: 1 },
          },
        },
      },
    });
    if (!detalles.length) break;

    for (const detalle of detalles) {
      const usuarioDb = await usuarioDe(detalle.compra.id_usuario);
      const producto = await productoDe(detalle.id_producto);
      const metodoPagoDb = detalle.compra.pagos[0]?.metodo_pago;
      if (!usuarioDb || !producto || !metodoPagoDb) {
        omitidos += 1;
        continue;
      }
      await fraudeSyncService.registrarCompra({
        detalleId: detalle.id,
        usuarioId: detalle.compra.id_usuario,
        usuarioNombre: `${usuarioDb.nombres} ${usuarioDb.apellidos}`,
        usuarioRol: usuarioDb.rol.tipo_rol,
        productoId: detalle.id_producto,
        productoDescripcion: producto.descripcion,
        subcategoriaId: producto.subcategoria_id,
        direccion: detalle.compra.direccion,
        metodoPago: metodoPagoDb,
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

  async function rolDe(id) {
    if (!cacheUsuarios.has(id)) {
      const u = await prisma.usuarios.findUnique({ where: { id_usuario: id }, include: { rol: true } });
      cacheUsuarios.set(id, u?.rol?.tipo_rol);
    }
    return cacheUsuarios.get(id);
  }
  async function productoDe(id) {
    if (!cacheProductos.has(id)) {
      const p = await Producto.findOne({ producto_id: id }).select('descripcion subcategoria_id').lean();
      cacheProductos.set(id, p);
    }
    return cacheProductos.get(id);
  }

  const resenas = await Resena.find({}).lean();
  let procesados = 0;
  let omitidos = 0;
  for (const resena of resenas) {
    const rol = await rolDe(resena.usuario_id);
    const producto = await productoDe(resena.producto_id);
    if (!rol || !producto) {
      omitidos += 1;
      continue;
    }
    await fraudeSyncService.registrarResena({
      usuarioId: resena.usuario_id,
      usuarioNombre: resena.usuario_nombre,
      usuarioRol: rol,
      productoId: resena.producto_id,
      productoDescripcion: producto.descripcion,
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
  const compras = await backfillCompras();
  console.log(`Compras: ${compras.procesados} reenviadas, ${compras.omitidos} omitidas (sin usuario/producto/método de pago resoluble).`);
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
