require('dotenv').config();
const prisma = require('../src/config/prisma');
const cassandra = require('../src/config/cassandra');
const ventasSync = require('../src/services/ventasSyncService');

// Sin argumentos drena los lotes listos una vez. --historico agrega/reencola las
// ventas pagadas anteriores, útil tanto para la primera carga como reconstrucción.
async function main() {
  const argumentos = process.argv.slice(2);
  if (argumentos.some((argumento) => argumento !== '--historico')) {
    throw new Error('Uso: node scripts/sincronizarVentas.js [--historico]');
  }
  if (argumentos.includes('--historico')) {
    const { encolados } = await ventasSync.backfillHistorico();
    console.log(`Historial: ${encolados} detalles pagados encolados`);
  }
  const totales = { procesados: 0, fallidos: 0 };
  // Fijar el corte impide que el comando recicle los mismos errores cuando un
  // historial grande tarde más que el backoff; sí procesa las demás filas listas.
  const hasta = new Date();
  while (true) {
    const resumen = await ventasSync.procesarPendientes({ hasta });
    totales.procesados += resumen.procesados;
    totales.fallidos += resumen.fallidos;
    if (!resumen.seleccionados) break;
  }
  const pendientes = await prisma.venta_outbox.count({ where: { procesado_en: null } });
  console.log(`Ventas sincronizadas: ${totales.procesados}; errores en esta ejecución: ${totales.fallidos}; pendientes: ${pendientes}`);
  // No esperar el backoff en un comando manual. Los errores se conservan y un
  // código distinto de cero permite detectar una carga incompleta en terminal/CI.
  if (pendientes) process.exitCode = 1;
}

main().catch((error) => {
  console.error('No se pudo sincronizar ventas:', error.message);
  process.exitCode = 1;
}).finally(async () => {
  await ventasSync.detener();
  const resultados = await Promise.allSettled([cassandra.cerrar(), prisma.$disconnect()]);
  for (const resultado of resultados) {
    if (resultado.status === 'rejected') {
      console.error('Error al cerrar la sincronización:', resultado.reason.message);
      process.exitCode = 1;
    }
  }
});
