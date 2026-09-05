require('dotenv').config();
const app = require('./app');
const prisma = require('./config/prisma');
const cassandra = require('./config/cassandra');
const redis = require('./config/redis');
const mongoose = require('mongoose');
const ventasSync = require('./services/ventasSyncService');

const PORT = process.env.PORT || 3000;

const servidor = app.listen(PORT, () => {
  console.log(`TiendaYa backend escuchando en http://localhost:${PORT}`);
  // El worker no pertenece a app.js: importar Express en pruebas no inicia
  // temporizadores. Un fallo de configuración/analítica no detiene el checkout.
  try {
    ventasSync.iniciar();
  } catch (error) {
    console.error('No se pudo iniciar la sincronización de ventas:', error.message);
  }
});

let cerrando = false;

// Primero se dejan terminar las peticiones y el lote actual; después se liberan
// los pools. La guarda evita cerrar dos veces si llegan SIGINT y SIGTERM juntos.
async function apagar() {
  if (cerrando) return;
  cerrando = true;
  try {
    await Promise.all([
      new Promise((resolve, reject) => servidor.close((error) => error ? reject(error) : resolve())),
      ventasSync.detener(),
    ]);
    const resultados = await Promise.allSettled([
      cassandra.cerrar(), prisma.$disconnect(), mongoose.disconnect(), redis.cerrar(),
    ]);
    for (const resultado of resultados) {
      if (resultado.status === 'rejected') throw resultado.reason;
    }
  } catch (error) {
    console.error('Error al cerrar el backend:', error.message);
    process.exitCode = 1;
  }
}

process.once('SIGINT', apagar);
process.once('SIGTERM', apagar);
