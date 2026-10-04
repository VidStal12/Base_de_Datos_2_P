const test = require('node:test');
const assert = require('node:assert/strict');
const { cargar, redisFalso } = require('./redisHelpers');

function escenario() {
  const redis = redisFalso();
  const filas = new Map();
  const inv = { precio: 10, cantidad: 10 };
  let consultas = 0;
  let bloqueo = Promise.resolve();
  const db = {
    async $queryRaw() { consultas += 1; return [...filas].map(([id_producto, cantidad]) => ({ id_producto, cantidad, precio: inv.precio, stock: inv.cantidad })); },
    async $transaction(fn) {
      // Simula el lock SQL compartido por todas las mutaciones de este usuario.
      const anterior = bloqueo;
      let liberar;
      bloqueo = new Promise((resolve) => { liberar = resolve; });
      await anterior;
      try { return await fn({ ...db, $queryRaw: async () => [{ id_usuario: 7 }] }); }
      finally { liberar(); }
    },
    inventario: { findUnique: async () => inv, findMany: async ({ where }) => where.id_producto.in.map((id_producto) => ({ id_producto, ...inv })) },
    carrito: {
      async findMany() { consultas += 1; return [...filas].map(([id_producto, cantidad]) => ({ id_producto, cantidad })); },
      async findUnique({ where }) { const id = where.id_usuario_id_producto.id_producto; return filas.has(id) ? { cantidad: filas.get(id) } : null; },
      async upsert({ create }) { filas.set(create.id_producto, create.cantidad); },
      async deleteMany({ where }) { if (where.id_producto) filas.delete(where.id_producto); else filas.clear(); },
    },
  };
  const productos = new Map([1, 2].map((id) => [id, { producto_id: id, descripcion: `Producto ${id}`, estado: 'activo', imagenes: [{ principal: true, url: `imagen-${id}` }] }]));
  let consultasMongo = 0;
  const modelo = {
    find: ({ producto_id }) => ({ select: () => ({ lean: async () => { consultasMongo += 1; return producto_id.$in.map((id) => productos.get(id)).filter(Boolean); } }) }),
    findOne: ({ producto_id }) => ({ select: () => ({ lean: async () => productos.get(producto_id) }) }),
  };
  const servicio = cargar('../src/services/cartService.js', {
    '../config/prisma': db, '../config/redis': { conectar: () => redis },
    '../config/mongo': { conectar: async () => {} }, '../models/mongo/Producto': modelo,
  });
  return { servicio, filas, inv, redis, productos, consultas: () => consultas, consultasMongo: () => consultasMongo };
}

test('Redis guarda su propia copia sin inventario; al vencerlo recupera cantidades desde SQL', async () => {
  const e = escenario();
  await e.servicio.agregar(7, 1, 2);
  const guardado = JSON.parse(e.redis.hashes.get('carrito:7')['1']);
  assert.equal(guardado.producto.id, 1);
  assert.equal(guardado.producto.precio, 10);
  assert.equal(guardado.producto.imagen_url, 'imagen-1');
  assert.equal('inventario' in guardado.producto, false);
  assert.equal(guardado.cantidad, 2);
  assert.equal(e.redis.ttls.get('carrito:7'), 450);
  await e.redis.del('carrito:7');
  assert.equal((await e.servicio.obtener(7)).items[0].cantidad, 2);
});

test('carrito caliente lee solo Redis; checkout actualiza datos por lote sin comparaciones', async () => {
  const e = escenario();
  await e.servicio.agregar(7, 1, 2);
  await e.servicio.agregar(7, 2, 1);
  e.inv.precio = 12.5;
  e.inv.cantidad = 1;
  e.productos.get(1).descripcion = 'Descripción vigente';
  const antes = e.consultas();
  const mongoAntes = e.consultasMongo();
  const carrito = await e.servicio.obtener(7);
  assert.equal(e.consultas() - antes, 0);
  assert.equal(e.consultasMongo(), mongoAntes);
  assert.equal(carrito.total, 30);
  assert.equal(carrito.items[0].producto.descripcion, 'Producto 1');
  assert.equal(e.filas.get(1), 2, 'mirar el carrito no elimina unidades persistidas');
  const revisado = await e.servicio.revisar(7);
  assert.equal(revisado.total, 37.5);
  assert.equal(revisado.items[0].producto.descripcion, 'Descripción vigente');
  assert.equal(revisado.items[0].disponible, false);
  assert.equal(e.consultas() - antes, 1);
  assert.equal(e.consultasMongo() - mongoAntes, 1);
  assert.equal('precioAnterior' in revisado.items[0], false);
  assert.equal('precioCambio' in revisado.items[0], false);
  assert.equal((await e.servicio.obtener(7)).total, 37.5);
});

test('agregados simultáneos se suman, clamp SQL, cantidad cero elimina la fila', async () => {
  const e = escenario();
  await Promise.all([e.servicio.agregar(7, 1, 2), e.servicio.agregar(7, 1, 3)]);
  assert.equal(e.filas.get(1), 5);
  await e.servicio.agregar(7, 1, 999);
  assert.equal(e.filas.get(1), 10);
  await e.servicio.actualizarCantidad(7, 1, 0);
  assert.equal(e.filas.size, 0);
  assert.equal((await e.servicio.obtener(7)).items.length, 0);
  const antes = e.consultas();
  await e.servicio.obtener(7);
  assert.equal(e.consultas(), antes, 'el carrito vacío también evita SQL');
});

test('una caché vieja no resucita filas borradas; Redis caído no impide persistir ni vaciar', async () => {
  const e = escenario();
  await e.servicio.agregar(7, 1, 2);
  e.filas.clear();
  await e.servicio.invalidarCache(7);
  assert.equal((await e.servicio.obtener(7)).items.length, 0);
  e.redis.leerCarrito = async () => { throw new Error('Redis caído'); };
  e.redis.publicarCarrito = async () => { throw new Error('Redis caído'); };
  e.redis.invalidarCarrito = async () => { throw new Error('Redis caído'); };
  await e.servicio.agregar(7, 1, 2);
  assert.equal(e.filas.get(1), 2);
  await e.servicio.vaciar(7);
  assert.equal(e.filas.size, 0);
});

test('checkout rechaza un precio cambiado antes de descontar o vaciar el carrito', async () => {
  let descontado = false;
  let vaciado = false;
  const servicio = cargar('../src/services/checkoutService.js', {
    '../config/prisma': { $transaction: async (fn) => fn({
      direcciones: { findUnique: async () => ({ id_usuario: 7 }) },
      metodo_pago: { findUnique: async () => ({ id_usuario: 7 }) },
      inventario: { findUnique: async () => ({ precio: 12, cantidad: 5 }), updateMany: async () => { descontado = true; } },
      carrito: { deleteMany: async () => { vaciado = true; } },
    }) },
    './cartService': { bloquearUsuario: async () => {} },
    '../config/mongo': { conectar: async () => {} }, '../models/mongo/Producto': { find: () => ({ select: () => ({ lean: async () => [{ producto_id: 1, estado: 'activo' }] }) }) },
    './ventasOutboxService': {}, './fraudeSyncService': {},
  });
  await assert.rejects(servicio.checkout({ usuarioId: 7, direccionId: 1, metodoPagoId: 1, items: [{ productoId: 1, cantidad: 2, precioEsperado: 10 }] }), (err) => err.status === 409);
  assert.equal(descontado, false);
  assert.equal(vaciado, false);
});

test('una lectura anterior a una mutación no puede publicar el carrito viejo', async () => {
  const e = escenario();
  e.filas.set(1, 2);
  const publicar = e.redis.publicarCarrito;
  let primera = true;
  e.redis.publicarCarrito = async (...args) => {
    if (primera) {
      primera = false;
      e.filas.clear(); // representa la confirmación del checkout en SQL
      await e.servicio.invalidarCache(7);
    }
    return publicar(...args);
  };
  assert.equal((await e.servicio.obtener(7)).items.length, 0);
  assert.equal(e.redis.hashes.get('carrito:7')['1'], undefined);
});

test('el formato previo con referencias se reconstruye sin perder las cantidades SQL', async () => {
  const e = escenario();
  e.filas.set(1, 3);
  e.redis.hashes.set('carrito:7', { _formato: '2', '1': JSON.stringify({ productoId: 1, cantidad: 99 }) });
  assert.equal((await e.servicio.obtener(7)).items[0].cantidad, 3);
  assert.equal(JSON.parse(e.redis.hashes.get('carrito:7')['1']).producto.id, 1);
});

test('si se desactiva un producto después de revisar, confirmar rechaza antes de tocar SQL', async () => {
  const servicio = cargar('../src/services/checkoutService.js', {
    '../config/prisma': { $transaction: () => assert.fail('no debe comenzar la compra de un producto inactivo') },
    '../config/mongo': { conectar: async () => {} },
    '../models/mongo/Producto': { find: () => ({ select: () => ({ lean: async () => [{ producto_id: 1, estado: 'inactivo' }] }) }) },
    './cartService': {}, './ventasOutboxService': {}, './fraudeSyncService': {},
  });
  await assert.rejects(servicio.checkout({ usuarioId: 7, direccionId: 1, metodoPagoId: 1, items: [{ productoId: 1, cantidad: 2, precioEsperado: 10 }] }), (err) => err.status === 409);
});

test('cada carrito conserva su propia información hasta su revisión', async () => {
  const e = escenario();
  await e.servicio.agregar(7, 1, 2);
  e.redis.hashes.set('carrito:8', { ...e.redis.hashes.get('carrito:7') });
  e.productos.get(1).descripcion = 'Producto editado';
  e.inv.precio = 12;
  await e.servicio.revisar(7);
  const antes = e.consultas();
  const [a, b] = await Promise.all([e.servicio.obtener(7), e.servicio.obtener(8)]);
  assert.equal(a.items[0].producto.descripcion, 'Producto editado');
  assert.equal(b.items[0].producto.descripcion, 'Producto 1');
  assert.equal(a.total, 24);
  assert.equal(b.total, 20);
  assert.equal(e.consultas(), antes);
  assert.equal('producto' in JSON.parse(e.redis.hashes.get('carrito:8')['1']), true);
});

test('un producto ausente sigue en el carrito, sin poder confirmarse', async () => {
  const e = escenario();
  await e.servicio.agregar(7, 1, 2);
  e.productos.delete(1);
  const c = await e.servicio.revisar(7);
  assert.equal(c.items[0].producto.id, 1);
  assert.equal(c.items[0].disponible, false);
  assert.equal(e.filas.get(1), 2);
});
