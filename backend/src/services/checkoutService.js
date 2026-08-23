const prisma = require('../config/prisma');

// Checkout atómico: pedido + líneas + pago + descuento de inventario.
// Toda la función corre dentro de una única transacción de Prisma — si cualquier
// paso falla (p. ej. falta de stock), TODO se revierte, incluyendo los descuentos
// de inventario ya aplicados en iteraciones previas del loop.
async function checkout({ usuarioId, direccionId, metodoPagoId, items }) {
  if (!items || items.length === 0) {
    throw new Error('El carrito no puede estar vacío');
  }

  return prisma.$transaction(async (tx) => {
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
  });
}

module.exports = { checkout };
