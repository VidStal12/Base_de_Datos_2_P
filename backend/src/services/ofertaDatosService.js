const { conectar } = require('../config/redis');
const { conectar: conectarMongo } = require('../config/mongo');
const Producto = require('../models/mongo/Producto');

const TTL_SEGUNDOS = 60;
const clave = (id) => `oferta:${id}:datos`;

// Información propia de la oferta, independiente del carrito y del contador.
function datos(doc) {
  const imagen = doc.imagenes?.find((img) => img.principal) || doc.imagenes?.[0];
  const oferta = doc.oferta_flash;
  return {
    id: doc.producto_id, descripcion: doc.descripcion, estado: doc.estado,
    imagen_url: imagen?.url || '', vendedor_id: doc.vendedor_id, vendedor_nombre: doc.vendedor_nombre,
    precio_normal: doc.inventario?.precio === undefined ? null : Number(doc.inventario.precio),
    oferta_flash: oferta ? { activo: oferta.activo, precio_oferta: oferta.precio_oferta, stock_oferta: oferta.stock_oferta, vigente_desde: oferta.vigente_desde, vigente_hasta: oferta.vigente_hasta } : null,
  };
}

async function invalidar(id) {
  try { await conectar().del(clave(id)); }
  catch (err) { console.error('No se pudo invalidar la información flash:', err.message); }
}

async function actualizar(doc) {
  if (!doc.oferta_flash) return invalidar(doc.producto_id);
  try { await conectar().set(clave(doc.producto_id), JSON.stringify(datos(doc)), 'EX', TTL_SEGUNDOS); }
  catch (err) {
    console.error('No se pudo actualizar la información flash:', err.message);
    await invalidar(doc.producto_id);
  }
}

async function obtener(id) {
  try {
    const producto = JSON.parse(await conectar().get(clave(id)));
    if (producto?.id === id) return producto;
  } catch (err) { console.error('No se pudo leer la información flash:', err.message); }
  await conectarMongo();
  const doc = await Producto.findOne({ producto_id: id }).select('producto_id descripcion estado imagenes vendedor_id vendedor_nombre inventario.precio oferta_flash').lean();
  if (!doc) throw new Error('Producto no encontrado');
  const producto = datos(doc);
  // Una lectura fría no reemplaza la información publicada por una edición.
  try { await conectar().set(clave(id), JSON.stringify(producto), 'EX', TTL_SEGUNDOS, 'NX'); }
  catch (err) { console.error('No se pudo guardar la información flash:', err.message); }
  return producto;
}

module.exports = { obtener, actualizar, invalidar, TTL_SEGUNDOS };
