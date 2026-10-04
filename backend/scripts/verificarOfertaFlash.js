require('dotenv').config();
const mongoose = require('mongoose');
const prisma = require('../src/config/prisma');
const { conectar: conectarRedis } = require('../src/config/redis');
// Igual que verificarCarrito.js: productoService.obtener() hace populate() de
// subcategoria_id -> categoria_id, y Mongoose necesita el modelo Categoria
// registrado en el proceso para eso — un script aislado tiene que pedirlo
// explícitamente.
require('../src/models/mongo/Categoria');
const { conectar: conectarMongo } = require('../src/config/mongo');
const Producto = require('../src/models/mongo/Producto');
const ofertaFlashService = require('../src/services/ofertaFlashService');
const ofertaDatos = require('../src/services/ofertaDatosService');
const neo4j = require('../src/config/neo4j');

// Evidencia de funcionamiento de la oferta flash bajo concurrencia (PRD
// Entrega 2, el ítem de mayor peso — ver IA/ENTREGA-2-PLAN.md §4.2): dispara
// más intentos de compra simultáneos que unidades disponibles y verifica que
// gane exactamente el stock inicial, el resto se rechace, y el contador en
// Redis termine en exactamente 0 — la prueba de que la guardia 1 (script Lua,
// EVAL atómico) resuelve la carrera sin locks de aplicación. También confirma
// que la guardia 2 (MySQL) descontó inventario REAL, no solo el contador de
// Redis.
const STOCK_OFERTA = 5;
const INTENTOS_CONCURRENTES = 15; // más que STOCK_OFERTA a propósito

async function main() {
  const usuario = await prisma.usuarios.findFirst({
    where: { correo: 'ana.gomez@example.com' },
    include: { direcciones: true, metodos_pago: true },
  });
  const productoRelacional = await prisma.producto.findUnique({ where: { id: 1 }, include: { inventario: true } });

  if (!usuario || !productoRelacional || usuario.direcciones.length === 0 || usuario.metodos_pago.length === 0) {
    throw new Error('No hay datos de prueba. Corré "npm run seed" primero.');
  }
  if (productoRelacional.inventario.cantidad < STOCK_OFERTA) {
    throw new Error(`El producto de prueba necesita al menos ${STOCK_OFERTA} unidades de stock real en MySQL para esta verificación.`);
  }

  await conectarMongo();
  const productoId = productoRelacional.id;
  const ahora = new Date();

  // Oferta de prueba: vigente desde hace 1 minuto hasta dentro de 6 horas —
  // la ventana larga es a propósito, para que quede una oferta real
  // demostrable en el catálogo después de correr este script, no solo
  // mientras corre.
  await Producto.updateOne(
    { producto_id: productoId },
    {
      $set: {
        oferta_flash: {
          activo: true,
          precio_oferta: Math.round(Number(productoRelacional.inventario.precio) * 0.5 * 100) / 100,
          stock_oferta: STOCK_OFERTA,
          vigente_desde: new Date(ahora.getTime() - 60 * 1000),
          vigente_hasta: new Date(ahora.getTime() + 6 * 60 * 60 * 1000),
        },
      },
    }
  );

  const redis = conectarRedis();
  await ofertaDatos.invalidar(productoId); // el script editó Mongo directamente
  const clave = `oferta:${productoId}:stock`;
  await redis.del(clave); // estado limpio, por si quedó algo de una corrida anterior

  // Promise.allSettled, no Promise.all: acá se espera que una parte rechace
  // — Promise.all cortaría en el primer rechazo y no dejaría terminar al
  // resto, arruinando la medición.
  const intentos = Array.from({ length: INTENTOS_CONCURRENTES }, () =>
    ofertaFlashService.comprar(usuario.id_usuario, productoId, {
      cantidad: 1,
      direccionId: usuario.direcciones[0].id,
      metodoPagoId: usuario.metodos_pago[0].id,
    })
  );
  const resultados = await Promise.allSettled(intentos);

  const admitidos = resultados.filter((r) => r.status === 'fulfilled');
  const rechazados = resultados.filter((r) => r.status === 'rejected');
  console.log(
    `De ${INTENTOS_CONCURRENTES} intentos simultáneos: ${admitidos.length} admitidos, ${rechazados.length} rechazados ` +
      `(esperado: ${STOCK_OFERTA} / ${INTENTOS_CONCURRENTES - STOCK_OFERTA})`
  );
  if (admitidos.length !== STOCK_OFERTA) {
    throw new Error(`FALLO: se esperaban exactamente ${STOCK_OFERTA} compras admitidas, hubo ${admitidos.length}`);
  }
  if (rechazados.length !== INTENTOS_CONCURRENTES - STOCK_OFERTA) {
    throw new Error('FALLO: la cantidad de rechazos no coincide con lo esperado');
  }
  const motivoInesperado = rechazados.find((r) => !/no quedan unidades en oferta/i.test(r.reason?.message || ''));
  if (motivoInesperado) {
    throw new Error(`FALLO: un rechazo tuvo un motivo inesperado: ${motivoInesperado.reason?.message}`);
  }

  const restanteFinal = await redis.get(clave);
  console.log(`Contador final en Redis: ${restanteFinal} (esperado: 0)`);
  if (Number(restanteFinal) !== 0) {
    throw new Error('FALLO: el contador de Redis no terminó en exactamente 0 — la guardia 1 no fue atómica');
  }

  const ttlFinal = await redis.ttl(clave);
  console.log(`TTL de la clave tras las compras: ${ttlFinal}s (esperado: > 0, atado a vigente_hasta)`);
  if (ttlFinal <= 0) {
    throw new Error('FALLO: la clave de la oferta quedó sin TTL — no vencería sola al terminar la ventana de vigencia');
  }

  // La guardia 2 (MySQL) es la autoridad final — confirmar que de verdad se
  // descontó inventario REAL, no solo el contador de Redis.
  const inventarioFinal = await prisma.inventario.findUnique({ where: { id_producto: productoId } });
  const descontado = productoRelacional.inventario.cantidad - inventarioFinal.cantidad;
  console.log(`Inventario real descontado en MySQL: ${descontado} unidades (esperado: ${STOCK_OFERTA})`);
  if (descontado !== STOCK_OFERTA) {
    throw new Error('FALLO: el inventario real en MySQL no se descontó en la cantidad esperada');
  }

  console.log('Todas las verificaciones de la oferta flash pasaron.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await mongoose.disconnect();
    await neo4j.cerrar();
    conectarRedis().disconnect();
  });
