const { conectar } = require('../config/redis');

// Un candado por cuenta con vencimiento propio, en Redis: la clave `{prefijo}:{id}`
// EXISTE mientras el candado está puesto y su TTL es lo que falta para que se
// levante solo — Redis es quien lo hace vencer, nadie tiene que acordarse. Hay dos,
// con el mismo mecanismo y distinta consecuencia:
//   `bloqueo`      suspensión (suspensionService.js): la cuenta no puede entrar.
//   `restriccion`  límites suaves (restriccionService.js): puede comprar, con tope.
// Escribirlo es siempre el mismo script Lua (config/redis.js, `bloquearCuenta`): solo
// ALARGA un candado vigente, nunca lo acorta.
function crearCandado(prefijo) {
  const clave = (usuarioId) => `${prefijo}:${usuarioId}`;
  const patron = new RegExp(`^${prefijo}:(\\d+)$`);

  // PTTL: -2 no existe, -1 existe sin vencimiento (no lo crea este código, pero se
  // respeta), >= 0 los milisegundos que faltan.
  async function estado(usuarioId) {
    const restanteMs = await conectar().pttl(clave(usuarioId));
    if (restanteMs === -2) return { activo: false };
    return {
      activo: true,
      restanteMs: restanteMs >= 0 ? restanteMs : null,
      hasta: restanteMs >= 0 ? new Date(Date.now() + restanteMs) : null,
    };
  }

  // true si escribió (no había candado o el nuevo dura más).
  async function bloquear(usuarioId, duracionMs) {
    if (!(duracionMs > 0)) throw new Error('La duración del candado debe ser positiva');
    const escribio = await conectar().bloquearCuenta(clave(usuarioId), JSON.stringify({ desde: new Date().toISOString() }), Math.ceil(duracionMs));
    return Number(escribio) === 1;
  }

  // true si había un candado que quitar.
  async function levantar(usuarioId) {
    return (await conectar().del(clave(usuarioId))) > 0;
  }

  // Ids con el candado puesto (SCAN, no KEYS: no bloquea el servidor aunque el
  // espacio de claves crezca).
  async function usuarios() {
    const redis = conectar();
    const ids = [];
    let cursor = '0';
    do {
      const [siguiente, lote] = await redis.scan(cursor, 'MATCH', `${prefijo}:*`, 'COUNT', 200);
      for (const k of lote) {
        const coincidencia = patron.exec(k);
        if (coincidencia) ids.push(Number(coincidencia[1]));
      }
      cursor = siguiente;
    } while (cursor !== '0');
    return ids;
  }

  // Map id → milisegundos que faltan (null: sin vencimiento); las cuentas sin
  // candado no aparecen. Una sola ida a Redis.
  async function restantes(usuarioIds) {
    const resultado = new Map();
    if (usuarioIds.length === 0) return resultado;
    const pipeline = conectar().pipeline();
    for (const id of usuarioIds) pipeline.pttl(clave(id));
    const respuestas = await pipeline.exec();
    usuarioIds.forEach((id, i) => {
      const [error, ms] = respuestas[i];
      if (!error && ms !== -2) resultado.set(id, ms >= 0 ? ms : null);
    });
    return resultado;
  }

  return { prefijo, clave, estado, bloquear, levantar, usuarios, restantes };
}

module.exports = { crearCandado };
