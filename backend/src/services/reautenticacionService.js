const bcrypt = require('bcryptjs');
const prisma = require('../config/prisma');
const { conectar } = require('../config/redis');

// Reautenticación: volver a pedir la contraseña antes de un pedido cuando la cuenta
// tiene límites suaves (restriccionService.js). Una sesión robada o un token filtrado
// no alcanza para comprar con una cuenta bajo revisión: hace falta saber la contraseña.
//
// El endpoint de compra no puede convertirse en un oráculo de contraseñas, así que los
// intentos se cuentan en Redis con el mismo cupo por ventana que los pedidos (INCR +
// EXPIRE atómico): MAX_INTENTOS por ventana y, pasados, 429 sin ni siquiera comparar.
// Cada intento cuenta; uno acertado borra el contador, así que quien sabe su
// contraseña nunca acumula. Sin Redis se verifica igual, solo que sin contar.

const MAX_INTENTOS = 5;
const VENTANA_SEGUNDOS = 900; // 15 minutos
const claveIntentos = (usuarioId) => `reauth:intentos:${usuarioId}`;

let ultimoAviso = 0;
function avisarFallo(err) {
  if (Date.now() - ultimoAviso < 30000) return;
  ultimoAviso = Date.now();
  console.error('No se pudo contar los intentos de contraseña en Redis (se verifica igual):', err.message);
}

// { ok: true } | { ok: false, motivo: 'incorrecta' } |
// { ok: false, motivo: 'demasiados', reintentarEnSegundos }
async function verificarContrasena(usuarioId, contrasena) {
  let reserva = null;
  try {
    reserva = await conectar().reservarCupo(claveIntentos(usuarioId), MAX_INTENTOS, VENTANA_SEGUNDOS);
  } catch (err) {
    avisarFallo(err);
  }
  if (reserva && Number(reserva[0]) === -1) {
    return { ok: false, motivo: 'demasiados', reintentarEnSegundos: Number(reserva[1]) };
  }

  const usuario = await prisma.usuarios.findUnique({ where: { id_usuario: usuarioId }, select: { contrasena: true } });
  const coincide = usuario ? await bcrypt.compare(contrasena, usuario.contrasena) : false;
  if (!coincide) return { ok: false, motivo: 'incorrecta' };

  try {
    await conectar().del(claveIntentos(usuarioId));
  } catch (err) {
    avisarFallo(err);
  }
  return { ok: true };
}

module.exports = { verificarContrasena, MAX_INTENTOS, VENTANA_SEGUNDOS };
