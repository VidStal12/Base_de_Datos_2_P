const prisma = require('../config/prisma');
const { esEnteroPositivo } = require('../utils/validation');
const { conectar } = require('../config/mongo');
const Producto = require('../models/mongo/Producto');
const cartService = require('./cartService');
const { encolarCompra } = require('./ventasOutboxService');

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

    // El pendiente de analítica se confirma con el pago. Una caída posterior de
    // Cassandra no pierde esta venta ni requiere volver a ejecutar el checkout.
    await encolarCompra(tx, compra);

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

    // Vaciar el carrito en Redis acá, no solo confiar en que el frontend lo
    // haga después de recibir la respuesta (ver ENTREGA-2-PLAN.md §4.1) — si
    // el checkout ya se confirmó pero esa segunda llamada del cliente nunca
    // llega (pestaña cerrada, red cortada justo ahí), el usuario volvería a
    // ver en su carrito algo que ya compró. Try/catch propio, independiente
    // del de arriba: que falle el reenvío a Mongo no debería impedir este intento.
    try {
      await cartService.vaciar(usuarioId);
    } catch (err) {
      console.error('No se pudo vaciar el carrito en Redis tras el checkout:', err.message);
    }

    return resultado;
  });
}

// Guardia 2 (autoridad final en MySQL) de la oferta flash — ver
// ofertaFlashService.js y ENTREGA-2-PLAN.md §4.2. Deliberadamente una función
// separada, NO una rama dentro de checkout() de arriba: "no reemplaza el
// checkout normal" (§4.2) significa también no arriesgar el que ya está
// verificado agregándole casos. Comparte el módulo (ambas son "compras que
// tocan MySQL en una transacción") pero ninguna línea de código.
//
// Único ítem, precio provisto por el llamador (precio_oferta de Mongo, no
// inventario.precio) — todo lo demás calca a checkout(): valida pertenencia
// de dirección/método de pago, exige stock REAL suficiente (Redis ya admitió
// del lado del pool de oferta, pero eso es solo la guardia 1; si el
// inventario real ya no alcanza, acá se rechaza igual, aunque Redis haya
// dicho que sí — ver §4.2, "dos guardas, no una"), y reenvía a Mongo después
// de confirmar. `descuento` en compra_detalle, que en el checkout normal
// siempre queda en 0, acá sí lleva el ahorro real.
async function checkoutOferta({ usuarioId, productoId, cantidad, precioUnitario, direccionId, metodoPagoId }) {
  if (!esEnteroPositivo(productoId) || !esEnteroPositivo(cantidad)) {
    throw new Error('productoId y cantidad deben ser enteros positivos');
  }
  if (!esEnteroPositivo(direccionId) || !esEnteroPositivo(metodoPagoId)) {
    throw new Error('direccionId y metodoPagoId deben ser enteros positivos');
  }
  if (typeof precioUnitario !== 'number' || precioUnitario <= 0) {
    throw new Error('precioUnitario debe ser un número positivo');
  }

  return prisma.$transaction(async (tx) => {
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

    const inventario = await tx.inventario.findUnique({ where: { id_producto: productoId } });
    if (!inventario || inventario.cantidad < cantidad) {
      // La guardia 1 (Redis) ya admitió esta compra dentro del pool de
      // oferta — esto es la guardia 2 rechazándola igual porque el
      // inventario REAL ya no alcanza. Es exactamente el caso que separa
      // "admisión rápida" de "autoridad final" (§4.2); el llamador
      // (ofertaFlashService.comprar) revierte el contador de Redis cuando
      // esto pasa, para no dejar quemada una unidad del pool que nadie
      // efectivamente se llevó.
      throw new Error(`Stock insuficiente para el producto ${productoId}`);
    }

    await tx.inventario.update({ where: { id_producto: productoId }, data: { cantidad: { decrement: cantidad } } });

    const precioFinal = precioUnitario * cantidad;
    const descuentoUnitario = Math.max(Number(inventario.precio) - precioUnitario, 0);

    const compra = await tx.compra.create({
      data: {
        id_usuario: usuarioId,
        id_direccion: direccionId,
        total: precioFinal,
        compra_detalles: {
          create: [
            {
              id_producto: productoId,
              cantidad,
              precio_final: precioFinal,
              descuento: descuentoUnitario * cantidad,
              estado: 'pendiente',
            },
          ],
        },
      },
      include: { compra_detalles: true },
    });

    const pago = await tx.pago.create({
      data: {
        id_compra: compra.id,
        id_metodo_pago: metodoPagoId,
        monto: precioFinal,
        estado: 'aprobado',
        referencia_transaccion: `TX-OFERTA-${compra.id}-${Date.now()}`,
      },
    });

    // Oferta flash y compra por recomendación usan este checkout: ambas generan
    // el mismo snapshot con el importe neto que quedó guardado en MySQL.
    await encolarCompra(tx, compra);

    return { compra, pago };
  }).then(async (resultado) => {
    // Mismo reenvío de mejor esfuerzo que checkout() — ver el comentario de
    // arriba, es la misma copia de lectura en Mongo, actualizada por el mismo
    // motivo.
    try {
      await conectar();
      await Producto.updateOne(
        { producto_id: productoId },
        { $inc: { total_vendido: cantidad, 'inventario.cantidad': -cantidad } }
      );
    } catch (err) {
      console.error('No se pudo actualizar total_vendido/cantidad en Mongo (oferta flash):', err.message);
    }
    return resultado;
  });
}

module.exports = { checkout, checkoutOferta };
