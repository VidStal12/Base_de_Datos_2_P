// Serializa el Decimal que YA guardó MySQL; no recalcula precios ni convierte
// dinero a Number. precio_final incluye cantidad y descuento de toda la línea.
function decimalComoTexto(valor) {
  const texto = valor.toString();
  if (!/^\d+(\.\d{1,2})?$/.test(texto)) {
    throw new Error('El importe de una venta debe ser un decimal no negativo con hasta dos decimales');
  }
  const [entero, centavos = ''] = texto.split('.');
  return `${entero}.${centavos.padEnd(2, '0')}`;
}

// Se copia únicamente lo necesario para las dos proyecciones de Cassandra.
// La fecha ISO conserva el instante original; el día local se calcula al enviar.
function crearPayload(compra, detalle, vendedorId) {
  return {
    detalle_id: detalle.id,
    compra_id: compra.id,
    producto_id: detalle.id_producto,
    vendedor_id: vendedorId,
    fecha_venta: new Date(compra.fecha).toISOString(),
    cantidad: detalle.cantidad,
    importe: decimalComoTexto(detalle.precio_final),
    descuento: decimalComoTexto(detalle.descuento),
  };
}

// Recibe EL MISMO tx del checkout: si falla este INSERT también se revierten
// pago, compra e inventario. Cassandra nunca participa en la ruta del cobro.
async function encolarCompra(tx, compra) {
  const productos = await tx.producto.findMany({
    where: { id: { in: [...new Set(compra.compra_detalles.map((detalle) => detalle.id_producto))] } },
    select: { id: true, id_vendedor: true },
  });
  const vendedores = new Map(productos.map((producto) => [producto.id, producto.id_vendedor]));
  const data = compra.compra_detalles.map((detalle) => {
    const vendedorId = vendedores.get(detalle.id_producto);
    if (!vendedorId) throw new Error(`No se encontró vendedor para el producto ${detalle.id_producto}`);
    return { detalle_id: detalle.id, payload: crearPayload(compra, detalle, vendedorId) };
  });
  await tx.venta_outbox.createMany({ data });
}

module.exports = { encolarCompra, crearPayload };
