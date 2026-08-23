const prisma = require('../config/prisma');

async function crear(usuarioId, { pais, direccion, codigo_postal }) {
  return prisma.direcciones.create({
    data: { id_usuario: usuarioId, pais, direccion, codigo_postal },
  });
}

async function listar(usuarioId) {
  return prisma.direcciones.findMany({ where: { id_usuario: usuarioId } });
}

async function eliminar(usuarioId, id) {
  const direccion = await prisma.direcciones.findUnique({ where: { id } });
  if (!direccion || direccion.id_usuario !== usuarioId) {
    throw new Error('Dirección no encontrada');
  }
  await prisma.direcciones.delete({ where: { id } });
}

module.exports = { crear, listar, eliminar };
