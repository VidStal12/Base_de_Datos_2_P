require('dotenv').config();
const mongoose = require('mongoose');
const prisma = require('../src/config/prisma');
const { checkout } = require('../src/services/checkoutService');

// Evidencia de funcionamiento del checkout transaccional (PRD, Fase Inicial):
// 1) Un checkout válido crea compra + líneas + pago y descuenta inventario.
// 2) Un checkout que pide más unidades de las disponibles falla ENTERO y no
//    deja el inventario a medio actualizar — es decir, la transacción es atómica.
async function main() {
  // Por id fijo (1 = el primer producto del seed), no por descripción — la
  // descripción puede cambiar con el tiempo (ahora vive en Mongo, ver ADR-002)
  // y este script no debería depender de un valor mutable.
  const producto = await prisma.producto.findUnique({ where: { id: 1 } });
  const usuario = await prisma.usuarios.findFirst({
    where: { correo: 'ana.gomez@example.com' },
    include: { direcciones: true, metodos_pago: true },
  });

  if (!producto || !usuario || usuario.direcciones.length === 0 || usuario.metodos_pago.length === 0) {
    throw new Error('No hay datos de prueba. Corré "npm run seed" primero.');
  }

  const stockAntes = await prisma.inventario.findUnique({ where: { id_producto: producto.id } });
  console.log('Stock antes:', stockAntes.cantidad);

  const { compra, pago } = await checkout({
    usuarioId: usuario.id_usuario,
    direccionId: usuario.direcciones[0].id,
    metodoPagoId: usuario.metodos_pago[0].id,
    items: [{ productoId: producto.id, cantidad: 2 }],
  });
  const stockDespues = await prisma.inventario.findUnique({ where: { id_producto: producto.id } });
  console.log(`Checkout OK -> compra #${compra.id}, pago #${pago.id}, stock después: ${stockDespues.cantidad}`);

  const stockActual = stockDespues.cantidad;
  try {
    await checkout({
      usuarioId: usuario.id_usuario,
      direccionId: usuario.direcciones[0].id,
      metodoPagoId: usuario.metodos_pago[0].id,
      items: [{ productoId: producto.id, cantidad: stockActual + 1000 }],
    });
    console.error('FALLO EN LA PRUEBA: se esperaba que este checkout fuera rechazado por falta de stock');
    process.exitCode = 1;
  } catch (err) {
    const stockTrasFallo = await prisma.inventario.findUnique({ where: { id_producto: producto.id } });
    const seMantuvo = stockTrasFallo.cantidad === stockActual;
    console.log(`Checkout con sobreventa rechazado ("${err.message}"). Stock sin cambios: ${seMantuvo}`);
    if (!seMantuvo) {
      console.error('FALLO EN LA PRUEBA: el stock cambió a pesar de que el checkout falló (no es atómico)');
      process.exitCode = 1;
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    // checkout() ahora también toca Mongo (actualiza total_vendido, ver
    // checkoutService.js) — sin este disconnect el proceso se queda colgado
    // indefinidamente por la conexión de Mongoose abierta, aunque main() ya
    // haya terminado su trabajo.
    await prisma.$disconnect();
    await mongoose.disconnect();
  });
