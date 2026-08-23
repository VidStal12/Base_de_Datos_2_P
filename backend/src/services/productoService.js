const prisma = require('../config/prisma');
const { esEnteroPositivo } = require('../utils/validation');

async function listar({ categoriaId, subcategoriaId } = {}) {
  const where = {};
  if (subcategoriaId) {
    where.categoria_productos = { some: { id_subcategoria: Number(subcategoriaId) } };
  } else if (categoriaId) {
    where.categoria_productos = { some: { subcategoria: { id_categoria: Number(categoriaId) } } };
  }

  return prisma.producto.findMany({
    where,
    include: {
      inventario: true,
      vendedor: { select: { id_usuario: true, nombres: true, apellidos: true } },
      categoria_productos: { include: { subcategoria: true } },
    },
  });
}

async function obtener(id) {
  const producto = await prisma.producto.findUnique({
    where: { id },
    include: {
      inventario: true,
      vendedor: { select: { id_usuario: true, nombres: true, apellidos: true } },
      categoria_productos: { include: { subcategoria: true } },
      atributos_producto: { include: { atributo_categoria: true } },
    },
  });
  if (!producto) throw new Error('Producto no encontrado');
  return producto;
}

// vendedor: { id_usuario, rol } — sale del token, nunca del body (ver requireAuth).
// atributos: [{ id_atributo_categoria, valor }] — opcional, valores concretos
// para los atributos que la subcategoría define (p. ej. Talla: "M").
async function crear(vendedor, { descripcion, imagen_url, estado, subcategoriaId, precio, cantidad, atributos }) {
  if (!descripcion) throw new Error('La descripción es obligatoria');
  if (!esEnteroPositivo(subcategoriaId)) throw new Error('subcategoriaId inválido');
  if (typeof precio !== 'number' || precio <= 0) throw new Error('El precio debe ser un número positivo');
  if (!Number.isInteger(cantidad) || cantidad < 0) throw new Error('La cantidad debe ser un entero mayor o igual a 0');

  const subcategoria = await prisma.subcategoria.findUnique({ where: { id: subcategoriaId } });
  if (!subcategoria) throw new Error('Subcategoría no encontrada');

  return prisma.producto.create({
    data: {
      id_vendedor: vendedor.id_usuario,
      descripcion,
      imagen_url: imagen_url || '',
      estado: estado || 'activo',
      inventario: { create: { precio, cantidad } },
      categoria_productos: { create: [{ id_subcategoria: subcategoriaId }] },
      atributos_producto:
        atributos && atributos.length
          ? { create: atributos.map((a) => ({ id_atributo_categoria: a.id_atributo_categoria, valor: a.valor })) }
          : undefined,
    },
    include: { inventario: true, atributos_producto: true },
  });
}

// Un vendedor solo puede tocar su propio producto; un administrador puede tocar cualquiera.
async function verificarPermiso(vendedor, productoId) {
  const producto = await prisma.producto.findUnique({ where: { id: productoId } });
  if (!producto) {
    const err = new Error('Producto no encontrado');
    err.status = 404;
    throw err;
  }
  if (producto.id_vendedor !== vendedor.id_usuario && vendedor.rol !== 'administrador') {
    const err = new Error('No podés modificar un producto que no te pertenece');
    err.status = 403;
    throw err;
  }
  return producto;
}

async function actualizarInventario(vendedor, productoId, { precio, cantidad }) {
  await verificarPermiso(vendedor, productoId);

  const inventario = await prisma.inventario.findUnique({ where: { id_producto: productoId } });
  if (!inventario) throw new Error('Este producto no tiene inventario asociado');

  const data = {};
  if (precio !== undefined) {
    if (typeof precio !== 'number' || precio <= 0) throw new Error('El precio debe ser un número positivo');
    data.precio = precio;
  }
  if (cantidad !== undefined) {
    if (!Number.isInteger(cantidad) || cantidad < 0) throw new Error('La cantidad debe ser un entero mayor o igual a 0');
    data.cantidad = cantidad;
  }

  return prisma.inventario.update({ where: { id_producto: productoId }, data });
}

module.exports = { listar, obtener, crear, actualizarInventario };
