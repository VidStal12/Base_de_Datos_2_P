const { types } = require('cassandra-driver');
const prisma = require('../config/prisma');
const cassandra = require('../config/cassandra');
const { crearPayload } = require('./ventasOutboxService');
const { fechaGuatemala } = require('../utils/ventas');

let ejecucion;
let temporizador;

const INSERT_DIA = `INSERT INTO ventas_por_dia
  (dia, fecha_venta, detalle_id, compra_id, producto_id, vendedor_id, cantidad, importe, descuento)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const INSERT_PRODUCTO = `INSERT INTO ventas_por_producto_mes
  (producto_id, mes, fecha_venta, detalle_id, compra_id, vendedor_id, cantidad, importe, descuento)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// Validar el snapshot permite aislar un pendiente dañado: se reintenta y queda
// su error en MySQL, sin insertar filas incompletas ni bloquear las demás ventas.
function parametros(payload, detalleId) {
  for (const campo of ['detalle_id', 'compra_id', 'producto_id', 'vendedor_id', 'cantidad']) {
    if (!Number.isInteger(payload[campo]) || payload[campo] < 1 || payload[campo] > 2147483647) {
      throw new Error(`Snapshot de venta inválido: ${campo}`);
    }
  }
  if (payload.detalle_id !== detalleId) throw new Error('El snapshot no corresponde al detalle del outbox');
  for (const campo of ['importe', 'descuento']) {
    if (typeof payload[campo] !== 'string' || !/^\d+\.\d{2}$/.test(payload[campo])) {
      throw new Error(`Snapshot de venta inválido: ${campo} debe ser un string decimal`);
    }
  }
  const fecha = new Date(payload.fecha_venta);
  if (!Number.isFinite(fecha.getTime())) throw new Error('Snapshot de venta inválido: fecha_venta');
  // Reutiliza el calendario del panel: a las 02:00 UTC aún es el día anterior
  // en Guatemala. No depende de la zona horaria del servidor ni de Docker.
  const diaTexto = fechaGuatemala(fecha);
  const dia = types.LocalDate.fromString(diaTexto);
  const mes = types.LocalDate.fromString(`${diaTexto.slice(0, 7)}-01`);
  const importe = types.BigDecimal.fromString(payload.importe);
  const descuento = types.BigDecimal.fromString(payload.descuento);
  return {
    dia: [dia, fecha, payload.detalle_id, payload.compra_id, payload.producto_id,
      payload.vendedor_id, payload.cantidad, importe, descuento],
    producto: [payload.producto_id, mes, fecha, payload.detalle_id, payload.compra_id,
      payload.vendedor_id, payload.cantidad, importe, descuento],
  };
}

function tamanoLote() {
  const valor = Number(process.env.VENTAS_SYNC_BATCH_SIZE || 50);
  if (!Number.isInteger(valor) || valor < 1 || valor > 500) {
    throw new Error('VENTAS_SYNC_BATCH_SIZE debe ser un entero entre 1 y 500');
  }
  return valor;
}

// Reutilizar la promesa hace que un disparo manual y el temporizador nunca
// ejecuten dos lotes superpuestos dentro del mismo proceso.
function procesarPendientes({ hasta = new Date() } = {}) {
  if (!ejecucion) {
    ejecucion = procesarLote(hasta).finally(() => { ejecucion = undefined; });
  }
  return ejecucion;
}

async function procesarLote(hasta) {
  const pendientes = await prisma.venta_outbox.findMany({
    where: { procesado_en: null, proximo_intento: { lte: hasta } },
    orderBy: [{ proximo_intento: 'asc' }, { detalle_id: 'asc' }],
    take: tamanoLote(),
  });
  const resumen = { seleccionados: pendientes.length, procesados: 0, fallidos: 0 };
  if (!pendientes.length) return resumen;

  // Una caída de Cassandra se comprueba una sola vez por lote; los pendientes
  // conservan su payload y reciben backoff sin esperar una conexión por fila.
  let cliente;
  let errorConexion;
  try {
    cliente = await cassandra.obtenerCliente();
  } catch (error) {
    errorConexion = error;
  }

  for (const pendiente of pendientes) {
    try {
      if (errorConexion) throw errorConexion;
      const valores = parametros(pendiente.payload, pendiente.detalle_id);
      const opciones = { prepare: true, isIdempotent: true };
      await cliente.execute(INSERT_DIA, valores.dia, opciones);
      await cliente.execute(INSERT_PRODUCTO, valores.producto, opciones);

      // Solo confirmar después de AMBAS proyecciones. Si el proceso termina
      // entre los INSERT o antes de este UPDATE, el reintento escribe las mismas
      // claves y no duplica ventas. No se usan contadores ni incrementos en CQL.
      await prisma.venta_outbox.updateMany({
        where: { detalle_id: pendiente.detalle_id, procesado_en: null },
        data: { procesado_en: new Date(), intentos: { increment: 1 }, ultimo_error: null },
      });
      resumen.procesados += 1;
    } catch (error) {
      // El filtro procesado_en evita que el fallo de un segundo worker revierta
      // la confirmación que otro proceso haya guardado simultáneamente.
      const demora = Math.min(3600000, 30000 * (2 ** Math.min(pendiente.intentos, 7)));
      await prisma.venta_outbox.updateMany({
        where: { detalle_id: pendiente.detalle_id, procesado_en: null },
        data: {
          intentos: { increment: 1 },
          proximo_intento: new Date(Date.now() + demora),
          ultimo_error: String(error.message || error).slice(0, 2000),
        },
      });
      resumen.fallidos += 1;
    }
  }
  return resumen;
}

// El temporizador no bloquea el arranque HTTP. Una base caída se informa y el
// siguiente ciclo vuelve a intentarlo; los pendientes siguen durables en MySQL.
function iniciar() {
  if (temporizador || ['false', '0'].includes((process.env.VENTAS_SYNC_ENABLED || 'true').toLowerCase())) return;
  const intervalo = Number(process.env.VENTAS_SYNC_INTERVAL_MS || 30000);
  if (!Number.isInteger(intervalo) || intervalo < 1000 || intervalo > 2147483647) {
    throw new Error('VENTAS_SYNC_INTERVAL_MS debe ser un entero entre 1000 y 2147483647');
  }
  const ejecutar = () => procesarPendientes().then((resumen) => {
    if (resumen.fallidos) {
      console.error(`Sincronización de ventas: ${resumen.fallidos} pendientes con reintento programado`);
    }
  }).catch((error) => {
    console.error('No se pudo procesar el outbox de ventas:', error.message);
  });
  temporizador = setInterval(ejecutar, intervalo);
  temporizador.unref();
  ejecutar();
}

async function detener() {
  if (temporizador) clearInterval(temporizador);
  temporizador = undefined;
  // Esperar el lote vigente antes de cerrar Prisma/Cassandra evita interrumpir
  // una confirmación. Sus errores ya se informan en el ciclo o script llamador.
  if (ejecucion) await ejecucion.catch(() => {});
}

// Captura excepcional del historial previo a instalar el outbox. La paginación
// por ID solo se usa aquí: las ventas nuevas SIEMPRE se capturan en el checkout.
// `some` equivale a EXISTS pago aprobado, así que varios pagos no duplican líneas.
async function backfillHistorico() {
  let ultimoId = 0;
  let encolados = 0;
  const lote = tamanoLote();
  while (true) {
    const detalles = await prisma.compra_detalle.findMany({
      where: { id: { gt: ultimoId }, compra: { pagos: { some: { estado: 'aprobado' } } } },
      orderBy: { id: 'asc' },
      take: lote,
      include: {
        compra: { select: { id: true, fecha: true } },
        producto: { select: { id_vendedor: true } },
      },
    });
    if (!detalles.length) break;
    await prisma.$transaction(async (tx) => {
      for (const detalle of detalles) {
        await tx.venta_outbox.upsert({
          where: { detalle_id: detalle.id },
          create: {
            detalle_id: detalle.id,
            payload: crearPayload(detalle.compra, detalle, detalle.producto.id_vendedor),
          },
          // Reencolar también los ya enviados permite reconstruir Cassandra si
          // se pierde su volumen. Un snapshot existente permanece inmutable.
          update: { procesado_en: null, intentos: 0, proximo_intento: new Date(), ultimo_error: null },
        });
      }
    }, { timeout: 15000 });
    encolados += detalles.length;
    ultimoId = detalles[detalles.length - 1].id;
  }
  return { encolados };
}

module.exports = { procesarPendientes, iniciar, detener, backfillHistorico };
