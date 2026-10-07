// ============================================================
// TiendaYa — Demo: qué pasa cuando hay una compra, y cómo se maneja la
// consistencia entre las bases de datos (ver "Estrategia de consistencia
// para flujo de Checkout" en el informe).
//
// Llama a checkoutService.checkout(), la MISMA función que usa la API real,
// y consulta cada base antes/después para mostrar el estado real. Crea sus
// propias cuentas y producto de prueba (marcados como "Demo").
//
// Complementa a intentarCheckoutReal.js: ese prueba qué pasa cuando una base
// está deliberadamente caída (ver IA/ENTREGA-3-CONSISTENCIA.md §5); este
// muestra el camino normal, con todo arriba, y el desfase temporal real
// hacia Cassandra mientras el outbox no se ha drenado.
//
// Requiere VENTAS_OUTBOX_ENABLED=true y VENTAS_SYNC_ENABLED=true en .env.
// Uso (desde la carpeta backend/, con el docker-compose arriba):
//   node scripts/demo_consistencia_compra.js
// ============================================================

require('dotenv').config();
const prisma = require('../src/config/prisma');
const { conectar: conectarMongo } = require('../src/config/mongo');
const Producto = require('../src/models/mongo/Producto');
const neo4j = require('../src/config/neo4j');
const cassandraConfig = require('../src/config/cassandra');
const { conectar: conectarRedis } = require('../src/config/redis');
const checkoutService = require('../src/services/checkoutService');
const ventasSync = require('../src/services/ventasSyncService');

const CORREO_DEMO_VENDEDOR = 'demo.vendedor@tiendaya.com';
const CORREO_DEMO_COMPRADOR = 'demo.comprador@tiendaya.com';
const DESCRIPCION_DEMO = 'PRODUCTO DEMO - consistencia entre bases';

function linea() { console.log('-'.repeat(70)); }
function titulo(texto) { linea(); console.log(texto); linea(); }

async function obtenerORol(tipoRol) {
  let rol = await prisma.rol_usuario.findFirst({ where: { tipo_rol: tipoRol } });
  if (!rol) rol = await prisma.rol_usuario.create({ data: { tipo_rol: tipoRol } });
  return rol;
}

async function prepararDatos() {
  const rolComprador = await obtenerORol('comprador');
  const rolVendedor = await obtenerORol('vendedor');

  const vendedor = await prisma.usuarios.upsert({
    where: { correo: CORREO_DEMO_VENDEDOR },
    update: {},
    create: { rol_id: rolVendedor.id, nombres: 'Vendedora', apellidos: 'Demo', correo: CORREO_DEMO_VENDEDOR, contrasena: 'x', fecha_nacimiento: new Date('1990-01-01') },
  });
  const comprador = await prisma.usuarios.upsert({
    where: { correo: CORREO_DEMO_COMPRADOR },
    update: {},
    create: { rol_id: rolComprador.id, nombres: 'Comprador', apellidos: 'Demo', correo: CORREO_DEMO_COMPRADOR, contrasena: 'x', fecha_nacimiento: new Date('1990-01-01') },
  });

  let direccion = await prisma.direcciones.findFirst({ where: { id_usuario: comprador.id_usuario } });
  if (!direccion) {
    direccion = await prisma.direcciones.create({ data: { id_usuario: comprador.id_usuario, pais: 'Guatemala', direccion: 'Direccion demo', codigo_postal: '01010' } });
  }

  let metodoPago = await prisma.metodo_pago.findFirst({ where: { id_usuario: comprador.id_usuario } });
  if (!metodoPago) {
    metodoPago = await prisma.metodo_pago.create({ data: { id_usuario: comprador.id_usuario, titular: 'Comprador Demo', token_pasarela: 'tok_demo', ultimos_4_digitos: '0000', marca: 'Demo' } });
  }

  await conectarMongo();
  let productoId;
  const docExistente = await Producto.findOne({ descripcion: DESCRIPCION_DEMO, vendedor_id: vendedor.id_usuario }).select('producto_id').lean();
  if (docExistente) {
    productoId = docExistente.producto_id;
    await prisma.inventario.update({ where: { id_producto: productoId }, data: { cantidad: 10 } });
  } else {
    const producto = await prisma.producto.create({ data: { id_vendedor: vendedor.id_usuario } });
    await prisma.inventario.create({ data: { id_producto: producto.id, precio: 100, cantidad: 10 } });
    productoId = producto.id;
  }
  const inventario = await prisma.inventario.findUnique({ where: { id_producto: productoId } });

  await Producto.findOneAndUpdate(
    { producto_id: productoId },
    {
      producto_id: productoId, descripcion: DESCRIPCION_DEMO, estado: 'activo',
      vendedor_id: vendedor.id_usuario, vendedor_nombre: `${vendedor.nombres} ${vendedor.apellidos}`,
      inventario: { precio: Number(inventario.precio), cantidad: inventario.cantidad },
      total_vendido: 0,
    },
    { upsert: true, setDefaultsOnInsert: true }
  );

  return { comprador, vendedor, direccion, metodoPago, productoId, precio: Number(inventario.precio) };
}

async function snapshot(etiqueta, productoId, compradorId) {
  titulo(`ESTADO ${etiqueta} (producto #${productoId})`);

  const inv = await prisma.inventario.findUnique({ where: { id_producto: productoId } });
  console.log(`MySQL      inventario.cantidad       = ${inv.cantidad}`);

  const pendientesOutbox = await prisma.venta_outbox.count({ where: { procesado_en: null } });
  console.log(`MySQL      venta_outbox pendientes    = ${pendientesOutbox}`);

  await conectarMongo();
  const doc = await Producto.findOne({ producto_id: productoId }).select('inventario total_vendido').lean();
  console.log(`Mongo      inventario.cantidad       = ${doc.inventario.cantidad}, total_vendido = ${doc.total_vendido}`);

  try {
    const redis = await conectarRedis();
    const existeCarrito = await redis.exists(`carrito:${compradorId}:revision`);
    console.log(`Redis      carrito:${compradorId}:revision existe = ${existeCarrito === 1}`);
  } catch (err) {
    console.log(`Redis      no se pudo consultar: ${err.message}`);
  }

  try {
    const cliente = await cassandraConfig.obtenerCliente();
    const resultado = await cliente.execute(
      'SELECT cantidad FROM ventas_por_producto_mes WHERE producto_id = ? ALLOW FILTERING',
      [productoId], { prepare: true }
    );
    console.log(`Cassandra  filas de venta de este producto = ${resultado.rowLength}`);
  } catch (err) {
    console.log(`Cassandra  no se pudo consultar: ${err.message}`);
  }

  try {
    const registros = await neo4j.leer(
      'MATCH ()-[c:COMPRÓ]->(p:Producto {producto_id: $productoId}) RETURN count(c) AS total',
      { productoId }
    );
    console.log(`Neo4j      relaciones COMPRÓ hacia este producto = ${registros[0].get('total').toNumber()}`);
  } catch (err) {
    console.log(`Neo4j      no se pudo consultar: ${err.message}`);
  }
}

async function main() {
  console.log('Preparando datos base (cuentas y producto de demostración)...');
  const { comprador, vendedor, direccion, metodoPago, productoId, precio } = await prepararDatos();
  console.log(`Comprador #${comprador.id_usuario}, vendedor #${vendedor.id_usuario}, producto #${productoId} a Q${precio}`);

  await snapshot('ANTES de la compra', productoId, comprador.id_usuario);

  titulo('PASO 1 -- Verificacion en MongoDB: el producto debe estar "activo"');
  console.log('checkout() consulta Producto.find(...) en MongoDB antes de tocar MySQL. Si MongoDB');
  console.log('falla o el producto no esta activo, el checkout se interrumpe aqui mismo.');

  titulo('PASOS 2 a 4 -- Stock, precio e inventario: autoridad de MySQL');
  console.log('Dentro de la transaccion de MySQL: se comprueba que haya stock suficiente, se compara');
  console.log('el precio esperado contra el precio vigente, se reduce el stock del inventario y se');
  console.log('escriben los datos de la compra (compra, compra_detalle, pago). MySQL es la fuente de');
  console.log('informacion para el stock y el precio: todo esto se confirma en MySQL ANTES de que se');
  console.log('escriba cualquier otro dato en MongoDB o Redis, por eso nunca se produce sobreventa.');

  titulo('EJECUTANDO checkoutService.checkout() -- la MISMA funcion que usa la API real');
  const { compra, pago } = await checkoutService.checkout({
    usuarioId: comprador.id_usuario,
    direccionId: direccion.id,
    metodoPagoId: metodoPago.id,
    items: [{ productoId, cantidad: 1, precioEsperado: precio }],
  });
  console.log(`Compra #${compra.id} creada, pago #${pago.id} aprobado por Q${pago.monto}.`);

  await snapshot('INMEDIATAMENTE DESPUES de checkout()', productoId, comprador.id_usuario);

  titulo('PUNTO DE DESINCRONIZACION -- total_vendido (y el stock cacheado) en MongoDB');
  console.log('Con la compra ya confirmada en MySQL, checkout() intenta actualizar total_vendido y');
  console.log('la cantidad cacheada del producto en MongoDB. Esta llamada NO tiene ningun mecanismo');
  console.log('de reintento: si Mongo falla justo en este instante, total_vendido se queda atras y');
  console.log('no refleja la cantidad real vendida, hasta que algo lo recalcule mas adelante.');

  titulo('DRENANDO EL OUTBOX HACIA CASSANDRA -- ventasSyncService.procesarPendientes()');
  const resumen = await ventasSync.procesarPendientes({ hasta: new Date() });
  console.log(`Procesados: ${resumen.procesados}, fallidos: ${resumen.fallidos}`);

  await snapshot('DESPUES de drenar el outbox', productoId, comprador.id_usuario);

  titulo('RESUMEN');
  console.log('MySQL es la autoridad del stock y el precio: nada se escribe en Mongo o Redis antes de');
  console.log('que MySQL confirme la compra, lo que evita la sobreventa. Lo que si puede desincronizarse');
  console.log('es la copia de lectura en MongoDB (total_vendido y el stock cacheado), porque su reenvio');
  console.log('despues del commit no tiene reintento automatico.');
}

main()
  .catch((err) => {
    console.error('Error en la demo:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await cassandraConfig.cerrar();
    try {
      const redis = await conectarRedis();
      await redis.quit();
    } catch { /* ya pudo estar cerrado */ }
  });