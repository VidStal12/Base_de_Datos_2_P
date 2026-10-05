const test = require('node:test');
const assert = require('node:assert/strict');
const { cargar } = require('./redisHelpers');

// La oferta flash guarda en Redis una copia del producto (ofertaDatosService.js) y
// la regla es que TODO escritor de lo que se copia la invalida — nunca publica él
// mismo. Editar el producto y configurar la oferta ya lo hacen (ofertaDatos.test.js);
// acá, los otros dos escritores: una reseña nueva (cambia el resumen de reseñas) y
// la reconciliación del inventario (cambia el precio normal).

test('una reseña nueva invalida la copia de la oferta DESPUÉS de recalcular el resumen', async () => {
  const eventos = [];
  const servicio = cargar('../src/services/resenaService.js', {
    '../config/prisma': {
      usuarios: { findUnique: async () => ({ nombres: 'Ana', apellidos: 'Gómez' }) },
      compra_detalle: { findFirst: async () => ({ id: 1 }) },
    },
    '../config/mongo': { conectar: async () => {} },
    '../models/mongo/Producto': {
      findOne: () => ({ select: async () => ({ _id: 'p', descripcion: 'Camiseta', subcategoria_id: 's', vendedor_id: 9, vendedor_nombre: 'Luis' }) }),
      updateOne: async () => { eventos.push('resumen'); },
    },
    '../models/mongo/Resena': {
      findOne: () => ({ select: async () => null }),
      create: async (datos) => ({ _id: 'r1', ...datos }),
      aggregate: async () => [{ promedio: 4.5, cantidad: 2 }],
    },
    './fraudeSyncService': { registrarResena: async () => {} },
    './ofertaDatosService': { invalidar: async (id) => { eventos.push(`invalidar:${id}`); } },
  });

  await servicio.crear({ id_usuario: 3, rol: 'comprador' }, 5, { calificacion: 5, comentario: 'Muy buena' });
  assert.equal(eventos.join(','), 'resumen,invalidar:5', 'el resumen se escribe primero y luego se invalida la copia, para que la regeneración ya lo lea nuevo');
});

test('la reconciliación del inventario invalida solo las ofertas activas', async () => {
  const invalidados = [];
  const escritos = [];
  const servicio = cargar('../src/services/catalogoSyncService.js', {
    '../config/prisma': {
      inventario: {
        findMany: async () => [
          { id_producto: 1, precio: '12.50', cantidad: 3 },
          { id_producto: 2, precio: '5', cantidad: 1 },
        ],
      },
    },
    '../config/mongo': { conectar: async () => {} },
    '../models/mongo/Producto': {
      find: () => ({
        select: async () => [
          { producto_id: 1, oferta_flash: { activo: true } }, // oferta activa: tiene copia en Redis
          { producto_id: 2, oferta_flash: { activo: false } }, // pausada: no hay copia
          { producto_id: 3 }, // sin inventario en MySQL: se omite
        ],
      }),
      updateOne: async (filtro) => { escritos.push(filtro.producto_id); },
    },
    './ofertaDatosService': { invalidar: async (id) => { invalidados.push(id); } },
  });

  const resultado = await servicio.recalcularInventario();
  assert.equal(resultado.productos_actualizados, 2);
  assert.equal(escritos.join(','), '1,2');
  assert.equal(invalidados.join(','), '1', 'solo la oferta activa tiene una copia que invalidar; no se crea una revisión por cada producto del catálogo');
});
