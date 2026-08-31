const { conectar } = require('../config/redis');
const productoService = require('./productoService');

// 7.5 min — expiración por inactividad (ver IA/ENTREGA-2-PLAN.md §4.1).
// Declarado acá, no repetido, para que el valor esté en un único lugar.
const TTL_SEGUNDOS = 450;

function clave(usuarioId) {
  return `carrito:${usuarioId}`;
}

// Reinicia el TTL en CUALQUIER interacción (lectura o escritura) — "por
// inactividad" significa que ni siquiera mirar el carrito cuenta como
// inactividad, no solo agregar/quitar ítems. Si la clave ya no existe (p.
// ej. se vació del todo con el último hdel, que Redis borra solo cuando un
// hash queda vacío) esto es un no-op, no un error.
async function refrescarTTL(redis, usuarioId) {
  await redis.expire(clave(usuarioId), TTL_SEGUNDOS);
}

// Arma la respuesta pública resolviendo cada línea contra el catálogo
// VIGENTE (Mongo) — nunca contra un precio/descripción que se haya cacheado
// en Redis al momento de agregar. Si el producto cambió (o se borró) mientras
// estaba en el carrito, esto siempre refleja el estado actual.
async function obtener(usuarioId) {
  const redis = conectar();
  const crudo = await redis.hgetall(clave(usuarioId));
  await refrescarTTL(redis, usuarioId);

  const items = [];
  for (const [productoIdStr, cantidadStr] of Object.entries(crudo)) {
    try {
      const producto = await productoService.obtener(Number(productoIdStr));
      items.push({ producto, cantidad: Number(cantidadStr) });
    } catch {
      // Producto borrado/desactivado entre que se agregó y ahora — se omite
      // esa línea en vez de romper el carrito entero.
    }
  }

  const cantidadTotal = items.reduce((acc, it) => acc + it.cantidad, 0);
  const total = items.reduce((acc, it) => acc + Number(it.producto.inventario?.precio ?? 0) * it.cantidad, 0);
  return { items, cantidadTotal, total };
}

// Suma `cantidad` a lo que ya hubiera para ese producto (o lo crea) — clamp
// contra el stock vigente, mismo comportamiento que ya tenía CartContext.jsx
// del lado del cliente (ver ENTREGA-2-PLAN.md §4.1) antes de esta migración.
async function agregar(usuarioId, productoId, cantidad) {
  if (!Number.isInteger(productoId) || productoId <= 0) throw new Error('productoId inválido');
  if (!Number.isInteger(cantidad) || cantidad <= 0) throw new Error('cantidad debe ser un entero positivo');

  const producto = await productoService.obtener(productoId);
  const stock = producto.inventario?.cantidad ?? 0;

  const redis = conectar();
  const k = clave(usuarioId);
  const actual = Number((await redis.hget(k, String(productoId))) || 0);
  const nueva = Math.min(actual + cantidad, stock);

  if (nueva <= 0) {
    await redis.hdel(k, String(productoId));
  } else {
    await redis.hset(k, String(productoId), String(nueva));
  }
  await refrescarTTL(redis, usuarioId);
  return obtener(usuarioId);
}

// Fija la cantidad exacta (no suma) — para el selector de cantidad dentro del
// carrito, distinto de "Agregar al carrito" (que sí suma).
async function actualizarCantidad(usuarioId, productoId, cantidad) {
  if (!Number.isInteger(productoId) || productoId <= 0) throw new Error('productoId inválido');
  if (!Number.isInteger(cantidad) || cantidad < 0) throw new Error('cantidad debe ser un entero mayor o igual a 0');

  const redis = conectar();
  const k = clave(usuarioId);
  if (cantidad === 0) {
    await redis.hdel(k, String(productoId));
  } else {
    const producto = await productoService.obtener(productoId);
    const stock = producto.inventario?.cantidad ?? 0;
    await redis.hset(k, String(productoId), String(Math.min(cantidad, stock)));
  }
  await refrescarTTL(redis, usuarioId);
  return obtener(usuarioId);
}

async function quitar(usuarioId, productoId) {
  const redis = conectar();
  await redis.hdel(clave(usuarioId), String(productoId));
  await refrescarTTL(redis, usuarioId);
  return obtener(usuarioId);
}

// Se llama al confirmar un checkout exitoso — a propósito un DEL directo, no
// dejar que el TTL lo resuelva solo (ver ENTREGA-2-PLAN.md §4.1, "efecto
// documentado sobre el checkout").
async function vaciar(usuarioId) {
  const redis = conectar();
  await redis.del(clave(usuarioId));
}

module.exports = { obtener, agregar, actualizarCantidad, quitar, vaciar, TTL_SEGUNDOS };
