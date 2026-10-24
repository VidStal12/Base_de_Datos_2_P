require('dotenv').config();
const mongoose = require('mongoose');
const prisma = require('../src/config/prisma');
const redisConfig = require('../src/config/redis');
// productoService.obtener() hace populate() hasta Categoria (ver verificarOfertaFlash.js).
require('../src/models/mongo/Categoria');
const { conectar: conectarMongo } = require('../src/config/mongo');
const { checkout } = require('../src/services/checkoutService');
const compromisoService = require('../src/services/compromisoService');
const ofertaFlashService = require('../src/services/ofertaFlashService');
const tendenciaService = require('../src/services/tendenciaService');
const { afirmar, prepararCuenta } = require('./lib/datosPrueba');

// Evidencia del compromiso de no reventa (ver compromisoService.js y
// IA/PLAN-NEO4J-DETECCION-FRAUDE.md §19): una cuenta que puede vender no compra sin
// haberlo aceptado, en NINGÚN camino de compra, y el rechazo no deja rastro. Solo
// hay rechazos y lecturas, así que se puede correr las veces que se quiera. La
// parte positiva (la aceptación queda guardada en el pedido) la cubren
// `verificar:fraude` (checkout) y las pruebas aisladas (`npm run test:compromiso`,
// `test:redis`).
const CODIGO = 'COMPROMISO_NO_REVENTA';

async function esperarRechazo(nombre, accion) {
  try {
    await accion();
  } catch (err) {
    afirmar(err.status === 400 && err.codigo === CODIGO, `${nombre}: se esperaba 400 ${CODIGO}, llegó ${err.status ?? 'sin status'} "${err.message}"`);
    console.log(`  OK — ${nombre}: 400 ${err.codigo}`);
    return;
  }
  throw new Error(`FALLO: ${nombre}: se permitió comprar sin aceptar el compromiso`);
}

async function main() {
  await conectarMongo();
  const redis = redisConfig.conectar('admin');
  const comprador = await prisma.usuarios.findFirst({ where: { correo: 'ana.gomez@example.com' } });
  const vendedor = await prisma.usuarios.findFirst({ where: { correo: 'luis.ramirez@example.com' } });
  const admin = await prisma.usuarios.findFirst({ where: { correo: 'admin.fraude.check@example.com' } });
  afirmar(comprador && vendedor && admin, 'faltan las cuentas de prueba (npm run seed y verificar:fraude)');
  const revendedor = await prepararCuenta('fraude.revendedor@example.com', 'Fraude Revendedor', 'tok_fraude_revendedor', { rol: 'vendedor', nacimiento: '1991-08-08' });

  // 1) Quién tiene que aceptar: el rol sale de MySQL, no de lo que mande el cliente.
  const sin = async (usuario, valor) => (await compromisoService.exigirCompromiso(usuario.id_usuario, valor)).requerido;
  afirmar((await sin(comprador, undefined)) === false, 'un comprador no tiene que aceptar nada');
  await esperarRechazo('vendedor sin aceptar (campo ausente)', () => compromisoService.exigirCompromiso(vendedor.id_usuario, undefined));
  await esperarRechazo('administrador sin aceptar', () => compromisoService.exigirCompromiso(admin.id_usuario, undefined));
  await esperarRechazo('vendedor con "true" como texto', () => compromisoService.exigirCompromiso(vendedor.id_usuario, 'true'));
  const aceptado = await compromisoService.exigirCompromiso(vendedor.id_usuario, true);
  afirmar(aceptado.requerido && aceptado.aceptadoEn instanceof Date, 'con la aceptación explícita, la constancia es el instante');
  console.log('  OK — matriz de roles: comprador no, vendedor y administrador sí; solo el booleano true cuenta.');

  // 2) Cada camino de compra lo exige, y el rechazo no deja rastro.
  const datos = { direccionId: revendedor.direccion.id, metodoPagoId: revendedor.metodoPago.id };
  const pedidosAntes = await prisma.compra.count({ where: { id_usuario: revendedor.usuario.id_usuario } });
  await esperarRechazo('checkout() de un vendedor', () =>
    checkout({ usuarioId: revendedor.usuario.id_usuario, ...datos, items: [{ productoId: 4, cantidad: 1 }] })
  );
  afirmar((await prisma.compra.count({ where: { id_usuario: revendedor.usuario.id_usuario } })) === pedidosAntes, 'el rechazo del checkout no debe dejar ningún pedido');

  const claveOferta = 'oferta:1:stock';
  const cupoAntes = await redis.get(claveOferta);
  await esperarRechazo('oferta flash de un vendedor', () => ofertaFlashService.comprar(revendedor.usuario.id_usuario, 1, { cantidad: 1, ...datos }));
  afirmar((await redis.get(claveOferta)) === cupoAntes, 'el rechazo de la oferta flash no debe gastar cupo en Redis');

  const claveCupo = `oferta-recomendada:12:${vendedor.id_usuario}:stock`;
  const cupoPersonalAntes = await redis.get(claveCupo);
  await esperarRechazo('recomendación de un vendedor', () =>
    tendenciaService.comprar(vendedor.id_usuario, 12, { cantidad: 1, direccionId: 1, metodoPagoId: 1 })
  );
  afirmar((await redis.get(claveCupo)) === cupoPersonalAntes, 'el rechazo de la recomendación no debe gastar el cupo personal');

  console.log('Todas las verificaciones del compromiso de no reventa pasaron.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await mongoose.disconnect();
    redisConfig.cerrar();
  });
