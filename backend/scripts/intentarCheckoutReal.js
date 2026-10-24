require('dotenv').config();
const mongoose = require('mongoose');
const prisma = require('../src/config/prisma');
const { conectar: conectarRedis } = require('../src/config/redis');
const { checkout } = require('../src/services/checkoutService');

// Driver mínimo para IA/ENTREGA-3-CONSISTENCIA.md — un checkout real, con
// datos reales, sin mocks ni dobles. No decide si el fallo es "esperado":
// solo corre checkout() tal cual está en producción y reporta qué pasó — la
// intención es capturar el comportamiento REAL del código de manejo de
// errores ya existente (los console.error de checkoutService.js), corriendo
// con una base intencionalmente caída al lado, no simular la caída en código.
async function main() {
  const usuario = await prisma.usuarios.findFirst({
    where: { correo: 'ana.gomez@example.com' },
    include: { direcciones: true, metodos_pago: true },
  });
  const productoId = 1;
  const cantidad = 1;

  console.log(`Intentando checkout real: usuario ${usuario.id_usuario}, producto ${productoId} x${cantidad}...`);
  const inventarioAntes = await prisma.inventario.findUnique({ where: { id_producto: productoId } });
  console.log('inventario MySQL antes:', inventarioAntes);

  try {
    const resultado = await checkout({
      usuarioId: usuario.id_usuario,
      direccionId: usuario.direcciones[0].id,
      metodoPagoId: usuario.metodos_pago[0].id,
      items: [{ productoId, cantidad }],
    });
    console.log('RESULTADO: checkout() no lanzó excepción.');
    console.log('  compra.id:', resultado.compra.id, '| pago.estado:', resultado.pago.estado);
  } catch (err) {
    console.log('RESULTADO: checkout() lanzó una excepción — la compra NO se confirmó.');
    console.log('  error:', err.message);
  }

  const inventarioDespues = await prisma.inventario.findUnique({ where: { id_producto: productoId } });
  console.log('inventario MySQL después:', inventarioDespues);
}

main()
  .catch((e) => {
    console.error('Error inesperado en el driver:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await mongoose.disconnect().catch(() => {});
    try {
      conectarRedis('admin').disconnect();
    } catch {}
  });
