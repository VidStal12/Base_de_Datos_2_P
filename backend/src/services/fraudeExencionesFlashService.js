// Excepción optativa para la carga sintética de flash-sale-tests. No cambia
// contraseñas, roles, pagos ni inventario. En producción siempre está apagada.
function correosExentos(env = process.env) {
  if (env.NODE_ENV === 'production' || env.FRAUDE_EXENTOS_FLASH_ENABLED !== 'true') return [];
  // La lista exacta del script evita eximir por prefijo o por dominio completo.
  const cuentas = require('../../../flash-sale-tests/users.example.json');
  return [cuentas.seller, ...cuentas.buyers].map((cuenta) => cuenta.email.toLowerCase());
}

function esCorreoExento(correo, env = process.env) {
  return typeof correo === 'string' && correosExentos(env).includes(correo.toLowerCase());
}

// Cierra los casos existentes antes de quitar sus dos candados. Si Redis falla,
// la operación se puede repetir; reconciliar no vuelve a reconstruir esos casos.
async function liberarExistentes({ prisma, suspension, restriccion }, env = process.env) {
  const correos = correosExentos(env);
  if (correos.length === 0) return { cuentas: 0, casosLiberados: 0 };
  const usuarios = await prisma.usuarios.findMany({
    where: { correo: { in: correos } }, select: { id_usuario: true },
  });
  const ids = usuarios.map((usuario) => usuario.id_usuario);
  if (ids.length === 0) return { cuentas: 0, casosLiberados: 0 };
  const { count } = await prisma.bloqueo_cuenta.updateMany({
    where: { id_usuario: { in: ids }, estado: 'activo', tipo: { in: ['suspension', 'restriccion'] } },
    data: {
      estado: 'liberado', revisado_en: new Date(), revisado_por: null,
      nota_revision: 'Exención local de cuentas de flash-sale-tests (FRAUDE_EXENTOS_FLASH_ENABLED).',
    },
  });
  await Promise.all(ids.flatMap((id) => [suspension.levantar(id), restriccion.candado.levantar(id)]));
  return { cuentas: ids.length, casosLiberados: count };
}

module.exports = { correosExentos, esCorreoExento, liberarExistentes };
