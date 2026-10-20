const test = require('node:test');
const assert = require('node:assert/strict');
const { cargar } = require('./redisHelpers');
const { ServicioNoDisponible } = require('../src/utils/resiliencia');

// catalogoLecturaService: el catálogo se sigue sirviendo cuando se apaga Mongo o
// Elasticsearch, porque cada uno guarda una copia de lo que el otro muestra
// (IA/ENTREGA-3-CONSISTENCIA.md §7). Lo que se prueba es la DECISIÓN — a quién se le pregunta,
// cuándo se cae al respaldo y cuándo NO — con dobles de los servicios; contra los contenedores
// reales lo cubre la medición en vivo del mismo documento.
const plano = (valor) => JSON.parse(JSON.stringify(valor));
const caidaMongo = () => new ServicioNoDisponible('mongo');
const caidaElastic = () => new ServicioNoDisponible('elasticsearch');

const PRODUCTOS = [
  { id: 1, descripcion: 'Camiseta azul', subcategoria: { subcategoria: 'Camisetas', categoria: 'Ropa' }, atributos: [{ nombre: 'Talla', valor: 'M' }, { nombre: 'Color', valor: 'Azul' }] },
  { id: 2, descripcion: 'Camiseta roja', subcategoria: { subcategoria: 'Camisetas', categoria: 'Ropa' }, atributos: [{ nombre: 'Talla', valor: 'M' }, { nombre: 'Color', valor: 'Rojo' }] },
  { id: 3, descripcion: 'Taza', subcategoria: { subcategoria: 'Vajilla', categoria: 'Hogar' }, atributos: [] },
];

function servicio({ busqueda = {}, producto = {}, categoria = {}, suspendidos = [], docs = [] } = {}) {
  const llamadas = [];
  const registrar = (nombre, respuesta) => async (...args) => {
    llamadas.push(nombre);
    return typeof respuesta === 'function' ? respuesta(...args) : respuesta;
  };
  const Producto = {
    find: (filtro) => ({
      select: () => ({
        limit: () => ({
          lean: async () => {
            llamadas.push(['Producto.find', filtro]);
            return docs.filter((d) => filtro.descripcion.test(d.descripcion) && (!filtro.vendedor_id || !filtro.vendedor_id.$nin.includes(d.vendedor_id)));
          },
        }),
      }),
    }),
  };
  const modulo = cargar('../src/services/catalogoLecturaService.js', {
    './busquedaService': {
      buscar: registrar('es.buscar', busqueda.buscar ?? { resultados: [], total: 0, facetas: {}, categorias: [], subcategorias: [] }),
      sugerir: registrar('es.sugerir', busqueda.sugerir ?? []),
      listarDesdeIndice: registrar('es.listar', busqueda.listarDesdeIndice ?? []),
      obtenerDelIndice: registrar('es.obtener', busqueda.obtenerDelIndice ?? { id: 0 }),
      categoriasDelIndice: registrar('es.categorias', busqueda.categoriasDelIndice ?? []),
    },
    './productoService': {
      listar: registrar('mongo.listar', producto.listar ?? PRODUCTOS),
      obtener: registrar('mongo.obtener', producto.obtener ?? { id: 1 }),
    },
    './categoriaService': { listar: registrar('mongo.categorias', categoria.listar ?? []) },
    './suspensionService': { vendedoresSuspendidos: async () => new Set(suspendidos) },
    '../models/mongo/Producto': Producto,
    '../config/mongo': { conectar: async () => {} },
  });
  return { ...modulo, llamadas };
}

// ── Elasticsearch apagado: la búsqueda cae a Mongo ──────────────────────────

test('con Elasticsearch sano la búsqueda es la de siempre y Mongo no se toca', async () => {
  const s = servicio({ busqueda: { buscar: { resultados: [{ id: 9 }], total: 1, facetas: {}, categorias: [], subcategorias: [] } } });
  const r = plano(await s.buscar({ q: 'camiseta' }));
  assert.deepEqual(r.resultados, [{ id: 9 }]);
  assert.equal(r.modo, undefined);
  assert.deepEqual(s.llamadas, ['es.buscar']);
});

test('con Elasticsearch apagado la búsqueda sigue: texto sobre Mongo, con facetas y conteos, marcada como básica', async () => {
  const s = servicio({ busqueda: { buscar: () => { throw caidaElastic(); } } });
  const r = plano(await s.buscar({ q: 'camiseta', ordenarPor: 'masVendidos' }));
  assert.equal(r.modo, 'basico', 'la interfaz avisa que no hay tolerancia a errores de tipeo');
  assert.equal(r.total, 3);
  assert.deepEqual(r.resultados.map((p) => p.id), [1, 2, 3]);
  assert.deepEqual(r.facetas, { Talla: ['M'], Color: ['Azul', 'Rojo'] }, 'misma forma que la agregación de Elasticsearch');
  assert.deepEqual(r.categorias, [{ nombre: 'Ropa', cantidad: 2 }, { nombre: 'Hogar', cantidad: 1 }]);
  assert.deepEqual(r.subcategorias, [{ nombre: 'Camisetas', cantidad: 2 }, { nombre: 'Vajilla', cantidad: 1 }]);
  assert.deepEqual(s.llamadas, ['es.buscar', 'mongo.listar']);
});

test('un error que NO es una caída de Elasticsearch no se esconde detrás de un resultado alternativo', async () => {
  const s = servicio({ busqueda: { buscar: () => { throw new Error('consulta mal armada'); } } });
  await assert.rejects(s.buscar({ q: 'x' }), /consulta mal armada/);
  assert.deepEqual(s.llamadas, ['es.buscar']);
});

test('con Elasticsearch Y Mongo apagados se informa la caída del buscador (el origen), no la del respaldo', async () => {
  const s = servicio({ busqueda: { buscar: () => { throw caidaElastic(); } }, producto: { listar: () => { throw caidaMongo(); } } });
  await assert.rejects(s.buscar({ q: 'x' }), (err) => err.componente === 'elasticsearch');
});

test('el autocompletado cae a Mongo por prefijo, sin los vendedores suspendidos, sin repetidos y con a lo sumo 8', async () => {
  const docs = Array.from({ length: 12 }, (_, i) => ({ descripcion: `Camiseta ${i % 10}`, vendedor_id: i < 2 ? 7 : 8 }));
  const s = servicio({ busqueda: { sugerir: () => { throw caidaElastic(); } }, suspendidos: [7], docs });
  const sugerencias = plano(await s.sugerir('camis'));
  assert.equal(sugerencias.length, 8);
  assert.equal(new Set(sugerencias).size, 8, 'sin repetidos');
  assert.ok(!sugerencias.includes('Camiseta 0') && !sugerencias.includes('Camiseta 1'), 'las del vendedor suspendido no se sugieren');
  const [, filtro] = s.llamadas.find((l) => Array.isArray(l));
  assert.equal(filtro.estado, 'activo');
  assert.ok(filtro.descripcion.test('CAMISETA roja') && !filtro.descripcion.test('una camiseta'), 'prefijo, sin distinguir mayúsculas');
  assert.deepEqual(plano(await servicio({ busqueda: { sugerir: () => { throw caidaElastic(); } } }).sugerir('   ')), [], 'un texto vacío no consulta nada');
});

test('el texto de las sugerencias es literal: un paréntesis suelto no rompe la consulta', async () => {
  const s = servicio({ busqueda: { sugerir: () => { throw caidaElastic(); } }, docs: [{ descripcion: 'Camiseta (azul)', vendedor_id: 1 }] });
  assert.deepEqual(plano(await s.sugerir('camiseta (a')), ['Camiseta (azul)']);
});

// ── Mongo apagado: el catálogo se lee del índice ────────────────────────────

test('con Mongo sano el catálogo es el de siempre y el índice no se toca', async () => {
  const s = servicio();
  assert.deepEqual(plano(await s.listar({})).map((p) => p.id), [1, 2, 3]);
  assert.deepEqual(plano(await s.categorias()), []);
  assert.deepEqual(s.llamadas, ['mongo.listar', 'mongo.categorias']);
});

test('con Mongo apagado el catálogo, el detalle y las categorías salen del índice de búsqueda', async () => {
  const s = servicio({
    producto: { listar: () => { throw caidaMongo(); }, obtener: () => { throw caidaMongo(); } },
    categoria: { listar: () => { throw caidaMongo(); } },
    busqueda: {
      listarDesdeIndice: [{ id: 5, descripcion: 'Desde el índice' }],
      obtenerDelIndice: { id: 5, descripcion: 'Desde el índice' },
      categoriasDelIndice: [{ id: 'c1', categoria: 'Ropa', subcategorias: [] }],
    },
  });
  assert.deepEqual(plano(await s.listar({ q: 'x' })), [{ id: 5, descripcion: 'Desde el índice' }]);
  const detalle = plano(await s.obtener(5));
  assert.equal(detalle.descripcion, 'Desde el índice');
  assert.equal(detalle.desde_indice, true, 'la pantalla avisa que reseñas, historial y oferta flash no están');
  assert.deepEqual(plano(await s.categorias()), [{ id: 'c1', categoria: 'Ropa', subcategorias: [] }]);
});

test('las ofertas flash viven en Mongo (y su cupo en Redis): sin Mongo no hay lista de ofertas, no una lista equivocada', async () => {
  const s = servicio({ producto: { listar: () => { throw caidaMongo(); } } });
  assert.deepEqual(plano(await s.listar({ soloOfertas: 'true' })), []);
  assert.deepEqual(s.llamadas, ['mongo.listar'], 'ni se consulta el índice');
});

test('con Mongo e índice apagados se informa la caída del catálogo; un producto que el índice no conoce, también', async () => {
  const s = servicio({
    producto: { listar: () => { throw caidaMongo(); }, obtener: () => { throw caidaMongo(); } },
    busqueda: { listarDesdeIndice: () => { throw caidaElastic(); }, obtenerDelIndice: () => { throw Object.assign(new Error('Producto no encontrado'), { status: 404 }); } },
  });
  await assert.rejects(s.listar({}), (err) => err.componente === 'mongo');
  await assert.rejects(s.obtener(99), (err) => err.componente === 'mongo', 'sin Mongo no se puede afirmar que no exista');
});

test('un producto inexistente con Mongo sano sigue siendo un error normal, no una caída', async () => {
  const s = servicio({ producto: { obtener: () => { throw Object.assign(new Error('Producto no encontrado'), { status: 404 }); } } });
  await assert.rejects(s.obtener(99), (err) => err.status === 404 && /no encontrado/.test(err.message));
  assert.deepEqual(s.llamadas, ['mongo.obtener'], 'y el índice no se consulta');
});
