const prisma = require('../config/prisma');

// Compromiso de no reventa (ver IA/PLAN-NEO4J-DETECCION-FRAUDE.md §19): una
// cuenta que puede vender en TiendaYa puede comprar productos de otros
// vendedores, pero no revenderlos — hacerlo incumple los Términos de Servicio.
// Para que esa cláusula sea exigible, cada compra de una cuenta así tiene que
// llevar su aceptación EXPLÍCITA: el frontend muestra un aviso antes de pagar y
// manda `aceptaNoReventa: true`; acá se exige y se deja la constancia en
// `compra.no_reventa_aceptada_en`. La señal de reventa del grafo (fraudeService)
// cita después esa constancia: sin ella, "lo compró y lo vende" sería una
// sospecha; con ella, además es un compromiso roto.
//
// Quién debe aceptar: las cuentas que pueden PUBLICAR productos — las mismas que
// pasan `requireRole('vendedor', 'administrador')` en productoRoutes. Un
// comprador no puede revender nada en la plataforma, así que no se le pide.
// Se lee el rol de MySQL, no del token ni del cuerpo de la petición: el cliente
// nunca decide si "le toca" aceptar.
const ROLES_QUE_VENDEN = ['vendedor', 'administrador'];

// El frontend distingue este rechazo de cualquier otro error del checkout para
// reabrir el aviso, en vez de mostrar un mensaje suelto.
const CODIGO_COMPROMISO = 'COMPROMISO_NO_REVENTA';

// `db` permite pasar la transacción de Prisma, igual que
// productoService.verificarNoEsPropio.
//
// Devuelve `{ requerido, aceptadoEn }`: `aceptadoEn` es el instante que hay que
// guardar en la compra (null si la cuenta no tiene que comprometerse). Lanza 400
// si la cuenta tiene que aceptar y no lo hizo — estrictamente `true`: un
// "true" como texto, un 1 o un campo ausente no cuentan como aceptación.
async function exigirCompromiso(usuarioId, aceptaNoReventa, db = prisma) {
  const usuario = await db.usuarios.findUnique({
    where: { id_usuario: usuarioId },
    select: { rol: { select: { tipo_rol: true } } },
  });
  const requerido = ROLES_QUE_VENDEN.includes(usuario?.rol?.tipo_rol);
  if (!requerido) return { requerido: false, aceptadoEn: null };

  if (aceptaNoReventa !== true) {
    const err = new Error('Como vendedor tenés que aceptar el compromiso de no reventa para poder comprar.');
    err.status = 400;
    err.codigo = CODIGO_COMPROMISO;
    throw err;
  }
  return { requerido: true, aceptadoEn: new Date() };
}

module.exports = { exigirCompromiso, ROLES_QUE_VENDEN, CODIGO_COMPROMISO };
