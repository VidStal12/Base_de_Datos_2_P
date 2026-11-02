const test = require('node:test');
const assert = require('node:assert/strict');
const { cargar } = require('./redisHelpers');
const { textosProducto } = require('../src/utils/textosProducto');

const vendedor = { id_usuario: 9, rol: 'vendedor' };
const alta = { nombre: '  Nube  ', descripcion: '  Abriga en días fríos.  ', subcategoriaId: 'sub', precio: 100, cantidad: 2 };

function catalogo() {
  let doc;
  const eventos = [], indexados = [];
  const servicio = cargar('../src/services/productoService.js', {
    '../config/mongo': { conectar: async () => {} },
    '../config/prisma': {
      producto: {
        create: async () => ({ id: 1, vendedor: { nombres: 'Ada', apellidos: 'Luna' } }),
        findUnique: async () => ({ id_vendedor: vendedor.id_usuario }),
      },
      inventario: { findUnique: async () => ({ precio: 100, cantidad: 2 }) },
    },
    '../models/mongo/Subcategoria': { findById: async () => ({ _id: 'sub' }) },
    '../models/mongo/Producto': {
      create: async (datos) => (doc = { ...datos, save: async () => {} }),
      findOne: () => Object.assign(Promise.resolve(doc), { populate: () => ({ lean: async () => doc }) }),
    },
    '../models/mongo/ProductoEvento': { create: async (ev) => eventos.push(ev) },
    './busquedaSyncService': { indexarProducto: async (p) => indexados.push(p) },
    './fraudeSyncService': { registrarProducto: async () => {} },
    './ofertaDatosService': { actualizar: async () => {} },
    './suspensionService': {},
  });
  return { servicio, eventos, indexados };
}

test('alta y ediciones independientes: la API, el historial y el índice reciben ambos textos', async () => {
  const { servicio, eventos, indexados } = catalogo();
  const nuevo = await servicio.crear(vendedor, alta);
  const renombrado = await servicio.actualizar(vendedor, nuevo.id, { nombre: 'Bruma' });
  const descrito = await servicio.actualizar(vendedor, nuevo.id, { descripcion: 'Tejido de lana.' });
  const par = (p) => [p.nombre, p.descripcion];
  const esperados = [['Nube', 'Abriga en días fríos.'], ['Bruma', 'Abriga en días fríos.'], ['Bruma', 'Tejido de lana.']];
  assert.deepEqual([nuevo, renombrado, descrito].map(par), esperados);
  assert.deepEqual(eventos.map((ev) => par(ev.snapshot)), esperados);
  assert.deepEqual(indexados.map(par), esperados);
  assert.deepEqual(eventos.map((ev) => Array.from(ev.campos_modificados)), [[], ['nombre'], ['descripcion']]);
});

test('un texto ausente, vacío o no textual no genera una versión parcial', async () => {
  const { servicio, eventos } = catalogo();
  for (const campo of ['nombre', 'descripcion']) {
    for (const valor of [undefined, '   ', 123]) {
      await assert.rejects(servicio.crear(vendedor, { ...alta, [campo]: valor }), /obligatori/);
    }
    await assert.rejects(servicio.actualizar(vendedor, 1, { precio: 90, [campo]: ' ' }), /vacío|vacía/);
  }
  assert.equal(eventos.length, 0);
});

test('un snapshot antiguo conserva íntegro su título sin inventar una descripción retrospectiva', () => {
  const anterior = Object.freeze({ descripcion: 'Polo - colección original' });
  assert.deepEqual(textosProducto(anterior), { nombre: anterior.descripcion, descripcion: '' });
});
