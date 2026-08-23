const prisma = require('../config/prisma');
const { esEnteroPositivo } = require('../utils/validation');

// Filtro de texto simple (LIKE sobre descripcion) — no confundir con el buscador
// de texto libre con tolerancia ortográfica que pide el PRD para Entrega 3
// (Elasticsearch). Esto es solo lo mínimo para que la barra de búsqueda del
// catálogo actual devuelva algo razonable.
async function listar({ categoriaId, subcategoriaId, q, vendedorId } = {}) {
  const where = {};
  if (subcategoriaId) {
    where.categoria_productos = { some: { id_subcategoria: Number(subcategoriaId) } };
  } else if (categoriaId) {
    where.categoria_productos = { some: { subcategoria: { id_categoria: Number(categoriaId) } } };
  }
  if (q) {
    where.descripcion = { contains: q };
  }
  if (vendedorId) {
    where.id_vendedor = Number(vendedorId);
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

// Edición completa: campos propios, inventario y valores de atributo, todo opcional
// (se actualiza solo lo que venga en el body). atributos: [{ id_atributo_categoria, valor }]
// — con el @@unique de atributo_producto, upsert crea el valor si no existía o lo
// corrige si ya estaba (p. ej. arreglar "Talla: L" a "Talla: M").
async function actualizar(vendedor, productoId, { descripcion, imagen_url, estado, precio, cantidad, atributos }) {
  await verificarPermiso(vendedor, productoId);

  const datosProducto = {};
  if (descripcion !== undefined) {
    if (!descripcion) throw new Error('La descripción no puede estar vacía');
    datosProducto.descripcion = descripcion;
  }
  if (imagen_url !== undefined) datosProducto.imagen_url = imagen_url;
  if (estado !== undefined) datosProducto.estado = estado;

  if (Object.keys(datosProducto).length > 0) {
    await prisma.producto.update({ where: { id: productoId }, data: datosProducto });
  }

  if (precio !== undefined || cantidad !== undefined) {
    const datosInventario = {};
    if (precio !== undefined) {
      if (typeof precio !== 'number' || precio <= 0) throw new Error('El precio debe ser un número positivo');
      datosInventario.precio = precio;
    }
    if (cantidad !== undefined) {
      if (!Number.isInteger(cantidad) || cantidad < 0) throw new Error('La cantidad debe ser un entero mayor o igual a 0');
      datosInventario.cantidad = cantidad;
    }
    await prisma.inventario.update({ where: { id_producto: productoId }, data: datosInventario });
  }

  if (atributos && atributos.length) {
    for (const { id_atributo_categoria, valor } of atributos) {
      if (!esEnteroPositivo(id_atributo_categoria) || !valor) {
        throw new Error('Cada atributo necesita id_atributo_categoria y valor');
      }
      await prisma.atributo_producto.upsert({
        where: { id_producto_id_atributo_categoria: { id_producto: productoId, id_atributo_categoria } },
        update: { valor },
        create: { id_producto: productoId, id_atributo_categoria, valor },
      });
    }
  }

  return obtener(productoId);
}

module.exports = { listar, obtener, crear, actualizar };
