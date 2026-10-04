const prisma = require('../config/prisma');
const { conectar } = require('../config/mongo');
const Producto = require('../models/mongo/Producto');
const Resena = require('../models/mongo/Resena');
const fraudeSyncService = require('./fraudeSyncService');

function formatear(doc) {
  return {
    id: doc._id,
    producto_id: doc.producto_id,
    usuario_id: doc.usuario_id,
    usuario_nombre: doc.usuario_nombre,
    calificacion: doc.calificacion,
    comentario: doc.comentario || '',
    fecha: doc.fecha,
  };
}

async function listarPorProducto(productoId) {
  await conectar();
  const documentos = await Resena.find({ producto_id: productoId }).sort({ fecha: -1 }).lean();
  return documentos.map(formatear);
}

// Recalcula el resumen embebido en Producto (promedio/cantidad) desde la
// fuente real (esta colección) — mismo principio que total_vendido/
// inventario en Producto.js: un agregado cacheado, recalculable desde cero.
async function recalcularResumen(productoId) {
  const [resumen] = await Resena.aggregate([
    { $match: { producto_id: productoId } },
    { $group: { _id: null, promedio: { $avg: '$calificacion' }, cantidad: { $sum: 1 } } },
  ]);
  await Producto.updateOne(
    { producto_id: productoId },
    {
      $set: {
        'resenas_resumen.promedio': resumen ? Number(resumen.promedio.toFixed(2)) : 0,
        'resenas_resumen.cantidad': resumen ? resumen.cantidad : 0,
      },
    }
  );
}

// Misma definición de "compra real" que ya usa ventasSyncService.js/ADR-004
// para las ventas del panel de Cassandra — un compra_detalle de este producto
// en una compra con al menos un pago aprobado. Un solo lugar decide qué
// cuenta como "compró de verdad", no una versión propia acá que pudiera
// desalinearse con la del panel de ventas.
async function tienePermisoDeResenar(usuarioId, productoId) {
  const detalle = await prisma.compra_detalle.findFirst({
    where: {
      id_producto: productoId,
      compra: { id_usuario: usuarioId, pagos: { some: { estado: 'aprobado' } } },
    },
    select: { id: true },
  });
  return Boolean(detalle);
}

// usuario: { id_usuario, rol } — sale del token, nunca del body (mismo
// criterio que productoService.crear() con el vendedor). usuario_nombre se
// resuelve una sola vez acá y queda cacheado en la reseña — igual que
// vendedor_nombre en Producto.js.
//
// Exige una compra real (con pago aprobado) del producto — sin esto,
// cualquier cuenta podía reseñar cualquier producto sin haberlo comprado,
// abriendo la puerta a inflar/hundir una calificación con cuentas creadas
// solo para eso (el registro público no tiene fricción ni costo). Una sola
// reseña por (producto, usuario): el índice único de Resena.js es la
// garantía real bajo concurrencia, este chequeo previo es solo para devolver
// un 409 legible en el caso normal en vez de un error crudo de Mongo.
async function crear(usuario, productoId, { calificacion, comentario }) {
  if (!Number.isInteger(calificacion) || calificacion < 1 || calificacion > 5) {
    throw new Error('La calificación debe ser un entero entre 1 y 5');
  }

  await conectar();
  const producto = await Producto.findOne({ producto_id: productoId }).select('_id descripcion subcategoria_id vendedor_id vendedor_nombre');
  if (!producto) throw new Error('Producto no encontrado');

  const usuarioDb = await prisma.usuarios.findUnique({ where: { id_usuario: usuario.id_usuario } });
  if (!usuarioDb) throw new Error('Usuario no encontrado');

  if (!(await tienePermisoDeResenar(usuario.id_usuario, productoId))) {
    const err = new Error('Solo podés reseñar productos que compraste');
    err.status = 403;
    throw err;
  }

  if (await Resena.findOne({ producto_id: productoId, usuario_id: usuario.id_usuario }).select('_id')) {
    const err = new Error('Ya dejaste una reseña para este producto');
    err.status = 409;
    throw err;
  }

  let doc;
  try {
    doc = await Resena.create({
      producto_id: productoId,
      usuario_id: usuario.id_usuario,
      usuario_nombre: `${usuarioDb.nombres} ${usuarioDb.apellidos}`,
      calificacion,
      comentario: comentario || '',
      fecha: new Date(),
    });
  } catch (err) {
    // Código 11000 = choque contra el índice único — dos POST casi
    // simultáneos del mismo usuario pasaron el chequeo de arriba a la vez;
    // el segundo pierde la carrera en la base, no en la aplicación.
    if (err.code === 11000) {
      const duplicado = new Error('Ya dejaste una reseña para este producto');
      duplicado.status = 409;
      throw duplicado;
    }
    throw err;
  }

  await recalcularResumen(productoId);

  // Detección de fraude (Entrega 2, ver IA/PLAN-NEO4J-DETECCION-FRAUDE.md) —
  // mejor esfuerzo, con su propio try/catch: que esto falle no debe impedir
  // que la reseña quede guardada, que ya sucedió arriba. `usuario.rol` sale
  // del token, no hace falta volver a consultar MySQL para eso.
  try {
    await fraudeSyncService.registrarResena({
      usuarioId: usuario.id_usuario,
      usuarioNombre: `${usuarioDb.nombres} ${usuarioDb.apellidos}`,
      usuarioRol: usuario.rol,
      vendedorId: producto.vendedor_id,
      vendedorNombre: producto.vendedor_nombre,
      productoId,
      productoDescripcion: producto.descripcion,
      subcategoriaId: producto.subcategoria_id,
      calificacion,
      fecha: doc.fecha,
    });
  } catch (err) {
    console.error('No se pudo reenviar la reseña a Neo4j:', err.message);
  }

  return formatear(doc);
}

module.exports = { listarPorProducto, crear };