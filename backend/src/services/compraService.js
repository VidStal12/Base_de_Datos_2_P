const prisma = require('../config/prisma');
const productoService = require('./productoService');
const { componenteCaido } = require('../utils/resiliencia');

// MySQL guarda de cada línea solo el producto como ancla (id y vendedor): el nombre y la imagen
// viven en el catálogo. Sin este paso la pantalla de un pedido mostraba la línea «× 1» sin
// nombre, también con todas las bases arriba (se vio al confirmar una compra con Mongo
// apagado). Se pregunta a Mongo y, si no responde, a su copia en el índice de búsqueda
// (productoService.estadoPublicacion); si el catálogo no está disponible, el producto se
// identifica por su número — el pedido es de MySQL y se muestra completo igual.
async function conNombres(compras) {
  const ids = [...new Set(compras.flatMap((compra) => compra.compra_detalles.map((detalle) => detalle.id_producto)))];
  let catalogo = new Map();
  if (ids.length > 0) {
    try {
      catalogo = await productoService.estadoPublicacion(ids);
    } catch (err) {
      if (!componenteCaido(err)) throw err;
    }
  }
  return compras.map((compra) => ({
    ...compra,
    compra_detalles: compra.compra_detalles.map((detalle) => {
      const producto = catalogo.get(detalle.id_producto);
      return {
        ...detalle,
        producto: {
          ...detalle.producto,
          descripcion: producto?.descripcion ?? '',
          nombre: producto?.nombre ?? `Producto #${detalle.id_producto}`,
          imagen_url: producto?.imagen_url ?? '',
        },
      };
    }),
  }));
}

async function listarPorUsuario(usuarioId) {
  const compras = await prisma.compra.findMany({
    where: { id_usuario: usuarioId },
    include: {
      compra_detalles: { include: { producto: true } },
      pagos: true,
      direccion: true,
    },
    orderBy: { fecha: 'desc' },
  });
  return conNombres(compras);
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
  return (await conNombres([compra]))[0];
}

module.exports = { listarPorUsuario, obtener };
