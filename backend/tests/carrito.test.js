const test = require('node:test');
const assert = require('node:assert/strict');
const { cargar, redisFalso, productoFalso, compromisoFalso, ACEPTADO_EN } = require('./redisHelpers');

// `propios`: ids de producto que pertenecen a quien compra (usuario 7) — la
// regla "nadie compra lo que él mismo vende", que cartService exige con
// productoService.verificarNoEsPropio.
function escenario({ propios = [], suspendidos = [] } = {}) {
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
  const productos = new Map([1, 2].map((id) => [id, { producto_id: id, vendedor_id: id + 10, descripcion: `Producto ${id}`, estado: 'activo', imagenes: [{ principal: true, url: `imagen-${id}` }] }]));
  let consultasMongo = 0;
  const modelo = {
    find: ({ producto_id }) => ({ select: () => ({ lean: async () => { consultasMongo += 1; return producto_id.$in.map((id) => productos.get(id)).filter(Boolean); } }) }),
    findOne: ({ producto_id }) => ({ select: () => ({ lean: async () => productos.get(producto_id) }) }),
  };
  const servicio = cargar('../src/services/cartService.js', {
    '../config/prisma': db, '../config/redis': { conectar: () => redis },
    '../config/mongo': { conectar: async () => {} }, '../models/mongo/Producto': modelo,
    './productoService': productoFalso({ propios, suspendidos }),
  });
  return { servicio, filas, inv, redis, productos, consultas: () => consultas, consultasMongo: () => consultasMongo };
}

// Doble de lo que checkoutService necesita para llegar hasta la transacción.
function dependenciasCheckout(extra = {}) {
  return {
    '../config/mongo': { conectar: async () => {} },
    './productoService': productoFalso(),
    './compromisoService': compromisoFalso(),
    './cartService': { bloquearUsuario: async () => {}, invalidarCache: async () => {} },
    './ventasOutboxService': { encolarCompra: async () => {} },
    './fraudeSyncService': {},
    ...extra,
  };
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
  const servicio = cargar('../src/services/checkoutService.js', dependenciasCheckout({
    '../config/prisma': { $transaction: async (fn) => fn({
      direcciones: { findUnique: async () => ({ id_usuario: 7 }) },
      metodo_pago: { findUnique: async () => ({ id_usuario: 7 }) },
      inventario: { findUnique: async () => ({ precio: 12, cantidad: 5 }), updateMany: async () => { descontado = true; } },
      carrito: { deleteMany: async () => { vaciado = true; } },
    }) },
    '../models/mongo/Producto': { find: () => ({ select: () => ({ lean: async () => [{ producto_id: 1, estado: 'activo' }] }) }) },
  }));
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
  const servicio = cargar('../src/services/checkoutService.js', dependenciasCheckout({
    '../config/prisma': { $transaction: () => assert.fail('no debe comenzar la compra de un producto inactivo') },
    '../models/mongo/Producto': { find: () => ({ select: () => ({ lean: async () => [{ producto_id: 1, estado: 'inactivo' }] }) }) },
  }));
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

test('un producto propio no entra al carrito: se rechaza sin tocar SQL ni Redis', async () => {
  const e = escenario({ propios: [1] });
  await assert.rejects(e.servicio.agregar(7, 1, 1), (err) => err.status === 403);
  await assert.rejects(e.servicio.actualizarCantidad(7, 1, 3), (err) => err.status === 403);
  assert.equal(e.filas.size, 0);
  assert.equal(e.redis.hashes.size, 0);
  assert.equal(e.consultas(), 0);
  await e.servicio.agregar(7, 2, 1); // un producto ajeno del mismo comprador sí entra
  assert.equal(e.filas.get(2), 1);
});

// Compra completa con dobles — lo justo para llegar al `compra.create` y ver qué
// se guarda en el pedido.
function escenarioCompra({ vendedores = [] } = {}) {
  const guardado = {};
  const compromiso = compromisoFalso({ vendedores });
  const tx = {
    direcciones: { findUnique: async () => ({ id_usuario: 7 }) },
    metodo_pago: { findUnique: async () => ({ id_usuario: 7 }) },
    inventario: { findUnique: async () => ({ precio: 12, cantidad: 5 }), updateMany: async () => ({ count: 1 }) },
    compra: { create: async ({ data }) => { guardado.compra = data; return { id: 99, fecha: new Date(), ...data, compra_detalles: [{ id: 1, id_producto: 1, precio_final: 24 }] }; } },
    pago: { create: async ({ data }) => data },
    carrito: { deleteMany: async () => {} },
  };
  let transacciones = 0;
  const servicio = cargar('../src/services/checkoutService.js', dependenciasCheckout({
    '../config/prisma': {
      $transaction: async (fn) => { transacciones += 1; return fn(tx); },
      usuarios: { findUnique: async () => ({ nombres: 'A', apellidos: 'B', rol: { tipo_rol: 'vendedor' } }) },
    },
    './compromisoService': compromiso,
    '../models/mongo/Producto': {
      find: () => ({ select: () => ({ lean: async () => [{ producto_id: 1, estado: 'activo' }] }) }),
      findOne: () => ({ select: () => ({ lean: async () => null }) }),
      updateOne: async () => {},
    },
  }));
  return { servicio, guardado, compromiso, transacciones: () => transacciones };
}

const pedido = { usuarioId: 7, direccionId: 1, metodoPagoId: 1, items: [{ productoId: 1, cantidad: 2 }] };

test('un vendedor que no aceptó el compromiso de no reventa no llega a la transacción', async () => {
  const e = escenarioCompra({ vendedores: [7] });
  await assert.rejects(e.servicio.checkout(pedido), (err) => err.status === 400 && err.codigo === 'COMPROMISO_NO_REVENTA');
  await assert.rejects(e.servicio.checkout({ ...pedido, aceptaNoReventa: 'true' }), (err) => err.codigo === 'COMPROMISO_NO_REVENTA');
  assert.equal(e.transacciones(), 0);
});

test('el pedido de un vendedor guarda la constancia de su compromiso; el de un comprador no', async () => {
  const vendedor = escenarioCompra({ vendedores: [7] });
  await vendedor.servicio.checkout({ ...pedido, aceptaNoReventa: true });
  assert.equal(vendedor.guardado.compra.no_reventa_aceptada_en, ACEPTADO_EN);

  const comprador = escenarioCompra({ vendedores: [] });
  await comprador.servicio.checkout(pedido);
  assert.equal(comprador.guardado.compra.no_reventa_aceptada_en, null);
});

test('el producto de un vendedor suspendido sale como no disponible en el carrito y no se puede agregar; vuelve al levantarse', async () => {
  const suspendidos = new Set();
  const e = escenario({ suspendidos });
  await e.servicio.agregar(7, 1, 1);
  await e.servicio.agregar(7, 2, 1);
  assert.ok((await e.servicio.revisar(7)).items.every((item) => item.disponible), 'sin suspensión, todo disponible');

  suspendidos.add(11); // el vendedor del producto 1 se suspende
  const durante = (await e.servicio.revisar(7)).items;
  assert.equal(durante.find((item) => item.producto.id === 1).disponible, false, 'su producto sigue en el carrito, pero no disponible: el checkout lo rechazaría');
  assert.equal(durante.find((item) => item.producto.id === 2).disponible, true, 'el de otro vendedor no se toca');
  await assert.rejects(e.servicio.agregar(7, 1, 1), /no está disponible/);
  await e.servicio.agregar(7, 2, 1);

  suspendidos.delete(11); // se levanta la suspensión: vuelve solo
  assert.ok((await e.servicio.revisar(7)).items.every((item) => item.disponible));
  await e.servicio.agregar(7, 1, 1);
});
