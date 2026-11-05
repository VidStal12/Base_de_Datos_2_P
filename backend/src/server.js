require('dotenv').config();
const app = require('./app');
const prisma = require('./config/prisma');
const cassandra = require('./config/cassandra');
const redis = require('./config/redis');
const mongoose = require('mongoose');
const ventasSync = require('./services/ventasSyncService');
const bloqueo = require('./services/bloqueoService');
const limitePedidos = require('./services/limitePedidosService');
const restriccion = require('./services/restriccionService');
const checkoutIntentos = require('./services/checkoutIntentoService');
const popularidad = require('./services/popularidadService');

const PORT = process.env.PORT || 3000;

// Una base que se apaga con la aplicación en marcha puede rechazar alguna promesa que
// nadie esperaba (un reenvío "de mejor esfuerzo", un temporizador). Por defecto Node
// termina el proceso ante una promesa rechazada sin manejar, y entonces una caída de
// Neo4j o de Redis tumbaría TODA la aplicación en vez de degradarla: se registra y se sigue.
process.on('unhandledRejection', (motivo) => {
  console.error('Promesa rechazada sin manejar (el servidor sigue en pie):', motivo?.message || motivo);
});

const servidor = app.listen(PORT, () => {
  console.log(`TiendaYa backend escuchando en http://localhost:${PORT}`);
  checkoutIntentos.iniciar();
  // El worker no pertenece a app.js: importar Express en pruebas no inicia
  // temporizadores. Un fallo de configuración/analítica no detiene el checkout.
  try {
    ventasSync.iniciar();
  } catch (error) {
    console.error('No se pudo iniciar la sincronización de ventas:', error.message);
  }
  // Mismo criterio: el barrido de fraude que suspende cuentas tampoco pertenece a
  // app.js, y una configuración inválida no debe tumbar el servidor.
  try {
    bloqueo.iniciar();
  } catch (error) {
    console.error('No se pudo iniciar el bloqueo automático de cuentas:', error.message);
  }
  // El volcado de clics y ventas al índice de búsqueda (ranking por popularidad): igual, en el servidor y no
  // en app.js, y una variable mal escrita no tumba nada.
  try {
    popularidad.iniciar();
  } catch (error) {
    console.error('No se pudo iniciar el volcado de popularidad al índice de búsqueda:', error.message);
  }
  // El tope de pedidos por hora y los límites suaves los lee cada petición
  // (middleware/controlPedidos.js) y FALLAN ABIERTOS: una variable mal escrita no tumba
  // nada, pero se avisa acá, al arrancar, en vez de descubrir que no había tope cuando
  // hacía falta.
  try {
    const { porHora } = limitePedidos.configuracion();
    const suaves = restriccion.configuracion();
    console.log(
      `Control de pedidos: ${porHora > 0 ? `${porHora} por hora por cuenta` : 'sin tope por hora'}; límites suaves ${
        suaves.habilitado ? `${suaves.horas} h, tope de Q${suaves.montoMaximo || '—'} por pedido y ${suaves.pedidosPorHora || '—'} pedidos por hora` : 'apagados'
      }.`
    );
  } catch (error) {
    console.error('Configuración inválida del control de pedidos (no se aplica hasta corregirla):', error.message);
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
      bloqueo.detener(),
      checkoutIntentos.detener(),
      popularidad.detener(),
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
