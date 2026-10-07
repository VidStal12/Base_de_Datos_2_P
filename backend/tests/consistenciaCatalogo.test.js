const test = require('node:test');
const assert = require('node:assert/strict');
const { cargar } = require('./redisHelpers');

// La reparación de la copia del catálogo en Mongo (catalogoSyncService.js): lo que el
// administrador dispara con "recalcular" y lo que la demo de consistencia del checkout
// (scripts/demo_consistencia_compra.js) usa para mostrar cómo se cierra la ventana que deja
// un reenvío a Mongo fallido. MySQL es la autoridad; Mongo, la copia que se sobrescribe.
//
// Lo que sale del vm viene de OTRO reino: se aplana antes de comparar.
const plano = (valor) => JSON.parse(JSON.stringify(valor));

// Tres productos con la copia de Mongo DESFASADA (lo que deja un reenvío fallido):
//   1 y 2 vendieron más de lo que Mongo cuenta y tienen más stock en Mongo que en MySQL;
//   3 está bien; 9 existe en Mongo y no en MySQL (huérfano).
function escenario({ ofertaActiva = [] } = {}) {
  const inventarios = [
    { id_producto: 1, precio: 100, cantidad: 8 },
    { id_producto: 2, precio: 50, cantidad: 3 },
    { id_producto: 3, precio: 20, cantidad: 5 },
  ];
  const detalles = [
    { id_producto: 1, cantidad: 2 }, { id_producto: 1, cantidad: 1 },
    { id_producto: 2, cantidad: 4 },
    { id_producto: 3, cantidad: 7 },
  ];
  const docs = [
    { producto_id: 1, total_vendido: 1, inventario: { precio: 100, cantidad: 9 }, oferta_flash: { activo: ofertaActiva.includes(1) } },
    { producto_id: 2, total_vendido: 0, inventario: { precio: 50, cantidad: 4 }, oferta_flash: { activo: ofertaActiva.includes(2) } },
    { producto_id: 3, total_vendido: 7, inventario: { precio: 20, cantidad: 5 }, oferta_flash: { activo: false } },
    { producto_id: 9, total_vendido: 0, inventario: { precio: 10, cantidad: 1 }, oferta_flash: { activo: false } },
  ];
  const invalidadas = [];
  const prisma = {
    compra_detalle: {
      async groupBy({ where }) {
        const permitidos = where?.id_producto?.in;
        const sumas = new Map();
        for (const d of detalles) {
          if (permitidos && !permitidos.includes(d.id_producto)) continue;
          sumas.set(d.id_producto, (sumas.get(d.id_producto) || 0) + d.cantidad);
        }
        return [...sumas].map(([id_producto, cantidad]) => ({ id_producto, _sum: { cantidad } }));
      },
    },
    inventario: {
      async findMany(args) {
        const permitidos = args?.where?.id_producto?.in;
        return inventarios.filter((inv) => !permitidos || permitidos.includes(inv.id_producto));
      },
    },
  };
  const Producto = {
    find(filtro = {}) {
      const permitidos = filtro.producto_id?.$in;
      const elegidos = docs.filter((d) => !permitidos || permitidos.includes(d.producto_id));
      return { select: async () => elegidos.map((d) => ({ producto_id: d.producto_id, oferta_flash: d.oferta_flash })) };
    },
    async updateOne({ producto_id }, { $set }) {
      const doc = docs.find((d) => d.producto_id === producto_id);
      for (const [campo, valor] of Object.entries($set)) {
        if (campo === 'total_vendido') doc.total_vendido = valor;
        else if (campo === 'inventario.precio') doc.inventario.precio = valor;
        else if (campo === 'inventario.cantidad') doc.inventario.cantidad = valor;
        else throw new Error(`Campo no soportado por el doble: ${campo}`);
      }
    },
  };
  const servicio = cargar('../src/services/catalogoSyncService.js', {
    '../config/prisma': prisma,
    '../config/mongo': { conectar: async () => {} },
    '../models/mongo/Producto': Producto,
    './ofertaDatosService': { invalidar: async (id) => { invalidadas.push(id); } },
  });
  const copia = (id) => plano(docs.find((d) => d.producto_id === id));
  return { servicio, copia, invalidadas };
}

test('sin productoIds (el botón del administrador) reconcilia TODOS los productos desde MySQL', async () => {
  const e = escenario();
  const ventas = plano(await e.servicio.recalcularVentas());
  const inventario = plano(await e.servicio.recalcularInventario());
  assert.deepEqual([e.copia(1).total_vendido, e.copia(2).total_vendido, e.copia(3).total_vendido], [3, 4, 7], 'total_vendido = la suma real de compra_detalle');
  assert.deepEqual([e.copia(1).inventario.cantidad, e.copia(2).inventario.cantidad, e.copia(3).inventario.cantidad], [8, 3, 5], 'cantidad = la de MySQL');
  assert.equal(ventas.productos_actualizados, 4, 'recalcularVentas recorre todos los documentos (el huérfano queda en 0)');
  assert.equal(e.copia(9).total_vendido, 0);
  assert.deepEqual(inventario, { productos_actualizados: 3, productos_omitidos: [9] }, 'el huérfano de Mongo se informa y no se toca');
  assert.equal(e.copia(9).inventario.cantidad, 1);
});

test('con productoIds reconcilia SOLO esos: el desvío de los demás queda como estaba', async () => {
  const e = escenario();
  const ventas = plano(await e.servicio.recalcularVentas({ productoIds: [1] }));
  const inventario = plano(await e.servicio.recalcularInventario({ productoIds: [1] }));
  assert.equal(e.copia(1).total_vendido, 3);
  assert.equal(e.copia(1).inventario.cantidad, 8);
  assert.equal(e.copia(2).total_vendido, 0, 'el producto 2 también estaba desfasado y NO se toca');
  assert.equal(e.copia(2).inventario.cantidad, 4);
  assert.deepEqual(ventas, { productos_actualizados: 1 });
  assert.deepEqual(inventario, { productos_actualizados: 1, productos_omitidos: [] });
});

test('es idempotente: correrlo otra vez no cambia nada (recalcula la suma real, no incrementa a ciegas)', async () => {
  const e = escenario();
  await e.servicio.recalcularVentas({ productoIds: [1, 2] });
  await e.servicio.recalcularInventario({ productoIds: [1, 2] });
  const primera = [e.copia(1), e.copia(2)];
  await e.servicio.recalcularVentas({ productoIds: [1, 2] });
  await e.servicio.recalcularInventario({ productoIds: [1, 2] });
  assert.deepEqual([e.copia(1), e.copia(2)], primera);
});

test('una oferta flash activa se invalida solo en los productos que se reconcilian', async () => {
  const e = escenario({ ofertaActiva: [1, 2] });
  await e.servicio.recalcularInventario({ productoIds: [1] });
  assert.deepEqual(plano(e.invalidadas), [1], 'la copia de Redis de la oferta del producto 2 no se invalida: no se tocó su precio');
  await e.servicio.recalcularInventario();
  assert.deepEqual(plano(e.invalidadas).sort(), [1, 1, 2]);
});
