const prisma = require('../config/prisma');
const { conectar } = require('../config/mongo');
const Producto = require('../models/mongo/Producto');
const ofertaDatos = require('./ofertaDatosService');

// Reconciliación, no adición: recalcula total_vendido (caché en Mongo, ver
// Producto.js) desde la fuente de verdad real, compra_detalle en MySQL — y
// ESTO SÍ SOBRESCRIBE un valor ya existente. Seguro de re-correr las veces
// que haga falta porque siempre
// recalcula la suma real en vez de incrementar a ciegas; corrige cualquier
// desvío que haya dejado un fallo silencioso del paso de reenvío en
// checkoutService.js.
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

// Recalcula precio/cantidad (caché en Mongo, ver Producto.js) desde la fuente
// de verdad real: inventario en MySQL. Mismo espíritu que recalcularVentas()
// — reconciliación que sobrescribe, segura de re-correr. Pensada para dos
// casos: (1) backfill único de los documentos que ya existían en Mongo antes
// de que precio/cantidad se agregaran ahí (2026-08-29), y (2) corregir
// cualquier desvío si el reenvío de productoService.js/checkoutService.js
// falla silenciosamente.
async function recalcularInventario() {
  await conectar();

  const inventarios = await prisma.inventario.findMany();
  const mapaInventario = new Map(inventarios.map((inv) => [inv.id_producto, inv]));

  const productos = await Producto.find().select('producto_id oferta_flash.activo');
  let actualizados = 0;
  const omitidos = [];
  for (const { producto_id, oferta_flash } of productos) {
    const inv = mapaInventario.get(producto_id);
    if (!inv) {
      omitidos.push(producto_id);
      continue;
    }
    await Producto.updateOne(
      { producto_id },
      { $set: { 'inventario.precio': Number(inv.precio), 'inventario.cantidad': inv.cantidad } }
    );
    // La oferta flash guarda en Redis una copia del producto con este precio
    // (ofertaDatosService.js): solo existe mientras la oferta está activa, así
    // que solo ahí hace falta invalidarla para que se regenere con el precio
    // corregido (en los demás no hay nada que borrar, y se evita dejar una
    // clave de revisión por cada producto del catálogo).
    if (oferta_flash?.activo) await ofertaDatos.invalidar(producto_id);
    actualizados += 1;
  }

  return { productos_actualizados: actualizados, productos_omitidos: omitidos };
}

module.exports = { recalcularVentas, recalcularInventario };
