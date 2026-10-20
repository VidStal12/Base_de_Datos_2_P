const test = require('node:test');
const assert = require('node:assert/strict');
const { cargar } = require('./redisHelpers');
const { ServicioNoDisponible } = require('../src/utils/resiliencia');

// productoService.estadoPublicacion: ¿está publicado cada producto? El carrito y el checkout lo
// necesitan para no vender un producto inactivo. La fuente es Mongo; con Mongo apagado se
// pregunta al índice de búsqueda (que guarda una copia de esos campos) y solo si NINGUNO
// responde se informa la caída (IA/ENTREGA-3-CONSISTENCIA.md §7).
const plano = (valor) => JSON.parse(JSON.stringify(valor));

function servicio({ mongo, indice }) {
  const llamadas = [];
  const Producto = {
    find: (filtro) => ({
      select: () => ({
        lean: async () => {
          llamadas.push(['mongo', filtro.producto_id.$in]);
          return mongo(filtro.producto_id.$in);
        },
      }),
    }),
  };
  const modulo = cargar('../src/services/productoService.js', {
    '../config/prisma': {},
    '../config/mongo': { conectar: async () => { if (mongo.caido) throw new ServicioNoDisponible('mongo'); } },
    '../models/mongo/Producto': Producto,
    '../models/mongo/Subcategoria': {},
    '../models/mongo/ProductoEvento': {},
    './busquedaSyncService': {},
    './fraudeSyncService': {},
    './ofertaDatosService': {},
    './suspensionService': {},
    './busquedaService': {
      publicacionDelIndice: async (ids) => {
        llamadas.push(['indice', ids]);
        return indice(ids);
      },
    },
  });
  return { ...modulo, llamadas };
}

const DOCS = [
  { producto_id: 1, estado: 'activo', vendedor_id: 11, descripcion: 'Camiseta azul', imagenes: [{ principal: false, url: 'b.png' }, { principal: true, url: 'a.png' }] },
  { producto_id: 2, estado: 'inactivo', vendedor_id: 12, descripcion: 'Gorra', imagenes: [] },
];

test('con Mongo sano devuelve estado, vendedor, nombre e imagen principal, y el índice no se toca', async () => {
  const mongo = (ids) => DOCS.filter((d) => ids.includes(d.producto_id));
  const s = servicio({ mongo, indice: () => assert.fail('no debe consultar el índice') });
  const m = await s.estadoPublicacion([1, 2]);
  assert.deepEqual(plano([...m]), [
    [1, { estado: 'activo', vendedor_id: 11, descripcion: 'Camiseta azul', imagen_url: 'a.png' }],
    [2, { estado: 'inactivo', vendedor_id: 12, descripcion: 'Gorra', imagen_url: '' }],
  ]);
  assert.deepEqual(s.llamadas.map(([quien]) => quien), ['mongo']);
});

test('con Mongo apagado se pregunta al índice de búsqueda y la compra puede seguir', async () => {
  const mongo = () => assert.fail('Mongo está apagado: ni se le pregunta');
  mongo.caido = true;
  const delIndice = new Map([[1, { estado: 'activo', vendedor_id: 11, descripcion: 'Camiseta azul', imagen_url: 'a.png' }]]);
  const s = servicio({ mongo, indice: () => delIndice });
  const m = await s.estadoPublicacion([1, 99]);
  assert.equal(m.get(1).estado, 'activo');
  assert.equal(m.has(99), false, 'un producto que el índice no conoce no figura: se trata como no disponible, no como publicado');
  assert.deepEqual(s.llamadas.map(([quien]) => quien), ['indice']);
});

test('con Mongo e índice apagados se informa la caída del catálogo: sin saber si está publicado no se vende', async () => {
  const mongo = () => assert.fail('apagado');
  mongo.caido = true;
  const s = servicio({ mongo, indice: () => { throw new ServicioNoDisponible('elasticsearch'); } });
  await assert.rejects(s.estadoPublicacion([1]), (err) => err instanceof ServicioNoDisponible && err.componente === 'mongo');
});

test('un error que no es una caída de Mongo se propaga tal cual y no se busca un respaldo', async () => {
  const mongo = () => { throw new Error('esquema inválido'); };
  const s = servicio({ mongo, indice: () => assert.fail('no debe consultar el índice') });
  await assert.rejects(s.estadoPublicacion([1]), /esquema inválido/);
});
