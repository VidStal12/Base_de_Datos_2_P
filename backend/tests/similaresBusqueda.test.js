const test = require('node:test');
const assert = require('node:assert/strict');
const { cargar } = require('./redisHelpers');
const reglas = require('../src/services/reglasRelacionados');

// busquedaService.similares() y las consultas que NO deben traer el vector, con un Elasticsearch de mentira: no
// abre conexiones. Lo que se prueba es la FORMA de las dos consultas (leer el vector, buscar vecinos) y las reglas
// de visibilidad que viajan dentro de la búsqueda; que el motor las cumpla de verdad lo comprueba
// scripts/verificarSimilares.js contra el Elasticsearch real.
const plano = (valor) => JSON.parse(JSON.stringify(valor));
const VECTOR = [0.6, 0.8, 0, 0];

function servicio({ origen, vecinos = [], suspendidos = [] }) {
  const peticiones = [];
  const es = {
    get: async (cuerpo) => {
      peticiones.push(['get', plano(cuerpo)]);
      if (!origen) throw Object.assign(new Error('not found'), { meta: { statusCode: 404 } });
      return { _id: String(cuerpo.id), found: true, _source: origen };
    },
    search: async (cuerpo) => {
      peticiones.push(['search', plano(cuerpo)]);
      return { hits: { hits: vecinos } };
    },
  };
  const modulo = cargar('../src/services/busquedaService.js', {
    '../config/elasticsearch': { conectar: async () => es, conCircuito: async (operacion) => operacion(es), indice: () => 'indice_de_prueba' },
    './suspensionService': { vendedoresSuspendidos: async () => new Set(suspendidos) },
  });
  return { ...modulo, peticiones };
}

const hit = (id, descripcion, vendedor_id, score) => ({
  _id: String(id),
  _score: score,
  _source: { nombre: `Polo ${id}`, descripcion, vendedor_id, vendedor_nombre: `Vendedor ${vendedor_id}`, estado: 'activo', precio: 10, cantidad: 3, categoria: 'Ropa', subcategoria: 'Camisetas', atributos: [] },
});

test('lee el vector del producto por id, pidiendo solo lo que necesita (y nunca la respuesta completa)', async () => {
  const s = servicio({ origen: { embedding: VECTOR, nombre: 'Polo', descripcion: 'Camiseta polo', vendedor_id: 2 } });
  await s.similares(7);
  const [tipo, pedido] = s.peticiones[0];
  assert.equal(tipo, 'get');
  assert.equal(pedido.id, '7');
  assert.deepEqual(pedido._source_includes, ['embedding', 'nombre', 'descripcion', 'vendedor_id']);
});

test('busca los vecinos con kNN sobre `embedding`, con el vector del propio producto y el coseno mínimo del diseño', async () => {
  const s = servicio({ origen: { embedding: VECTOR, nombre: 'Polo', descripcion: 'Camiseta polo', vendedor_id: 2 } });
  await s.similares(7);
  const [tipo, pedido] = s.peticiones[1];
  assert.equal(tipo, 'search');
  assert.equal(pedido.index, 'indice_de_prueba');
  assert.equal(pedido.knn.field, 'embedding');
  assert.deepEqual(pedido.knn.query_vector, VECTOR);
  assert.equal(pedido.knn.similarity, reglas.UMBRAL_COSENO);
  assert.equal(pedido.knn.k, reglas.CANDIDATOS);
  assert.equal(pedido.size, reglas.CANDIDATOS, 'sin `size` el motor devolvería solo 10 aunque k sea mayor');
  assert.ok(pedido.knn.num_candidates >= pedido.knn.k, 'num_candidates menor que k es un error del motor');
  assert.equal(pedido.query, undefined, 'solo kNN: sin una consulta de texto que mezcle puntajes');
});

test('la visibilidad va DENTRO de la búsqueda de vecinos: solo activos, sin el propio producto ni los vendedores suspendidos', async () => {
  const s = servicio({ origen: { embedding: VECTOR, nombre: 'Polo', descripcion: 'Camiseta polo', vendedor_id: 2 }, suspendidos: [8, 9] });
  await s.similares(7);
  const { filter } = s.peticiones[1][1].knn;
  assert.deepEqual(filter.bool.filter, [{ term: { estado: 'activo' } }, { exists: { field: 'nombre' } }]);
  assert.deepEqual(filter.bool.must_not, [{ term: { producto_id: 7 } }, { terms: { vendedor_id: [8, 9] } }]);
});

test('con sesión de vendedor se excluyen también sus propios productos (nadie compra lo que él mismo vende)', async () => {
  const s = servicio({ origen: { embedding: VECTOR, nombre: 'Polo', descripcion: 'Camiseta polo', vendedor_id: 2 } });
  await s.similares(7, { vendedorPropioId: 5 });
  assert.deepEqual(s.peticiones[1][1].knn.filter.bool.must_not, [{ term: { producto_id: 7 } }, { term: { vendedor_id: 5 } }]);
  const sinSesion = servicio({ origen: { embedding: VECTOR, nombre: 'Polo', descripcion: 'Camiseta polo', vendedor_id: 2 } });
  await sinSesion.similares(7);
  assert.deepEqual(sinSesion.peticiones[1][1].knn.filter.bool.must_not, [{ term: { producto_id: 7 } }]);
});

test('ninguna consulta de vecinos trae el vector de vuelta', async () => {
  const s = servicio({ origen: { embedding: VECTOR, nombre: 'Polo', descripcion: 'Camiseta polo', vendedor_id: 2 } });
  await s.similares(7);
  assert.deepEqual(s.peticiones[1][1]._source, { excludes: ['embedding'] });
});

test('devuelve los vecinos tal cual los dio el motor (del más parecido al menos), con la forma de un producto', async () => {
  const s = servicio({
    origen: { embedding: VECTOR, nombre: 'Polo', descripcion: 'Camiseta polo', vendedor_id: 2 },
    vecinos: [hit(3, 'Camiseta de algodón', 5, 0.97), hit(4, 'Camiseta roja', 2, 0.95)],
  });
  const r = plano(await s.similares(7));
  assert.deepEqual(r.origen, { id: 7, nombre: 'Polo', descripcion: 'Camiseta polo' });
  assert.equal(r.sinVector, false);
  assert.deepEqual(r.candidatos.map((p) => p.id), [3, 4]);
  assert.deepEqual(r.candidatos[0].inventario, { precio: 10, cantidad: 3 });
  assert.equal(r.candidatos[0].vendedor_id, 5);
  assert.equal(r.candidatos[0]._score, 0.97);
});

test('un producto sin vector (se indexó sin el modelo) no consulta vecinos: avisa `sinVector` para que otra capa decida', async () => {
  const s = servicio({ origen: { nombre: 'Polo', descripcion: 'Camiseta polo', vendedor_id: 2 } });
  const r = plano(await s.similares(7));
  assert.equal(r.sinVector, true);
  assert.deepEqual(r.candidatos, []);
  assert.deepEqual(s.peticiones.map(([tipo]) => tipo), ['get'], 'no se manda una búsqueda con un vector inexistente');
});

test('un producto que el índice no conoce es un 404, no una caída', async () => {
  const s = servicio({ origen: null });
  await assert.rejects(s.similares(99), (err) => err.status === 404 && /no encontrado/.test(err.message));
  assert.deepEqual(s.peticiones.map(([tipo]) => tipo), ['get']);
});

test('el producto de un vendedor suspendido «no existe» para el público, igual que su detalle: 404 y sin buscar vecinos', async () => {
  const s = servicio({ origen: { embedding: VECTOR, nombre: 'Polo', descripcion: 'Camiseta polo', vendedor_id: 8 }, suspendidos: [8] });
  await assert.rejects(s.similares(7), (err) => err.status === 404);
  assert.deepEqual(s.peticiones.map(([tipo]) => tipo), ['get']);
});

test('un error que no es un 404 no se disfraza: sube tal cual', async () => {
  const modulo = cargar('../src/services/busquedaService.js', {
    '../config/elasticsearch': { conCircuito: async () => { throw new Error('consulta mal armada'); }, indice: () => 'x' },
    './suspensionService': { vendedoresSuspendidos: async () => new Set() },
  });
  await assert.rejects(modulo.similares(7), /consulta mal armada/);
});

// ── Las demás consultas dejan el vector fuera: con él, la misma respuesta pesa 13 veces más ──

test('la búsqueda del catálogo excluye el vector de `_source` (con y sin facetas)', () => {
  const { construirPedido } = servicio({ origen: null });
  const filtros = { q: 'camiseta', pagina: 1, tamano: 20, atributos: {} };
  assert.deepEqual(plano(construirPedido(filtros)._source), { excludes: ['embedding'] });
  assert.deepEqual(plano(construirPedido(filtros, { conFacetas: false })._source), { excludes: ['embedding'] });
});

test('el detalle servido desde el índice (Mongo apagado) no trae el vector', async () => {
  const s = servicio({ origen: { nombre: 'Polo', descripcion: 'Camiseta polo', vendedor_id: 2, precio: 10, cantidad: 3, estado: 'activo' } });
  await s.obtenerDelIndice(7);
  assert.deepEqual(s.peticiones[0][1]._source_excludes, ['embedding']);
});

test('el autocompletado ya pedía solo el campo que usa: no trae el vector', async () => {
  const s = servicio({ origen: null });
  await s.sugerir('cam');
  assert.deepEqual(s.peticiones[0][1]._source, ['vendedor_id']);
});
