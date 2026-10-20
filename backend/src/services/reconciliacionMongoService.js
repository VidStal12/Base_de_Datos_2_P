const { avisarCaida } = require('../utils/resiliencia');

// La copia del catálogo en Mongo (stock y total vendido de cada producto) se actualiza
// DESPUÉS de confirmar el pedido en MySQL, de mejor esfuerzo (ver checkoutService.js): si
// Mongo estaba apagado en ese momento, la compra ya es definitiva y la copia queda atrás.
// Antes eso solo se corregía a mano (el botón «recalcular» del administrador); ahora los
// productos afectados se anotan acá y, en cuanto Mongo responde, se recalculan desde MySQL.
//
// Recalcular (no «aplicar el descuento que faltó») hace que reintentar sea idempotente:
// el resultado es el mismo se ejecute una o cinco veces, y también cubre cualquier otra
// diferencia que hubiera quedado. Solo se tocan los productos anotados — nunca el catálogo
// completo —, porque recalcular todo reescribiría números que alguien cargó a propósito.
//
// La lista vive en memoria: si el servidor se reinicia durante la caída se pierde y queda
// el botón de administrador (POST /api/admin/recalcular-inventario y -ventas) como respaldo.
const INTERVALO_MS = 15000;
const MAXIMO_PENDIENTES = 5000;

const pendientes = new Set();
let temporizador;
let ejecucion;

// Se carga al usarse: catalogoSyncService arrastra Prisma y Mongoose, que no hacen falta
// hasta que haya algo que reconciliar.
function sincronizador() {
  return require('./catalogoSyncService');
}

async function reconciliar() {
  if (ejecucion) return ejecucion;
  ejecucion = (async () => {
    const ids = [...pendientes];
    if (ids.length === 0) return { reconciliados: 0 };
    try {
      await sincronizador().recalcularInventario({ productoIds: ids });
      await sincronizador().recalcularVentas({ productoIds: ids });
    } catch (err) {
      avisarCaida('mongo', err);
      return { reconciliados: 0, pendientes: pendientes.size };
    }
    for (const id of ids) pendientes.delete(id);
    console.log(`[resiliencia] se reconcilió la copia de Mongo de ${ids.length} producto(s) tras la caída`);
    if (pendientes.size === 0) detener();
    return { reconciliados: ids.length, pendientes: pendientes.size };
  })().finally(() => {
    ejecucion = undefined;
  });
  return ejecucion;
}

function detener() {
  if (temporizador) clearInterval(temporizador);
  temporizador = undefined;
}

// Anota productos cuya copia en Mongo quedó atrás.
function encolar(productoIds) {
  for (const id of productoIds) {
    if (pendientes.size >= MAXIMO_PENDIENTES) break;
    pendientes.add(id);
  }
  if (!temporizador && pendientes.size > 0) {
    temporizador = setInterval(() => reconciliar().catch(() => {}), INTERVALO_MS);
    temporizador.unref();
  }
}

module.exports = { encolar, reconciliar, detener, pendientes: () => [...pendientes] };
