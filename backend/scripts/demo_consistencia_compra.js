// ============================================================
// TiendaYa — Demo de consistencia del checkout distribuido (Entrega 3).
// Evidencia de la prueba de falla simulada de IA/ENTREGA-3-CONSISTENCIA.md §5.
//
// Llama a checkoutService.checkout(), la MISMA función que usa la API real, contra las
// bases REALES (MySQL, MongoDB, Redis, Cassandra y Neo4j), y lee cada una antes y después
// para mostrar el estado verdadero. Crea sus propias cuentas y su producto de prueba
// ("Demo"); el producto queda INACTIVO (no sale en la tienda) salvo el instante de cada
// compra.
//
// Uso (desde backend/, con el docker-compose arriba):
//   node scripts/demo_consistencia_compra.js                       camino normal, todo arriba
//   node scripts/demo_consistencia_compra.js --falla=<escenario>   una falla simulada
//   node scripts/demo_consistencia_compra.js --falla=todas         las seis + la tabla final
// Escenarios: mysql-dentro | mongo-antes | mongo-despues | redis | neo4j | cassandra
// (también: npm run demo:consistencia  y  npm run demo:consistencia:fallas)
//
// Cada escenario nombra el COMPONENTE, el PUNTO DE FALLA, lo que se OBSERVA y el
// MECANISMO DE MITIGACIÓN (reintento idempotente, compensación/reparación, o ventana de
// consistencia eventual aceptada y documentada), y comprueba con aserciones que lo
// observado es lo que el documento afirma: si algo no coincide, el script sale con 1.
//
// CÓMO SE SIMULA LA FALLA. La llamada que fallaría (Producto.find, Producto.updateOne,
// cassandra.obtenerCliente…) se reemplaza SOLO en este proceso y SOLO mientras dura esa
// llamada por una que rechaza con el error que daría la base caída (ECONNREFUSED). Las
// bases siguen arriba para poder leer los efectos reales sobre cada una; no se detiene
// ningún contenedor ni se toca el backend que esté corriendo. Complementa a
// intentarCheckoutReal.js, que corre un checkout contra un contenedor realmente detenido
// (capturas del 2026-09-09 en el documento).
//
// El worker del backend (VENTAS_SYNC_ENABLED, cada 30 s) también drena el outbox: la demo
// aparta su fila una hora para que no se la lleve mientras se narra, y la drena ella misma.
// ============================================================

require('dotenv').config();
const { textosParaGrafo } = require('../src/utils/textosProducto');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const prisma = require('../src/config/prisma');
const { conectar: conectarMongo } = require('../src/config/mongo');
const Producto = require('../src/models/mongo/Producto');
const Subcategoria = require('../src/models/mongo/Subcategoria');
const neo4j = require('../src/config/neo4j');
const cassandraConfig = require('../src/config/cassandra');
const redisConfig = require('../src/config/redis');
const checkoutService = require('../src/services/checkoutService');
const cartService = require('../src/services/cartService');
const ventasSync = require('../src/services/ventasSyncService');
const catalogoSync = require('../src/services/catalogoSyncService');
const fraudeSync = require('../src/services/fraudeSyncService');
const { crearCuenta, crearDireccion, crearMetodoPago, asegurarProducto, conProductoActivo } = require('./lib/datosPrueba');

const CORREO_VENDEDOR = 'demo.vendedor@tiendaya.com';
const CORREO_COMPRADOR = 'demo.comprador@tiendaya.com';
const CONTRASENA_DEMO = 'Password123!';
const DESCRIPCION_DEMO = 'PRODUCTO DEMO - consistencia entre bases';
const PRECIO_DEMO = 100;
const STOCK_DEMO = 10;
const HORA_MS = 3600000;

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const linea = () => console.log('-'.repeat(78));
const titulo = (texto) => {
  linea();
  console.log(texto);
  linea();
};
const dato = (clave, valor) => console.log(`  ${clave.padEnd(28)} ${valor}`);

// ── Inyección de fallas ─────────────────────────────────────────────────────

// Reemplaza objeto[metodo] por algo que rechaza con `mensaje`, solo mientras dura `accion`.
async function conFalla(objeto, metodo, mensaje, accion, { sincrona = false } = {}) {
  const propia = Object.prototype.hasOwnProperty.call(objeto, metodo);
  const original = objeto[metodo];
  objeto[metodo] = sincrona
    ? () => {
        throw new Error(mensaje);
      }
    : async () => {
        throw new Error(mensaje);
      };
  try {
    return await accion();
  } finally {
    if (propia) objeto[metodo] = original;
    else delete objeto[metodo];
  }
}

// Lo que el backend deja registrado (console.error) cuando un reenvío falla y se atrapa.
async function capturandoLogs(accion) {
  const registros = [];
  const original = console.error;
  console.error = (...args) => registros.push(args.map(String).join(' '));
  try {
    return { valor: await accion(), registros, error: null };
  } catch (error) {
    return { valor: null, registros, error };
  } finally {
    console.error = original;
  }
}

// ── Datos de la demo ────────────────────────────────────────────────────────

// Las primeras versiones del script guardaban la contraseña en claro ("x"): se corrige a
// un hash real, para que estas cuentas se comporten como las de los demás scripts.
async function asegurarCuenta(correo, nombres, rol) {
  const usuario = await crearCuenta(correo, nombres, { apellidos: 'Demo', rol });
  if (usuario.contrasena.startsWith('$2')) return usuario;
  return prisma.usuarios.update({ where: { id_usuario: usuario.id_usuario }, data: { contrasena: await bcrypt.hash(CONTRASENA_DEMO, 10) } });
}

// Pone la copia de Mongo igual a MySQL con la MISMA reparación que usa el administrador
// (catalogoSyncService), acotada a este producto: así cada escenario parte de cero
// desfase y no se reescribe el resto del catálogo.
async function alinearCopias(ctx, { reiniciarStock = false } = {}) {
  if (reiniciarStock) await prisma.inventario.update({ where: { id_producto: ctx.productoId }, data: { precio: PRECIO_DEMO, cantidad: STOCK_DEMO } });
  await catalogoSync.recalcularInventario({ productoIds: [ctx.productoId] });
  await catalogoSync.recalcularVentas({ productoIds: [ctx.productoId] });
}

async function prepararDatos() {
  const vendedor = await asegurarCuenta(CORREO_VENDEDOR, 'Vendedora', 'vendedor');
  const comprador = await asegurarCuenta(CORREO_COMPRADOR, 'Comprador', 'comprador');
  const direccion = (await prisma.direcciones.findFirst({ where: { id_usuario: comprador.id_usuario } })) ?? (await crearDireccion(comprador.id_usuario));
  const metodoPago = (await prisma.metodo_pago.findFirst({ where: { id_usuario: comprador.id_usuario } })) ?? (await crearMetodoPago(comprador.id_usuario, 'tok_demo'));

  // Con subcategoría, como cualquier producto real: sin ella el reenvío a Neo4j no puede
  // resolver la categoría y falla (así quedó el producto de las primeras versiones). Y
  // inactivo: solo está activo durante cada compra (conProductoActivo).
  await conectarMongo();
  const producto = await asegurarProducto(vendedor, DESCRIPCION_DEMO, PRECIO_DEMO, { cantidad: STOCK_DEMO });
  const doc = await Producto.findOne({ producto_id: producto.id }).select('subcategoria_id').lean();
  const ajustes = { estado: 'inactivo' };
  if (!doc.subcategoria_id) {
    const subcategoria = await Subcategoria.findOne({ subcategoria: 'Camisetas' }).select('_id').lean();
    ajustes.subcategoria_id = subcategoria._id;
  }
  await Producto.updateOne({ producto_id: producto.id }, { $set: ajustes });

  const ctx = { vendedor, comprador, direccion, metodoPago, productoId: producto.id };
  await alinearCopias(ctx, { reiniciarStock: true });
  return ctx;
}

// ── Estado de cada base ─────────────────────────────────────────────────────

async function conCaptura(lectura) {
  try {
    return await lectura();
  } catch (err) {
    return { error: err.message };
  }
}

async function leerEstado(ctx, detalleIds = []) {
  const { productoId } = ctx;
  const compradorId = ctx.comprador.id_usuario;
  const ids = new Set(detalleIds);
  const mysql = await prisma.inventario.findUnique({ where: { id_producto: productoId } });
  const vendido = await prisma.compra_detalle.aggregate({ where: { id_producto: productoId }, _sum: { cantidad: true } });
  const doc = await Producto.findOne({ producto_id: productoId }).select('inventario total_vendido').lean();
  return {
    mysql: {
      stock: mysql.cantidad,
      vendido: vendido._sum.cantidad ?? 0,
      pedidos: await prisma.compra.count({ where: { id_usuario: compradorId } }),
      carritoSql: await prisma.carrito.count({ where: { id_usuario: compradorId } }),
      outboxPendiente: detalleIds.length ? await prisma.venta_outbox.count({ where: { detalle_id: { in: detalleIds }, procesado_en: null } }) : 0,
    },
    mongo: { stock: doc.inventario.cantidad, vendido: doc.total_vendido },
    redis: await conCaptura(async () => {
      const redis = redisConfig.conectar('admin');
      const clave = `carrito:${compradorId}`;
      const campos = (await redis.hkeys(clave)).filter((campo) => campo !== '_formato');
      return { lineas: campos.length, ttlSegundos: campos.length ? Math.round((await redis.pttl(clave)) / 1000) : null };
    }),
    cassandra: await conCaptura(async () => {
      const cliente = await cassandraConfig.obtenerCliente();
      const r = await cliente.execute('SELECT detalle_id FROM ventas_por_producto_mes WHERE producto_id = ? ALLOW FILTERING', [productoId], { prepare: true });
      return { producto: r.rowLength, estaVenta: r.rows.filter((fila) => ids.has(fila.detalle_id)).length };
    }),
    neo4j: await conCaptura(async () => {
      const [r] = await neo4j.leer(
        'MATCH ()-[c:COMPRÓ]->(:Producto {producto_id: $productoId}) RETURN count(c) AS producto, count(CASE WHEN c.detalle_id IN $ids THEN 1 END) AS estaVenta',
        { productoId, ids: detalleIds }
      );
      return { producto: r.get('producto').toNumber(), estaVenta: r.get('estaVenta').toNumber() };
    }),
  };
}

function imprimirEstado(etiqueta, e) {
  titulo(`ESTADO ${etiqueta}`);
  dato('MySQL (autoridad)', `stock=${e.mysql.stock} | vendido=${e.mysql.vendido} | pedidos del comprador=${e.mysql.pedidos} | carrito SQL=${e.mysql.carritoSql} | outbox pendiente de esta venta=${e.mysql.outboxPendiente}`);
  const desfase = e.mongo.stock !== e.mysql.stock || e.mongo.vendido !== e.mysql.vendido;
  dato('MongoDB (copia)', `stock=${e.mongo.stock} | total_vendido=${e.mongo.vendido}${desfase ? '   <-- DESFASADO respecto a MySQL' : ''}`);
  dato('Redis (caché carrito)', e.redis.error ? `no se pudo consultar: ${e.redis.error}` : e.redis.lineas ? `copia del carrito con ${e.redis.lineas} línea(s), TTL ${e.redis.ttlSegundos} s` : 'sin copia del carrito (vacío)');
  dato('Cassandra (analítica)', e.cassandra.error ? `no se pudo consultar: ${e.cassandra.error}` : `filas de esta venta=${e.cassandra.estaVenta} (del producto: ${e.cassandra.producto})`);
  dato('Neo4j (grafo de fraude)', e.neo4j.error ? `no se pudo consultar: ${e.neo4j.error}` : `relaciones COMPRÓ de esta venta=${e.neo4j.estaVenta} (del producto: ${e.neo4j.producto})`);
}

// ── Acciones sobre el checkout real ─────────────────────────────────────────

// checkout() real, con el producto activo solo durante la compra. `alRodear` envuelve la
// llamada (ahí es donde un escenario inyecta su falla, para que NO afecte al resto).
async function comprar(ctx, { items, alRodear } = {}) {
  return conProductoActivo({ id: ctx.productoId }, async () => {
    const pedido = {
      usuarioId: ctx.comprador.id_usuario,
      direccionId: ctx.direccion.id,
      metodoPagoId: ctx.metodoPago.id,
      items: items ?? [{ productoId: ctx.productoId, cantidad: 1, precioEsperado: PRECIO_DEMO }],
    };
    return alRodear ? alRodear(() => checkoutService.checkout(pedido)) : checkoutService.checkout(pedido);
  });
}

const detallesDe = (resultado) => resultado.compra.compra_detalles.map((detalle) => detalle.id);

// El outbox lo drena también el worker del backend: se aparta la fila de la demo.
async function apartarFilas(detalleIds) {
  await prisma.venta_outbox.updateMany({ where: { detalle_id: { in: detalleIds }, procesado_en: null }, data: { proximo_intento: new Date(Date.now() + HORA_MS) } });
}

// "hasta" dentro de dos horas: incluye las filas apartadas y se salta el backoff.
async function drenarOutbox(detalleIds) {
  let resumen = { seleccionados: 0, procesados: 0, fallidos: 0 };
  for (let vuelta = 0; vuelta < 5; vuelta += 1) {
    resumen = await ventasSync.procesarPendientes({ hasta: new Date(Date.now() + 2 * HORA_MS) });
    if (!(await prisma.venta_outbox.count({ where: { detalle_id: { in: detalleIds }, procesado_en: null } }))) break;
  }
  return resumen;
}

// Lo que hace scripts/backfillNeo4j.js: leer la compra de MySQL y llamar al MISMO
// registrarCompra (un MERGE por detalle_id: repetirlo no duplica nada).
async function reenviarCompraANeo4j(compraId) {
  const compra = await prisma.compra.findUnique({ where: { id: compraId }, include: { compra_detalles: true } });
  const usuario = await prisma.usuarios.findUnique({ where: { id_usuario: compra.id_usuario }, include: { rol: true } });
  for (const detalle of compra.compra_detalles) {
    const producto = await Producto.findOne({ producto_id: detalle.id_producto }).select('nombre descripcion subcategoria_id vendedor_id vendedor_nombre').lean();
    await fraudeSync.registrarCompra({
      detalleId: detalle.id,
      compraId: compra.id,
      usuarioId: usuario.id_usuario,
      usuarioNombre: `${usuario.nombres} ${usuario.apellidos}`,
      usuarioRol: usuario.rol.tipo_rol,
      vendedorId: producto.vendedor_id,
      vendedorNombre: producto.vendedor_nombre,
      productoId: detalle.id_producto,
      ...textosParaGrafo(producto),
      subcategoriaId: producto.subcategoria_id,
      fecha: compra.fecha,
      monto: detalle.precio_final,
    });
  }
}

// ── Escenarios de falla ─────────────────────────────────────────────────────

const ECONNREFUSED_MONGO = 'connect ECONNREFUSED 127.0.0.1:27018 (falla simulada)';

const ESCENARIOS = {
  'mysql-dentro': {
    titulo: 'MySQL falla A MITAD de la transacción',
    componente: 'MySQL',
    puntoDeFalla: 'dentro del $transaction: el 1.er ítem ya descontó stock y el 2.º no tiene',
    mitigacion: 'ROLLBACK atómico (no hay nada que compensar)',
    categoria: 'Atomicidad de la transacción (§1; §2 fila 3)',
    inyeccion: 'un pedido de dos ítems del mismo producto: 1 unidad y 9999 (hay 10)',
    async correr(ctx, verificar) {
      const antes = await leerEstado(ctx);
      imprimirEstado('ANTES', antes);
      const items = [
        { productoId: ctx.productoId, cantidad: 1, precioEsperado: PRECIO_DEMO },
        { productoId: ctx.productoId, cantidad: 9999, precioEsperado: PRECIO_DEMO },
      ];
      const { error } = await capturandoLogs(() => comprar(ctx, { items }));
      titulo('RESULTADO');
      dato('checkout()', error ? `LANZÓ: ${error.message}` : 'NO lanzó');
      const despues = await leerEstado(ctx);
      imprimirEstado('DESPUÉS', despues);
      verificar(error && /Stock insuficiente/.test(error.message), 'checkout() rechazó el pedido: stock insuficiente en el 2.º ítem');
      verificar(despues.mysql.stock === antes.mysql.stock, `el stock que el 1.er ítem ya había descontado volvió (${antes.mysql.stock} -> ${despues.mysql.stock}): ROLLBACK`);
      verificar(despues.mysql.pedidos === antes.mysql.pedidos, 'no se creó ningún pedido');
      verificar(despues.mongo.stock === antes.mongo.stock && despues.mongo.vendido === antes.mongo.vendido, 'Mongo no se tocó: ningún reenvío corre si MySQL no confirma');
      verificar(despues.cassandra.producto === antes.cassandra.producto && despues.neo4j.producto === antes.neo4j.producto, 'ni Cassandra ni Neo4j recibieron nada');
      return `pedido rechazado; stock ${antes.mysql.stock}->${despues.mysql.stock}, 0 pedidos nuevos, ninguna otra base tocada`;
    },
  },

  'mongo-antes': {
    titulo: 'MongoDB cae ANTES de que MySQL confirme',
    componente: 'MongoDB',
    puntoDeFalla: 'el pre-chequeo de estado: checkout() hace Producto.find(...) antes de abrir la transacción',
    mitigacion: 'Falla cerrada: rechazo limpio, se reintenta la compra',
    categoria: 'Sin inconsistencia posible: no hay nada confirmado',
    inyeccion: 'Producto.find lanza ECONNREFUSED',
    async correr(ctx, verificar) {
      const antes = await leerEstado(ctx);
      imprimirEstado('ANTES', antes);
      const { error } = await capturandoLogs(() => comprar(ctx, { alRodear: (fn) => conFalla(Producto, 'find', ECONNREFUSED_MONGO, fn, { sincrona: true }) }));
      titulo('RESULTADO');
      dato('checkout()', error ? `LANZÓ: ${error.message}` : 'NO lanzó');
      const despues = await leerEstado(ctx);
      imprimirEstado('DESPUÉS', despues);
      verificar(error && /ECONNREFUSED/.test(error.message), 'checkout() lanzó: sin Mongo no se puede verificar que el producto esté activo');
      verificar(JSON.stringify(despues.mysql) === JSON.stringify(antes.mysql), 'MySQL quedó idéntico: ni pedido ni stock descontado ni fila de outbox');
      verificar(despues.mongo.stock === antes.mongo.stock && despues.cassandra.producto === antes.cassandra.producto && despues.neo4j.producto === antes.neo4j.producto, 'ninguna otra base cambió');
      return 'checkout() lanzó; MySQL, Mongo, Cassandra y Neo4j sin ningún cambio (rechazo limpio)';
    },
  },

  'mongo-despues': {
    titulo: 'MongoDB cae justo DESPUÉS del commit',
    componente: 'MongoDB (copia de lectura del catálogo)',
    puntoDeFalla: 'el reenvío post-commit: Producto.updateOne({$inc: total_vendido, inventario.cantidad})',
    mitigacion: 'Ventana eventual ACEPTADA y documentada + reparación idempotente (recalcular-*)',
    categoria: 'Aceptación documentada de ventana de consistencia eventual (§2 fila 1; §3)',
    inyeccion: 'Producto.updateOne lanza ECONNREFUSED (solo durante checkout())',
    async correr(ctx, verificar) {
      const antes = await leerEstado(ctx);
      imprimirEstado('ANTES', antes);
      const { valor, error, registros } = await capturandoLogs(() => comprar(ctx, { alRodear: (fn) => conFalla(Producto, 'updateOne', ECONNREFUSED_MONGO, fn) }));
      titulo('RESULTADO');
      dato('checkout()', error ? `LANZÓ: ${error.message}` : `NO lanzó — compra #${valor.compra.id}, pago ${valor.pago.estado}`);
      for (const registro of registros) dato('el backend registra', registro);
      const ids = valor ? detallesDe(valor) : [];
      await apartarFilas(ids);
      const despues = await leerEstado(ctx, ids);
      imprimirEstado('INMEDIATAMENTE DESPUÉS', despues);
      await esperar(2000);
      const luego = await leerEstado(ctx, ids);
      dato('2 s después (Mongo "vuelve")', `stock Mongo=${luego.mongo.stock} vs MySQL=${luego.mysql.stock}: ${luego.mongo.stock === luego.mysql.stock ? 'se reparó solo' : 'SIGUE desfasado, no se autorepara'}`);
      titulo('MITIGACIÓN — la reparación documentada (la misma que dispara el administrador), acotada a este producto');
      const inventario = await catalogoSync.recalcularInventario({ productoIds: [ctx.productoId] });
      const ventas = await catalogoSync.recalcularVentas({ productoIds: [ctx.productoId] });
      dato('recalcularInventario()', JSON.stringify(inventario));
      dato('recalcularVentas()', JSON.stringify(ventas));
      const reparado = await leerEstado(ctx, ids);
      imprimirEstado('DESPUÉS DE REPARAR', reparado);
      await catalogoSync.recalcularInventario({ productoIds: [ctx.productoId] });
      await catalogoSync.recalcularVentas({ productoIds: [ctx.productoId] });
      const otraVez = await leerEstado(ctx, ids);
      await drenarOutbox(ids);
      verificar(!error && valor?.compra?.id, 'checkout() NO lanzó: la compra quedó confirmada en MySQL');
      verificar(registros.some((r) => /No se pudo actualizar total_vendido/.test(r)), 'el fallo quedó atrapado y registrado (console.error), sin revertir nada');
      verificar(despues.mysql.stock === antes.mysql.stock - 1 && despues.mongo.stock === antes.mongo.stock, `Mongo quedó DESFASADO: stock ${despues.mongo.stock} (real ${despues.mysql.stock}) y total_vendido ${despues.mongo.vendido} (real ${despues.mysql.vendido})`);
      verificar(luego.mongo.stock !== luego.mysql.stock, 'con Mongo de vuelta, el desfase PERSISTE: no se autorepara');
      verificar(despues.neo4j.estaVenta === 1, 'el fallo de Mongo no impidió los demás reenvíos (Neo4j sí recibió la compra)');
      verificar(reparado.mongo.stock === reparado.mysql.stock && reparado.mongo.vendido === reparado.mysql.vendido, 'recalcular-inventario/ventas devolvió Mongo a lo que dice MySQL');
      verificar(JSON.stringify(otraVez.mongo) === JSON.stringify(reparado.mongo), 'la reparación es idempotente: correrla otra vez no cambia nada');
      return `compra #${valor?.compra?.id} confirmada; Mongo stock ${despues.mongo.stock} vs MySQL ${despues.mysql.stock} (no se autorepara); reparado con recalcular-*`;
    },
  },

  redis: {
    titulo: 'Redis cae al invalidar la caché del carrito',
    componente: 'Redis (copia del carrito, TTL 450 s)',
    puntoDeFalla: 'cartService.invalidarCache(): el reenvío inmediato después del commit',
    mitigacion: 'Ventana eventual ACEPTADA: el TTL y la revisión al entrar al checkout la cierran',
    categoria: 'Aceptación documentada de ventana de consistencia eventual (§2 fila 2; §3)',
    inyeccion: 'redis.invalidarCarrito lanza ECONNREFUSED AL INSTANTE (un Redis realmente caído tarda en rendirse: ver §4 del documento)',
    async correr(ctx, verificar) {
      const compradorId = ctx.comprador.id_usuario;
      await conProductoActivo({ id: ctx.productoId }, async () => {
        await cartService.vaciar(compradorId);
        await cartService.agregar(compradorId, ctx.productoId, 1);
      });
      const antes = await leerEstado(ctx);
      imprimirEstado('ANTES (con 1 producto en el carrito)', antes);
      const redis = redisConfig.conectar('admin');
      const { valor, error, registros } = await capturandoLogs(() => comprar(ctx, { alRodear: (fn) => conFalla(redis, 'invalidarCarrito', 'connect ECONNREFUSED 127.0.0.1:16379 (falla simulada)', fn) }));
      titulo('RESULTADO');
      dato('checkout()', error ? `LANZÓ: ${error.message}` : `NO lanzó — compra #${valor.compra.id}, pago ${valor.pago.estado}`);
      for (const registro of registros) dato('el backend registra', registro);
      const ids = valor ? detallesDe(valor) : [];
      await apartarFilas(ids);
      const despues = await leerEstado(ctx, ids);
      imprimirEstado('DESPUÉS', despues);
      const rancio = await cartService.obtener(compradorId);
      dato('leer el carrito (caliente)', `devuelve ${rancio.items.length} producto(s) ya comprado(s): la copia de Redis quedó vieja`);
      const revisado = await cartService.revisar(compradorId);
      dato('revisar (al entrar al checkout)', `reconstruye desde SQL: ${revisado.items.length} producto(s)`);
      await cartService.vaciar(compradorId);
      await drenarOutbox(ids);
      verificar(!error && valor?.compra?.id, 'checkout() NO lanzó: la compra quedó confirmada');
      verificar(registros.some((r) => /caché del carrito/.test(r)), 'el fallo de Redis quedó atrapado y registrado');
      verificar(despues.mysql.carritoSql === 0, 'el carrito DURABLE (SQL) ya estaba vacío: se borra dentro de la transacción, no depende de Redis');
      verificar(!despues.redis.error && despues.redis.lineas === 1 && despues.redis.ttlSegundos <= 450, `la copia de Redis sigue con ${despues.redis.lineas} línea y vence sola (TTL ${despues.redis.ttlSegundos} s ≤ 450)`);
      verificar(rancio.items.length === 1, 'leer el carrito caliente devuelve el producto ya comprado (ventana visible)');
      verificar(revisado.items.length === 0, 'revisar() (lo que hace el checkout al entrar) converge de inmediato a lo que dice SQL');
      return `compra #${valor?.compra?.id} confirmada; carrito SQL vacío; la copia de Redis quedó con ${despues.redis.lineas} línea hasta su TTL (≤450 s) o hasta revisar()`;
    },
  },

  neo4j: {
    titulo: 'Neo4j cae al reenviar la compra al grafo de fraude',
    componente: 'Neo4j (grafo de detección de fraude)',
    puntoDeFalla: 'fraudeSyncService.registrarCompra(): reenvío post-commit con su propio try/catch',
    mitigacion: 'Mejor esfuerzo + reintento idempotente a demanda (MERGE por detalle_id: backfillNeo4j)',
    categoria: 'Reintento idempotente (manual) sobre una copia derivada (§3)',
    inyeccion: 'fraudeSyncService.registrarCompra lanza ServiceUnavailable',
    async correr(ctx, verificar) {
      const antes = await leerEstado(ctx);
      imprimirEstado('ANTES', antes);
      const { valor, error, registros } = await capturandoLogs(() => comprar(ctx, { alRodear: (fn) => conFalla(fraudeSync, 'registrarCompra', 'ServiceUnavailable: connect ECONNREFUSED 127.0.0.1:7687 (falla simulada)', fn) }));
      titulo('RESULTADO');
      dato('checkout()', error ? `LANZÓ: ${error.message}` : `NO lanzó — compra #${valor.compra.id}, pago ${valor.pago.estado}`);
      for (const registro of registros) dato('el backend registra', registro);
      const ids = valor ? detallesDe(valor) : [];
      await apartarFilas(ids);
      const despues = await leerEstado(ctx, ids);
      imprimirEstado('DESPUÉS', despues);
      titulo('MITIGACIÓN — reenviar la compra desde MySQL (lo que hace scripts/backfillNeo4j.js)');
      await reenviarCompraANeo4j(valor.compra.id);
      const reparado = await leerEstado(ctx, ids);
      dato('tras reenviar', `relaciones COMPRÓ de esta venta=${reparado.neo4j.estaVenta}`);
      await reenviarCompraANeo4j(valor.compra.id);
      const otraVez = await leerEstado(ctx, ids);
      dato('tras reenviar OTRA VEZ', `relaciones COMPRÓ de esta venta=${otraVez.neo4j.estaVenta}`);
      await drenarOutbox(ids);
      verificar(!error && valor?.compra?.id, 'checkout() NO lanzó: la compra quedó confirmada');
      verificar(registros.some((r) => /Neo4j/.test(r)), 'el fallo de Neo4j quedó atrapado y registrado');
      verificar(despues.neo4j.estaVenta === 0, 'el grafo NO tiene la compra (MySQL sí): ventana de detección de fraude abierta');
      verificar(despues.mongo.stock === despues.mysql.stock && despues.mongo.vendido === despues.mysql.vendido, 'el fallo de Neo4j no afectó el reenvío a Mongo');
      verificar(reparado.neo4j.estaVenta === 1, 'reenviar la compra desde MySQL puso la relación en el grafo');
      verificar(otraVez.neo4j.estaVenta === 1, 'reenviarla otra vez NO la duplica (MERGE por detalle_id): reintento idempotente');
      return `compra #${valor?.compra?.id} confirmada; el grafo quedó sin ella (0) hasta reenviarla desde MySQL (1, idempotente)`;
    },
  },

  cassandra: {
    titulo: 'Cassandra cae mientras el worker drena el outbox',
    componente: 'Cassandra (proyección analítica) vía MySQL venta_outbox',
    puntoDeFalla: 'ventasSyncService.procesarPendientes(): escribir las dos tablas de ventas',
    mitigacion: 'Outbox durable + reintentos con backoff e inserciones idempotentes',
    categoria: 'Reintentos idempotentes (§2 fila 4; ADR-004 §5)',
    inyeccion: 'cassandra.obtenerCliente rechaza durante un drenaje',
    async correr(ctx, verificar) {
      // Que la fila de la demo sea la única pendiente: la falla simulada solo se aplica a este proceso.
      await drenarOutbox([]);
      const antes = await leerEstado(ctx);
      imprimirEstado('ANTES', antes);
      const { valor, error } = await capturandoLogs(() => comprar(ctx));
      const ids = valor ? detallesDe(valor) : [];
      await apartarFilas(ids);
      titulo('RESULTADO');
      dato('checkout()', error ? `LANZÓ: ${error.message}` : `NO lanzó — compra #${valor.compra.id}: no dependió de Cassandra (la fila del outbox va en la misma transacción)`);
      const pendiente = await leerEstado(ctx, ids);
      imprimirEstado('DESPUÉS DE LA COMPRA (el outbox aún sin drenar)', pendiente);
      titulo('DRENAJE con Cassandra caída');
      const fallido = await conFalla(cassandraConfig, 'obtenerCliente', 'All host(s) tried for query failed (falla simulada)', () => ventasSync.procesarPendientes({ hasta: new Date(Date.now() + 2 * HORA_MS) }));
      const fila1 = await prisma.venta_outbox.findUnique({ where: { detalle_id: ids[0] } });
      dato('resumen del drenaje', JSON.stringify(fallido));
      dato('fila del outbox', `procesado_en=${fila1.procesado_en} | intentos=${fila1.intentos} | próximo intento en ${Math.round((fila1.proximo_intento - Date.now()) / 1000)} s (backoff)`);
      dato('último error', fila1.ultimo_error);
      const abierta = await leerEstado(ctx, ids);
      dato('filas en Cassandra', `${abierta.cassandra.estaVenta} (ventana abierta: la venta existe en MySQL, no aún en el panel)`);
      titulo('REINTENTO con Cassandra de vuelta');
      const reintento = await drenarOutbox(ids);
      const fila2 = await prisma.venta_outbox.findUnique({ where: { detalle_id: ids[0] } });
      dato('resumen del drenaje', JSON.stringify(reintento));
      dato('fila del outbox', `procesado_en=${fila2.procesado_en?.toISOString()} | intentos=${fila2.intentos} | último error=${fila2.ultimo_error}`);
      const recuperada = await leerEstado(ctx, ids);
      dato('filas en Cassandra', recuperada.cassandra.estaVenta);
      titulo('IDEMPOTENCIA — se reenvía a propósito LA MISMA venta');
      await prisma.venta_outbox.update({ where: { detalle_id: ids[0] }, data: { procesado_en: null, proximo_intento: new Date() } });
      await drenarOutbox(ids);
      const repetida = await leerEstado(ctx, ids);
      dato('filas en Cassandra', `${repetida.cassandra.estaVenta} (misma clave primaria: no se duplica)`);
      verificar(!error && valor?.compra?.id, 'checkout() NO lanzó: la venta se confirmó sin depender de Cassandra');
      verificar(pendiente.mysql.outboxPendiente === 1 && pendiente.cassandra.estaVenta === 0, 'justo tras el checkout el outbox tiene la venta pendiente y Cassandra aún no (ventana real)');
      verificar(fallido.fallidos >= 1 && fila1.procesado_en === null && fila1.intentos === 1 && fila1.proximo_intento > new Date() && /falla simulada/.test(fila1.ultimo_error), 'con Cassandra caída la fila queda pendiente: 1 intento, backoff programado y el error guardado');
      verificar(fila1.payload?.detalle_id === ids[0] && abierta.cassandra.estaVenta === 0, 'el payload sigue íntegro en MySQL: la venta no se perdió');
      verificar(fila2.procesado_en !== null && fila2.intentos === 2 && fila2.ultimo_error === null && recuperada.cassandra.estaVenta === 1, 'al volver Cassandra la fila se procesa sola y la venta llega a las tablas del panel');
      verificar(repetida.cassandra.estaVenta === 1, 'reenviar la misma venta NO la duplica: inserciones idempotentes por clave primaria');
      return `compra #${valor?.compra?.id}: con Cassandra caída el outbox conservó la venta (intento 1, backoff); al volver se escribió (1 fila) y reenviarla no la duplica`;
    },
  },
};

const ORDEN = ['mysql-dentro', 'mongo-antes', 'mongo-despues', 'redis', 'neo4j', 'cassandra'];

async function correrEscenario(clave, ctx) {
  const escenario = ESCENARIOS[clave];
  await alinearCopias(ctx, { reiniciarStock: true });
  console.log(`\n${'='.repeat(78)}`);
  console.log(`ESCENARIO ${clave} — ${escenario.titulo}`);
  console.log('='.repeat(78));
  dato('Componente', escenario.componente);
  dato('Punto de falla', escenario.puntoDeFalla);
  dato('Falla inyectada', escenario.inyeccion);
  dato('Mitigación adoptada', escenario.mitigacion);
  dato('Categoría', escenario.categoria);
  const verificaciones = [];
  const verificar = (condicion, texto) => verificaciones.push({ ok: Boolean(condicion), texto });
  let observado;
  try {
    observado = await escenario.correr(ctx, verificar);
  } catch (err) {
    verificar(false, `el escenario terminó con un error inesperado: ${err.message}`);
    observado = `ERROR INESPERADO: ${err.message}`;
  }
  titulo(`VERIFICACIONES — ${clave}`);
  for (const { ok, texto } of verificaciones) console.log(`  [${ok ? 'OK   ' : 'FALLO'}] ${texto}`);
  const aprobadas = verificaciones.filter((v) => v.ok).length;
  return { clave, escenario, observado, aprobadas, total: verificaciones.length, ok: aprobadas === verificaciones.length };
}

function imprimirTabla(resultados) {
  console.log(`\n${'='.repeat(78)}`);
  console.log('RESUMEN — componente, punto de falla, comportamiento observado y mitigación');
  console.log('='.repeat(78));
  for (const r of resultados) {
    console.log(`\n[${r.ok ? 'OK   ' : 'FALLO'}] ${r.clave}  (${r.aprobadas}/${r.total} verificaciones)`);
    dato('Componente', r.escenario.componente);
    dato('Punto de falla', r.escenario.puntoDeFalla);
    dato('Observado', r.observado);
    dato('Mitigación', r.escenario.mitigacion);
    dato('Categoría', r.escenario.categoria);
  }
  console.log(`\n${resultados.filter((r) => r.ok).length}/${resultados.length} escenarios con todas sus verificaciones en OK.`);
}

// ── Camino normal ───────────────────────────────────────────────────────────

async function caminoNormal(ctx) {
  const verificaciones = [];
  const verificar = (condicion, texto) => verificaciones.push({ ok: Boolean(condicion), texto });

  // Un producto en el carrito, para que se vea cómo la compra lo vacía en las dos copias.
  await conProductoActivo({ id: ctx.productoId }, async () => {
    await cartService.vaciar(ctx.comprador.id_usuario);
    await cartService.agregar(ctx.comprador.id_usuario, ctx.productoId, 1);
  });
  const antes = await leerEstado(ctx);
  imprimirEstado('ANTES de la compra (con 1 producto en el carrito)', antes);

  titulo('PASO 1 -- Verificación en MongoDB: el producto debe estar "activo"');
  console.log('checkout() consulta Producto.find(...) en MongoDB ANTES de abrir la transacción: si Mongo');
  console.log('falla o el producto no está activo, el checkout se rechaza ahí mismo, sin tocar MySQL');
  console.log('(falla cerrada; ver --falla=mongo-antes).');

  titulo('PASOS 2 a 4 -- Stock, precio e inventario: autoridad de MySQL');
  console.log('Dentro de UNA transacción de MySQL se comprueba que haya stock suficiente, se compara el');
  console.log('precio esperado con el vigente, se descuenta el inventario con un UPDATE condicional (por');
  console.log('eso nunca hay sobreventa), se escriben compra, compra_detalle y pago, se encola la venta en');
  console.log('el outbox y se vacía el carrito SQL. Todo confirma o todo se revierte (--falla=mysql-dentro).');

  titulo('EJECUTANDO checkoutService.checkout() -- la MISMA función que usa la API real');
  const { valor, error } = await capturandoLogs(() => comprar(ctx));
  if (error) throw error;
  const ids = detallesDe(valor);
  await apartarFilas(ids);
  console.log(`Compra #${valor.compra.id} creada, pago #${valor.pago.id} aprobado por Q${valor.pago.monto}.`);

  const despues = await leerEstado(ctx, ids);
  imprimirEstado('INMEDIATAMENTE DESPUÉS de checkout()', despues);

  titulo('REENVÍOS POSTERIORES AL COMMIT -- cada uno es una escritura a OTRA base, fuera de la transacción');
  console.log('  Redis      invalida la copia del carrito (mejor esfuerzo, TTL 450 s)          --falla=redis');
  console.log('  MongoDB    $inc de total_vendido y stock cacheado (mejor esfuerzo, sin reintento)  --falla=mongo-despues');
  console.log('  Neo4j      registra la compra en el grafo (mejor esfuerzo, MERGE idempotente)  --falla=neo4j');
  console.log('  Cassandra  NO se escribe aquí: la venta espera en el outbox (MySQL) a que el worker');
  console.log('             la drene, con reintentos idempotentes                                --falla=cassandra');
  console.log('Con todo arriba, los tres primeros ya están al día; solo Cassandra muestra su desfase:');
  console.log('la venta existe en MySQL y en el outbox, y todavía no en las tablas del panel.');

  titulo('DRENANDO EL OUTBOX HACIA CASSANDRA -- ventasSyncService.procesarPendientes()');
  const resumen = await drenarOutbox(ids);
  console.log(`Procesados: ${resumen.procesados}, fallidos: ${resumen.fallidos} (cuenta también cualquier otra venta pendiente).`);
  const final = await leerEstado(ctx, ids);
  imprimirEstado('DESPUÉS de drenar el outbox', final);

  verificar(antes.redis.lineas === 1 && despues.redis.lineas === 0 && despues.mysql.carritoSql === 0, 'el carrito se vació en SQL (dentro de la transacción) y en Redis (invalidación)');
  verificar(despues.mysql.stock === antes.mysql.stock - 1 && despues.mongo.stock === despues.mysql.stock && despues.mongo.vendido === despues.mysql.vendido, 'MySQL y la copia de Mongo coinciden tras la compra');
  verificar(despues.neo4j.estaVenta === 1, 'la compra llegó al grafo de Neo4j');
  verificar(despues.mysql.outboxPendiente === 1 && despues.cassandra.estaVenta === 0, 'ventana real hacia Cassandra: la venta está en el outbox y aún no en el panel');
  verificar(final.mysql.outboxPendiente === 0 && final.cassandra.estaVenta === 1, 'tras drenar el outbox la venta llegó a Cassandra');

  titulo('RESUMEN');
  console.log('MySQL es la autoridad del stock y el precio: nada se escribe en Mongo, Redis ni Neo4j');
  console.log('antes de que MySQL confirme la compra, y el stock se descuenta con un UPDATE condicional,');
  console.log('así que no hay sobreventa. Lo que puede desfasarse es lo que viaja DESPUÉS del commit:');
  console.log('las copias de Redis, Mongo y Neo4j (mejor esfuerzo, sin cola) y la de Cassandra (durable,');
  console.log('con outbox). Para verlo fallar: node scripts/demo_consistencia_compra.js --falla=todas');
  titulo('VERIFICACIONES -- camino normal');
  for (const { ok, texto } of verificaciones) console.log(`  [${ok ? 'OK   ' : 'FALLO'}] ${texto}`);
  return verificaciones.every((v) => v.ok);
}

// ── Programa principal ──────────────────────────────────────────────────────

function leerModo() {
  const args = process.argv.slice(2);
  if (args.includes('--ayuda') || args.includes('--help')) return { ayuda: true };
  const indice = args.findIndex((a) => a === '--falla' || a.startsWith('--falla='));
  if (indice === -1) return { modo: null };
  const modo = args[indice].includes('=') ? args[indice].split('=')[1] : args[indice + 1];
  if (modo !== 'todas' && !ESCENARIOS[modo]) return { error: `Escenario desconocido: "${modo ?? ''}". Opciones: ${ORDEN.join(' | ')} | todas` };
  return { modo };
}

async function main() {
  const { modo, ayuda, error } = leerModo();
  if (ayuda || error) {
    if (error) console.error(error);
    console.log('Uso: node scripts/demo_consistencia_compra.js [--falla=<escenario>|todas]');
    console.log(`Escenarios: ${ORDEN.join(' | ')}`);
    process.exitCode = error ? 1 : 0;
    return;
  }
  if (['false', '0'].includes((process.env.VENTAS_OUTBOX_ENABLED || 'true').toLowerCase())) {
    throw new Error('VENTAS_OUTBOX_ENABLED está apagado: sin la captura del outbox no hay venta que drenar hacia Cassandra. Quitá esa variable o ponela en true.');
  }

  console.log('Preparando datos base (cuentas y producto de demostración)...');
  const ctx = await prepararDatos();
  console.log(`Comprador #${ctx.comprador.id_usuario}, vendedor #${ctx.vendedor.id_usuario}, producto #${ctx.productoId} a Q${PRECIO_DEMO} (stock de partida ${STOCK_DEMO}).`);

  if (modo === null) {
    const bien = await caminoNormal(ctx);
    if (!bien) process.exitCode = 1;
    return;
  }
  const claves = modo === 'todas' ? ORDEN : [modo];
  const resultados = [];
  for (const clave of claves) resultados.push(await correrEscenario(clave, ctx));
  if (claves.length > 1) imprimirTabla(resultados);
  if (resultados.some((r) => !r.ok)) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('Error en la demo:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Todas las conexiones, o el proceso se queda colgado después de terminar.
    await prisma.$disconnect();
    await mongoose.disconnect().catch(() => {});
    await neo4j.cerrar().catch(() => {});
    await cassandraConfig.cerrar().catch(() => {});
    redisConfig.cerrar();
  });
