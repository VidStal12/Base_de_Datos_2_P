const { setTimeout: esperar } = require('node:timers/promises');

// Solo el entorno del servidor puede activar la pausa; no se acepta desde HTTP.
// Ambos puntos se ejecutan fuera de la transacción para no retener locks al esperar.
async function pausar(etapa, { usuarioId, intentoId, compraId } = {}) {
  if (process.env.CHECKOUT_DEMO_ENABLED !== 'true' || process.env.NODE_ENV === 'production') return;
  const seleccionada = process.env.CHECKOUT_DEMO_PAUSE_AT || 'after_commit_before_redis';
  if (seleccionada !== etapa) return;
  const ms = Number(process.env.CHECKOUT_DEMO_PAUSE_MS || 15000);
  if (!['before_transaction', 'after_commit_before_redis'].includes(etapa) || !Number.isInteger(ms) || ms < 1 || ms > 60000) {
    console.error('[checkout-demo] Configuración inválida: etapa válida y espera de 1 a 60000 ms requeridas. Se omite la pausa.');
    return;
  }
  const servicio = etapa === 'before_transaction' ? 'mysql' : 'redis';
  console.log('[checkout-demo] PAUSA', JSON.stringify({ etapa, ms, usuarioId, intentoId, compraId }), `Podés ejecutar: docker compose stop ${servicio}`);
  await esperar(ms);
  console.log('[checkout-demo] CONTINÚA', JSON.stringify({ etapa, intentoId, compraId }));
}

module.exports = { pausar };
