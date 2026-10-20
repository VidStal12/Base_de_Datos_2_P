const test = require('node:test');
const assert = require('node:assert/strict');
const { cargar } = require('./redisHelpers');
const { ServicioNoDisponible } = require('../src/utils/resiliencia');

// compraService: el pedido es de MySQL y se muestra completo aunque el catálogo no esté. MySQL
// guarda de cada línea solo el producto como ancla; el nombre y la imagen salen del catálogo
// (Mongo, o su copia en el índice) y, si no responde ninguno, la línea se identifica por su número.
const plano = (valor) => JSON.parse(JSON.stringify(valor));

const COMPRA = {
  id: 306, id_usuario: 7, total: '300',
  compra_detalles: [
    { id: 1, id_producto: 125, cantidad: 1, producto: { id: 125, id_vendedor: 51 } },
    { id: 2, id_producto: 9, cantidad: 2, producto: { id: 9, id_vendedor: 5 } },
  ],
  pagos: [], direccion: {},
};

function servicio(estadoPublicacion) {
  const consultas = [];
  const modulo = cargar('../src/services/compraService.js', {
    '../config/prisma': {
      compra: {
        findMany: async () => [COMPRA],
        findUnique: async ({ where }) => (where.id === 306 ? COMPRA : null),
      },
    },
    './productoService': { estadoPublicacion: async (ids) => { consultas.push([...ids]); return estadoPublicacion(ids); } },
  });
  return { ...modulo, consultas };
}

const CATALOGO = new Map([
  [125, { descripcion: 'Camiseta azul', imagen_url: 'a.png' }],
  [9, { descripcion: 'Taza', imagen_url: '' }],
]);

test('cada línea del pedido trae el nombre y la imagen de su producto, con UNA sola consulta al catálogo', async () => {
  const s = servicio(() => CATALOGO);
  const pedido = plano(await s.obtener(7, 306));
  assert.deepEqual(pedido.compra_detalles.map((d) => [d.producto.descripcion, d.producto.imagen_url, d.producto.id_vendedor]), [['Camiseta azul', 'a.png', 51], ['Taza', '', 5]]);
  assert.deepEqual(s.consultas, [[125, 9]]);
  const lista = plano(await s.listarPorUsuario(7));
  assert.equal(lista[0].compra_detalles[0].producto.descripcion, 'Camiseta azul');
});

test('con el catálogo apagado (Mongo y su copia) el pedido se muestra igual, con cada producto por su número', async () => {
  const s = servicio(() => { throw new ServicioNoDisponible('mongo'); });
  const pedido = plano(await s.obtener(7, 306));
  assert.deepEqual(pedido.compra_detalles.map((d) => d.producto.descripcion), ['Producto #125', 'Producto #9']);
  assert.equal(pedido.total, '300', 'el resto del pedido, de MySQL, no cambia');
});

test('un error que no es una caída del catálogo no se esconde', async () => {
  const s = servicio(() => { throw new Error('esquema inválido'); });
  await assert.rejects(s.obtener(7, 306), /esquema inválido/);
});

test('un pedido ajeno o inexistente sigue siendo «no encontrado»', async () => {
  const s = servicio(() => CATALOGO);
  await assert.rejects(s.obtener(8, 306), /Pedido no encontrado/);
  await assert.rejects(s.obtener(7, 999), /Pedido no encontrado/);
});
