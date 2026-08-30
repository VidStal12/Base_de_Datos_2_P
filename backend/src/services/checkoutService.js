const prisma = require('../config/prisma');
const { esEnteroPositivo } = require('../utils/validation');
const { conectar } = require('../config/mongo');
const Producto = require('../models/mongo/Producto');

// Checkout atómico: pedido + líneas + pago + descuento de inventario.
// Toda la función corre dentro de una única transacción de Prisma — si cualquier
// paso falla (p. ej. falta de stock), TODO se revierte, incluyendo los descuentos
// de inventario ya aplicados en iteraciones previas del loop.
async function checkout({ usuarioId, direccionId, metodoPagoId, items }) {
  if (!items || items.length === 0) {
    throw new Error('El carrito no puede estar vacío');
  }
  if (!esEnteroPositivo(direccionId) || !esEnteroPositivo(metodoPagoId)) {
    throw new Error('direccionId y metodoPagoId deben ser enteros positivos');
  }
  // Sin esto, una cantidad negativa pasaba la validación de stock (cualquier
  // stock es "mayor" que un negativo) y luego el decrement de inventario con un
  // número negativo terminaba SUMANDO stock en vez de restarlo.
  for (const { productoId, cantidad } of items) {
    if (!esEnteroPositivo(productoId) || !esEnteroPositivo(cantidad)) {
      throw new Error('Cada item necesita productoId y cantidad como enteros positivos');
    }
  }

  return prisma.$transaction(async (tx) => {
    // La dirección y el método de pago deben pertenecer a quien está pagando —
    // si no, cualquier usuario autenticado podría pasar el ID de otro y usar
    // su dirección o su tarjeta guardada.
    const [direccion, metodoPago] = await Promise.all([
      tx.direcciones.findUnique({ where: { id: direccionId } }),
      tx.metodo_pago.findUnique({ where: { id: metodoPagoId } }),
    ]);

    if (!direccion || direccion.id_usuario !== usuarioId) {
      throw new Error('La dirección indicada no pertenece al usuario');
    }
    if (!metodoPago || metodoPago.id_usuario !== usuarioId) {
      throw new Error('El método de pago indicado no pertenece al usuario');
    }

    let total = 0;
    const detalles = [];

    for (const { productoId, cantidad } of items) {
      const inventario = await tx.inventario.findUnique({
        where: { id_producto: productoId },
      });

      if (!inventario || inventario.cantidad < cantidad) {
        throw new Error(`Stock insuficiente para el producto ${productoId}`);
      }

      const precioFinal = Number(inventario.precio) * cantidad;
      total += precioFinal;

      detalles.push({
        id_producto: productoId,
        cantidad,
        precio_final: precioFinal,
        descuento: 0,
        estado: 'pendiente',
      });

      await tx.inventario.update({
        where: { id_producto: productoId },
        data: { cantidad: { decrement: cantidad } },
      });
    }

    const compra = await tx.compra.create({
      data: {
        id_usuario: usuarioId,
        id_direccion: direccionId,
        total,
        compra_detalles: { create: detalles },
      },
      include: { compra_detalles: true },
    });

    const pago = await tx.pago.create({
      data: {
        id_compra: compra.id,
        id_metodo_pago: metodoPagoId,
        monto: total,
        estado: 'aprobado',
        referencia_transaccion: `TX-${compra.id}-${Date.now()}`,
      },
    });

    return { compra, pago };
  }).then(async (resultado) => {
    // Fuera de la transacción a propósito: la compra ya está confirmada y es
    // irreversible en MySQL en este punto, esto solo actualiza las cachés de
    // lectura en Mongo (total_vendido Y cantidad, ver Producto.js — MySQL
    // `inventario` ya se descontó arriba, DENTRO de la transacción; esto es
    // el reenvío de esa misma resta hacia la copia de Mongo). Mejor esfuerzo,
    // igual que el resto de las escrituras cruzadas de este proyecto (ver
    // ADR-002 §5) — si esto falla, la compra ya sucedió igual, no hay nada
    // que revertir; recalcularVentas()/recalcularInventario() lo corrigen
    // después si hace falta.
    try {
      await conectar();
      await Promise.all(
        items.map(({ productoId, cantidad }) =>
          Producto.updateOne({ producto_id: productoId }, { $inc: { total_vendido: cantidad, 'inventario.cantidad': -cantidad } })
        )
      );
    } catch (err) {
      console.error('No se pudo actualizar total_vendido/cantidad en Mongo:', err.message);
    }
    return resultado;
  });
}

module.exports = { checkout };
