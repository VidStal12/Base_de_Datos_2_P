const prisma = require('../config/prisma');
const { conectar } = require('../config/mongo');
const Producto = require('../models/mongo/Producto');
const Resena = require('../models/mongo/Resena');

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

// usuario: { id_usuario, rol } — sale del token, nunca del body (mismo
// criterio que productoService.crear() con el vendedor). usuario_nombre se
// resuelve una sola vez acá y queda cacheado en la reseña — igual que
// vendedor_nombre en Producto.js.
async function crear(usuario, productoId, { calificacion, comentario }) {
  if (!Number.isInteger(calificacion) || calificacion < 1 || calificacion > 5) {
    throw new Error('La calificación debe ser un entero entre 1 y 5');
  }

  await conectar();
  const producto = await Producto.findOne({ producto_id: productoId }).select('_id');
  if (!producto) throw new Error('Producto no encontrado');

  const usuarioDb = await prisma.usuarios.findUnique({ where: { id_usuario: usuario.id_usuario } });
  if (!usuarioDb) throw new Error('Usuario no encontrado');

  const doc = await Resena.create({
    producto_id: productoId,
    usuario_id: usuario.id_usuario,
    usuario_nombre: `${usuarioDb.nombres} ${usuarioDb.apellidos}`,
    calificacion,
    comentario: comentario || '',
    fecha: new Date(),
  });

  await recalcularResumen(productoId);

  return formatear(doc);
}

module.exports = { listarPorProducto, crear };