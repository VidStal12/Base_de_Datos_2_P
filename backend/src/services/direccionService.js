const prisma = require('../config/prisma');

async function crear(usuarioId, { pais, direccion, codigo_postal }) {
  if (!pais || !direccion || !codigo_postal) {
    throw new Error('pais, direccion y codigo_postal son obligatorios');
  }
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
    const err = new Error('Dirección no encontrada');
    err.status = 404;
    throw err;
  }
  try {
    await prisma.direcciones.delete({ where: { id } });
  } catch (e) {
    // P2003: la FK compra.id_direccion no tiene onDelete configurado (RESTRICT
    // por defecto) — a propósito, un pedido ya hecho no debería poder perder
    // su dirección de envío. Se convierte en un error claro en vez de dejar
    // pasar el de Prisma tal cual (que trae rutas de archivo del servidor).
    if (e.code === 'P2003') {
      const err = new Error('No se puede eliminar: esta dirección tiene pedidos asociados');
      err.status = 409;
      throw err;
    }
    throw e;
  }
}

module.exports = { crear, listar, eliminar };
