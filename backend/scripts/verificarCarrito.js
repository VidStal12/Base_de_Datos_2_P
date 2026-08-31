require('dotenv').config();
const mongoose = require('mongoose');
const prisma = require('../src/config/prisma');
const { conectar: conectarRedis } = require('../src/config/redis');
// Nunca se usa directo acá, pero productoService.obtener() (llamado por
// cartService) hace populate() de subcategoria_id -> categoria_id, y
// Mongoose necesita el modelo Categoria registrado en el proceso para eso —
// en la app real ya pasa como efecto colateral de cargar categoriaService.js,
// un script aislado tiene que pedirlo explícitamente.
require('../src/models/mongo/Categoria');
const cartService = require('../src/services/cartService');
const { checkout } = require('../src/services/checkoutService');

// Evidencia de funcionamiento del carrito en Redis (PRD Entrega 2, ver
// IA/ENTREGA-2-PLAN.md §4.1):
// 1) Agregar setea el hash + TTL de 7.5 min.
// 2) El TTL se reinicia en cada interacción (por inactividad, no fijo).
// 3) Agregar clampa contra el stock vigente, no lo excede.
// 4) Quitar el último ítem borra la clave entera (comportamiento nativo de
//    Redis sobre hashes vacíos).
// 5) Un checkout exitoso vacía el carrito del lado del servidor — no depende
//    de que el cliente haga una segunda llamada aparte.
async function main() {
  const usuario = await prisma.usuarios.findFirst({
    where: { correo: 'ana.gomez@example.com' },
    include: { direcciones: true, metodos_pago: true },
  });
  const producto = await prisma.producto.findUnique({ where: { id: 1 }, include: { inventario: true } });

  if (!usuario || !producto || usuario.direcciones.length === 0 || usuario.metodos_pago.length === 0) {
    throw new Error('No hay datos de prueba. Corré "npm run seed" primero.');
  }

  const redis = conectarRedis();
  const clave = `carrito:${usuario.id_usuario}`;
  await redis.del(clave); // estado limpio, por si quedó algo de una corrida anterior

  // 1) Agregar setea el hash + TTL.
  await cartService.agregar(usuario.id_usuario, producto.id, 2);
  const ttlInicial = await redis.ttl(clave);
  const campo = await redis.hget(clave, String(producto.id));
  console.log(`Agregado: producto ${producto.id} x${campo}, TTL inicial: ${ttlInicial}s (esperado ~${cartService.TTL_SEGUNDOS}s)`);
  if (campo !== '2' || ttlInicial <= 0 || ttlInicial > cartService.TTL_SEGUNDOS) {
    throw new Error('FALLO: el hash o el TTL no quedaron como se esperaba tras agregar');
  }

  // 2) El TTL se reinicia en cada interacción, no solo al crear la clave.
  await new Promise((r) => setTimeout(r, 1200));
  const ttlAntesDeInteractuar = await redis.ttl(clave);
  await cartService.obtener(usuario.id_usuario); // una simple lectura ya cuenta como actividad
  const ttlDespuesDeInteractuar = await redis.ttl(clave);
  console.log(`TTL antes de leer de nuevo: ${ttlAntesDeInteractuar}s, después: ${ttlDespuesDeInteractuar}s`);
  if (ttlDespuesDeInteractuar <= ttlAntesDeInteractuar) {
    throw new Error('FALLO: el TTL no se reinició al interactuar con el carrito (expiración por inactividad rota)');
  }

  // 3) Agregar clampa contra el stock vigente — no lo excede aunque se pida de más.
  const stockReal = producto.inventario.cantidad;
  await cartService.agregar(usuario.id_usuario, producto.id, 999999);
  const campoTrasClamp = await redis.hget(clave, String(producto.id));
  console.log(`Tras pedir 999999 de más, cantidad en el carrito: ${campoTrasClamp} (stock real: ${stockReal})`);
  if (Number(campoTrasClamp) !== stockReal) {
    throw new Error('FALLO: el carrito superó el stock disponible — no está clampando');
  }

  // 4) Quitar el último ítem borra la clave entera.
  await cartService.quitar(usuario.id_usuario, producto.id);
  const existeTrasQuitar = await redis.exists(clave);
  console.log(`Clave existe tras quitar el único ítem: ${Boolean(existeTrasQuitar)} (esperado: false)`);
  if (existeTrasQuitar) {
    throw new Error('FALLO: la clave debería haber desaparecido al quedar el hash vacío');
  }

  // 5) Un checkout exitoso vacía el carrito del lado del servidor, sin que el
  // cliente tenga que pedirlo aparte — ver checkoutService.js.
  await cartService.agregar(usuario.id_usuario, producto.id, 1);
  const existeAntesDeCheckout = await redis.exists(clave);
  await checkout({
    usuarioId: usuario.id_usuario,
    direccionId: usuario.direcciones[0].id,
    metodoPagoId: usuario.metodos_pago[0].id,
    items: [{ productoId: producto.id, cantidad: 1 }],
  });
  const existeDespuesDeCheckout = await redis.exists(clave);
  console.log(
    `Carrito antes del checkout: ${Boolean(existeAntesDeCheckout)}, después: ${Boolean(existeDespuesDeCheckout)} (esperado: true, false)`
  );
  if (!existeAntesDeCheckout || existeDespuesDeCheckout) {
    throw new Error('FALLO: el checkout no vació el carrito en Redis');
  }

  console.log('Todas las verificaciones del carrito pasaron.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await mongoose.disconnect();
    conectarRedis().disconnect();
  });
