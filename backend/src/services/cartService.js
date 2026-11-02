const prisma = require('../config/prisma');
const { conectar } = require('../config/redis');
const productoService = require('./productoService');
const { componenteCaido } = require('../utils/resiliencia');

const TTL_SEGUNDOS = 450;
const clave = (usuarioId) => `carrito:${usuarioId}`;
const revisionClave = (usuarioId) => `carrito:${usuarioId}:revision`;

async function cacheSeguro(operacion) {
  try { return await operacion(conectar('carrito')); }
  catch (err) { console.error('No se pudo actualizar/leer la caché del carrito:', err.message); }
}

async function bloquearUsuario(tx, usuarioId) {
  await tx.$queryRaw`SELECT id_usuario FROM usuarios WHERE id_usuario = ${usuarioId} FOR UPDATE`;
}

async function avanzarVersion(tx, usuarioId) {
  await tx.$executeRaw`UPDATE usuarios SET carrito_version = carrito_version + 1 WHERE id_usuario = ${usuarioId}`;
}

async function invalidarCache(usuarioId) {
  // El resto del carrito puede ignorarlo; checkout necesita comunicar el fallo parcial.
  return (await cacheSeguro((redis) => redis.invalidarCarrito(clave(usuarioId), revisionClave(usuarioId)))) !== undefined;
}

function leerLineas(crudo) {
  if (crudo._formato !== '4') return null;
  const lineas = [];
  try {
    for (const [campo, valor] of Object.entries(crudo)) {
      if (campo === '_formato') continue;
      const linea = JSON.parse(valor);
      if (linea.producto?.id !== Number(campo) || !Number.isInteger(linea.producto.id) || linea.producto.id <= 0 || !Number.isInteger(linea.cantidad) || linea.cantidad <= 0) return null;
      lineas.push(linea);
    }
  } catch { return null; }
  return lineas;
}

function respuesta(items) {
  return {
    items,
    cantidadTotal: items.reduce((acc, it) => acc + it.cantidad, 0),
    total: Math.round(items.reduce((acc, it) => acc + Number(it.producto.precio || 0) * it.cantidad, 0) * 100) / 100,
  };
}

// Solo en carga fría, mutaciones y entrada al checkout. No se guarda stock
// dentro del carrito: se usa aquí para calcular la disponibilidad del checkout.
//
// Devuelve { items, completo }. `completo: false` significa que el catálogo (Mongo y su
// copia en el índice de búsqueda) no respondió: el carrito se muestra igual, con lo que sí se
// sabe (cantidad y precio vienen de MySQL) y los productos como no disponibles, y NO se guarda
// en la caché de Redis para que no se quede mostrando «Producto #12» cuando el catálogo vuelva.
async function cargarActual(usuarioId) {
  const filas = await prisma.carrito.findMany({ where: { id_usuario: usuarioId }, orderBy: { id_producto: 'asc' }, select: { id_producto: true, cantidad: true } });
  if (!filas.length) return { items: [], completo: true };
  const ids = filas.map((fila) => fila.id_producto);
  let completo = true;
  const [publicados, inventarios, ocultos] = await Promise.all([
    productoService.estadoPublicacion(ids).catch((err) => {
      if (!componenteCaido(err)) throw err;
      completo = false;
      return new Map();
    }),
    prisma.inventario.findMany({ where: { id_producto: { in: ids } } }),
    // Un producto de un vendedor suspendido sigue en el carrito, pero como no
    // disponible (ver productoService.listar): vuelve a estarlo si se levanta.
    productoService.vendedoresOcultos(),
  ]);
  const stock = new Map(inventarios.map((inv) => [inv.id_producto, inv]));
  const items = filas.map((fila) => {
    const doc = publicados.get(fila.id_producto);
    const inv = stock.get(fila.id_producto);
    return {
      producto: {
        id: fila.id_producto,
        descripcion: doc?.descripcion ?? '',
        nombre: doc?.nombre || (completo ? 'Producto no disponible' : `Producto #${fila.id_producto}`),
        imagen_url: doc?.imagen_url || '',
        estado: doc?.estado || 'inactivo',
        precio: inv ? Number(inv.precio) : null,
      },
      cantidad: fila.cantidad,
      disponible: doc?.estado === 'activo' && !ocultos.has(doc.vendedor_id) && !!inv && inv.cantidad >= fila.cantidad,
    };
  });
  return { items, completo };
}

async function obtener(usuarioId, revisar = false) {
  for (let intento = 0; intento < 3; intento += 1) {
    const cache = await cacheSeguro((redis) => redis.leerCarrito(clave(usuarioId), revisionClave(usuarioId), TTL_SEGUNDOS));
    const revision = cache?.[0] || '0';
    const campos = cache?.[1] || [];
    const crudo = {};
    for (let i = 0; i < campos.length; i += 2) crudo[campos[i]] = campos[i + 1];
    const guardadas = leerLineas(crudo);
    if (!revisar && guardadas !== null) return respuesta(guardadas);
    const { items, completo } = await cargarActual(usuarioId);
    if (!completo) return respuesta(items);
    const payload = {};
    for (const item of items) payload[item.producto.id] = JSON.stringify(item);
    const publicada = await cacheSeguro((redis) => redis.publicarCarrito(clave(usuarioId), revisionClave(usuarioId), revision, TTL_SEGUNDOS, JSON.stringify(payload)));
    if (publicada === 0) continue; // Hubo una mutación/checkout durante esta lectura.
    return respuesta(items);
  }
  const err = new Error('El carrito cambió durante la consulta. Volvé a revisarlo.');
  err.status = 409;
  throw err;
}

function validar(productoId, cantidad, permiteCero = false) {
  if (!Number.isInteger(productoId) || productoId <= 0) throw new Error('productoId inválido');
  if (!Number.isInteger(cantidad) || cantidad < (permiteCero ? 0 : 1)) {
    throw new Error(`cantidad debe ser un entero ${permiteCero ? 'mayor o igual a 0' : 'positivo'}`);
  }
}

async function guardar(usuarioId, productoId, cantidad, sumar) {
  // Aviso temprano: que el carrito nunca contenga algo que el checkout va a
  // rechazar. El checkout lo vuelve a verificar (carritos anteriores a la regla,
  // llamadas directas a la API).
  await productoService.verificarNoEsPropio(usuarioId, [productoId]);
  // Mongo, o su copia en el índice de búsqueda si Mongo está apagado (estadoPublicacion).
  const producto = (await productoService.estadoPublicacion([productoId])).get(productoId);
  if (producto?.estado !== 'activo' || (await productoService.vendedorOculto(producto.vendedor_id))) throw new Error('El producto no está disponible');
  await prisma.$transaction(async (tx) => {
    await bloquearUsuario(tx, usuarioId);
    const inventario = await tx.inventario.findUnique({ where: { id_producto: productoId } });
    const existente = await tx.carrito.findUnique({ where: { id_usuario_id_producto: { id_usuario: usuarioId, id_producto: productoId } } });
    const nueva = Math.min((sumar ? existente?.cantidad || 0 : 0) + cantidad, inventario?.cantidad || 0);
    if (nueva <= 0) {
      await tx.carrito.deleteMany({ where: { id_usuario: usuarioId, id_producto: productoId } });
    } else {
      await tx.carrito.upsert({
        where: { id_usuario_id_producto: { id_usuario: usuarioId, id_producto: productoId } },
        create: { id_usuario: usuarioId, id_producto: productoId, cantidad: nueva, estado: 'activo' },
        update: { cantidad: nueva, estado: 'activo' },
      });
    }
    await avanzarVersion(tx, usuarioId);
  });
  await invalidarCache(usuarioId);
  return obtener(usuarioId);
}

async function agregar(usuarioId, productoId, cantidad) {
  validar(productoId, cantidad);
  return guardar(usuarioId, productoId, cantidad, true);
}

async function actualizarCantidad(usuarioId, productoId, cantidad) {
  validar(productoId, cantidad, true);
  if (cantidad === 0) return quitar(usuarioId, productoId);
  return guardar(usuarioId, productoId, cantidad, false);
}

async function quitar(usuarioId, productoId) {
  validar(productoId, 0, true);
  await prisma.$transaction(async (tx) => {
    await bloquearUsuario(tx, usuarioId);
    await tx.carrito.deleteMany({ where: { id_usuario: usuarioId, id_producto: productoId } });
    await avanzarVersion(tx, usuarioId);
  });
  await invalidarCache(usuarioId);
  return obtener(usuarioId);
}

async function vaciar(usuarioId) {
  await prisma.$transaction(async (tx) => {
    await bloquearUsuario(tx, usuarioId);
    await tx.carrito.deleteMany({ where: { id_usuario: usuarioId } });
    await avanzarVersion(tx, usuarioId);
  });
  await invalidarCache(usuarioId);
}

module.exports = { obtener, revisar: (usuarioId) => obtener(usuarioId, true), agregar, actualizarCantidad, quitar, vaciar, invalidarCache, bloquearUsuario, avanzarVersion, TTL_SEGUNDOS };
