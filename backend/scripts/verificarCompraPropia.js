require('dotenv').config();
const mongoose = require('mongoose');
const prisma = require('../src/config/prisma');
const redis = require('../src/config/redis');
// Igual que verificarCarrito.js: productoService.obtener() hace populate() de
// subcategoria_id -> categoria_id, y Mongoose necesita el modelo Categoria
// registrado en el proceso para eso.
require('../src/models/mongo/Categoria');
const Producto = require('../src/models/mongo/Producto');
const { conectar: conectarMongo } = require('../src/config/mongo');
const { checkout } = require('../src/services/checkoutService');
const cartService = require('../src/services/cartService');
const ofertaFlashService = require('../src/services/ofertaFlashService');
const tendenciaService = require('../src/services/tendenciaService');
const productoService = require('../src/services/productoService');

// Evidencia de la regla "nadie compra lo que él mismo vende" (ver
// productoService.verificarNoEsPropio y PLAN-NEO4J-DETECCION-FRAUDE.md §18):
// un vendedor que se compra a sí mismo infla sus ventas sin que haya un
// cliente real. Prueba CADA camino de compra — carrito, checkout normal, oferta
// flash y recomendación — y que el rechazo no deja rastro: ni pedido, ni stock
// descontado, ni cupo gastado en Redis. Todo son rechazos, así que no escribe
// nada y se puede correr las veces que se quiera.

function afirmar(condicion, mensaje) {
  if (!condicion) throw new Error(`FALLO: ${mensaje}`);
}

// Pasa si `accion` lanza un error 403 cuyo mensaje habla de productos propios.
async function esperarRechazo(nombre, accion) {
  try {
    await accion();
  } catch (err) {
    afirmar(err.status === 403, `${nombre}: se esperaba un 403, llegó ${err.status ?? 'sin status'} ("${err.message}")`);
    afirmar(/propios productos/i.test(err.message), `${nombre}: el rechazo no menciona que el producto es propio ("${err.message}")`);
    console.log(`  OK — ${nombre}: 403 "${err.message}"`);
    return;
  }
  throw new Error(`FALLO: ${nombre}: se permitió una compra de un producto propio`);
}

const inventarioDe = async (productoId) => (await prisma.inventario.findUnique({ where: { id_producto: productoId } })).cantidad;
const pedidosDe = (usuarioId) => prisma.compra.count({ where: { id_usuario: usuarioId } });

async function main() {
  await conectarMongo();
  const dueno = await prisma.usuarios.findFirst({ where: { correo: 'luis.ramirez@example.com' }, include: { direcciones: true, metodos_pago: true } });
  const ajeno = await prisma.usuarios.findFirst({ where: { correo: 'ana.gomez@example.com' } });
  afirmar(dueno && ajeno, 'faltan las cuentas de prueba (npm run seed)');

  const propio = await prisma.producto.findFirst({ where: { id_vendedor: dueno.id_usuario, inventario: { cantidad: { gte: 2 } } } });
  const deOtro = await prisma.producto.findFirst({ where: { id_vendedor: { not: dueno.id_usuario }, inventario: { cantidad: { gte: 2 } } } });
  afirmar(propio && deOtro, 'hacen falta un producto del vendedor de prueba y uno de otro vendedor, con stock');
  console.log(`Dueño: ${dueno.correo} (#${dueno.id_usuario}) · producto propio #${propio.id} · producto ajeno #${deOtro.id} (de #${deOtro.id_vendedor})`);

  // direccionId/metodoPagoId: la regla se verifica ANTES de validar eso, así que
  // no hace falta que existan — si el rechazo fuera por otro motivo, el mensaje
  // no mencionaría los productos propios y esperarRechazo fallaría.
  const datosCompra = { direccionId: 1, metodoPagoId: 1 };

  // 1) Checkout normal.
  const pedidosAntes = await pedidosDe(dueno.id_usuario);
  const stockPropioAntes = await inventarioDe(propio.id);
  const stockAjenoAntes = await inventarioDe(deOtro.id);
  await esperarRechazo('checkout() de un producto propio', () =>
    checkout({ usuarioId: dueno.id_usuario, ...datosCompra, items: [{ productoId: propio.id, cantidad: 1 }] })
  );
  await esperarRechazo('checkout() con UN producto propio mezclado entre otros', () =>
    checkout({
      usuarioId: dueno.id_usuario,
      ...datosCompra,
      items: [{ productoId: deOtro.id, cantidad: 1 }, { productoId: propio.id, cantidad: 1 }],
    })
  );
  afirmar((await pedidosDe(dueno.id_usuario)) === pedidosAntes, 'el rechazo no debe dejar ningún pedido');
  afirmar((await inventarioDe(propio.id)) === stockPropioAntes, 'el rechazo no debe descontar stock del producto propio');
  afirmar((await inventarioDe(deOtro.id)) === stockAjenoAntes, 'un pedido mixto rechazado debe ser atómico: el producto ajeno tampoco se descuenta');

  // 2) Carrito: nunca debe llegar a contener algo que el checkout va a rechazar.
  await esperarRechazo('carrito: agregar un producto propio', () => cartService.agregar(dueno.id_usuario, propio.id, 1));
  await esperarRechazo('carrito: fijar la cantidad de un producto propio', () => cartService.actualizarCantidad(dueno.id_usuario, propio.id, 2));
  afirmar(
    (await prisma.carrito.count({ where: { id_usuario: dueno.id_usuario, id_producto: propio.id } })) === 0,
    'el producto propio no debe quedar en el carrito'
  );

  // 3) Oferta flash: se rechaza ANTES de tocar Redis — el dueño no gasta (ni hay
  // que devolverle) una unidad del pool.
  const claveOferta = `oferta:${propio.id}:stock`;
  const poolAntes = await redis.conectar().get(claveOferta);
  await esperarRechazo('oferta flash de un producto propio', () =>
    ofertaFlashService.comprar(dueno.id_usuario, propio.id, { cantidad: 1, ...datosCompra })
  );
  afirmar((await redis.conectar().get(claveOferta)) === poolAntes, 'el rechazo no debe tocar el pool de la oferta en Redis');

  // 4) Recomendación: rechazo antes del cupo personal, y nunca se la recomienda.
  const claveCupo = `oferta-recomendada:${propio.id}:${dueno.id_usuario}:stock`;
  const cupoAntes = await redis.conectar().get(claveCupo);
  await esperarRechazo('recomendación de un producto propio', () =>
    tendenciaService.comprar(dueno.id_usuario, propio.id, { cantidad: 1, ...datosCompra })
  );
  afirmar((await redis.conectar().get(claveCupo)) === cupoAntes, 'el rechazo no debe tocar el cupo personal en Redis');
  await redis.conectar().del(`recomendaciones:${dueno.id_usuario}`); // sin caché previa a la regla
  const { productos: recomendados } = await tendenciaService.recomendar(dueno.id_usuario);
  afirmar(
    recomendados.every((p) => p.vendedor_id !== dueno.id_usuario),
    'las recomendaciones de una cuenta no deben incluir sus propios productos'
  );
  console.log(`  OK — recomendar(): ${recomendados.length} producto(s), ninguno del propio usuario.`);

  // Controles: la regla bloquea al dueño y a nadie más.
  await productoService.verificarNoEsPropio(ajeno.id_usuario, [propio.id]); // otro usuario sí puede
  await productoService.verificarNoEsPropio(dueno.id_usuario, [deOtro.id]); // y el dueño sí puede comprar lo ajeno
  console.log('  OK — controles: otro usuario sí puede comprar ese producto, y el dueño sí puede comprar productos de otros.');

  console.log('Todas las verificaciones de compra propia pasaron.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await mongoose.disconnect();
    redis.cerrar();
  });
