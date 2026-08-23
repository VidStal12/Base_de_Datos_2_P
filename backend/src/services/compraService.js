const prisma = require('../config/prisma');

async function listarPorUsuario(usuarioId) {
  return prisma.compra.findMany({
    where: { id_usuario: usuarioId },
    include: {
      compra_detalles: { include: { producto: true } },
      pagos: true,
      direccion: true,
    },
    orderBy: { fecha: 'desc' },
  });
}

async function obtener(usuarioId, id) {
  const compra = await prisma.compra.findUnique({
    where: { id },
    include: {
      compra_detalles: { include: { producto: true } },
      pagos: true,
      direccion: true,
    },
  });
  if (!compra || compra.id_usuario !== usuarioId) {
    throw new Error('Pedido no encontrado');
  }
  return compra;
}

module.exports = { listarPorUsuario, obtener };
