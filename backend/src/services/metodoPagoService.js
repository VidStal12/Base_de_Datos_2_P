const prisma = require('../config/prisma');

async function crear(usuarioId, { titular, token_pasarela, ultimos_4_digitos, marca }) {
  if (!titular || !token_pasarela || !marca) {
    throw new Error('titular, token_pasarela y marca son obligatorios');
  }
  if (!/^\d{4}$/.test(ultimos_4_digitos || '')) {
    throw new Error('ultimos_4_digitos debe ser exactamente 4 dígitos');
  }
  return prisma.metodo_pago.create({
    data: { id_usuario: usuarioId, titular, token_pasarela, ultimos_4_digitos, marca },
  });
}

// El token de la pasarela no se expone de vuelta al cliente: una vez guardado,
// nadie necesita volver a leerlo, solo usarlo internamente al pagar.
async function listar(usuarioId) {
  return prisma.metodo_pago.findMany({
    where: { id_usuario: usuarioId },
    select: { id: true, titular: true, ultimos_4_digitos: true, marca: true },
  });
}

async function eliminar(usuarioId, id) {
  const metodo = await prisma.metodo_pago.findUnique({ where: { id } });
  if (!metodo || metodo.id_usuario !== usuarioId) {
    const err = new Error('Método de pago no encontrado');
    err.status = 404;
    throw err;
  }
  try {
    await prisma.metodo_pago.delete({ where: { id } });
  } catch (e) {
    // P2003: la FK pago.id_metodo_pago no tiene onDelete configurado
    // (RESTRICT por defecto) — a propósito, un pago ya hecho no debería poder
    // quedar sin el método que lo cobró. Se convierte en un error claro en vez
    // de dejar pasar el de Prisma tal cual (que trae rutas de archivo del
    // servidor).
    if (e.code === 'P2003') {
      const err = new Error('No se puede eliminar: este método de pago tiene pagos asociados');
      err.status = 409;
      throw err;
    }
    throw e;
  }
}

module.exports = { crear, listar, eliminar };
