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

const ROPA = 'cat-ropa';
const HOGAR = 'cat-hogar';
const CAMISETAS = 'sub-camisetas';
const VAJILLA = 'sub-vajilla';
const subCamisetas = { id: CAMISETAS, subcategoria: 'Camisetas', categoria_id: ROPA, categoria: 'Ropa' };
const PRODUCTOS = [
  { id: 1, descripcion: 'Camiseta azul', total_vendido: 5, inventario: { precio: 50, cantidad: 9 }, subcategoria: subCamisetas, atributos: [{ nombre: 'Talla', valor: 'M' }, { nombre: 'Color', valor: 'Azul' }] },
  { id: 2, descripcion: 'Camiseta roja', total_vendido: 9, inventario: { precio: 60, cantidad: 9 }, subcategoria: subCamisetas, atributos: [{ nombre: 'Talla', valor: 'M' }, { nombre: 'Color', valor: 'Rojo' }] },
  { id: 3, descripcion: 'Taza', total_vendido: 1, inventario: { precio: 15, cantidad: 9 }, subcategoria: { id: VAJILLA, subcategoria: 'Vajilla', categoria_id: HOGAR, categoria: 'Hogar' }, atributos: [] },
];

function servicio({ busqueda = {}, producto = {}, categoria = {}, suspendidos = [], docs = [], existencias = [], mongoCaido = false } = {}) {
  const llamadas = [];
  const registrar = (nombre, respuesta) => async (...args) => {
    llamadas.push(nombre);
    return typeof respuesta === 'function' ? respuesta(...args) : respuesta;
  };
  // Dos usos del modelo: las sugerencias (find().select().limit().lean(), por prefijo de descripción) y la
  // relectura del stock de los resultados (find().select().lean(), por producto_id).
  const Producto = {
    find: (filtro) => ({
      select: () => ({
        limit: () => ({
          lean: async () => {
            llamadas.push(['Producto.find', filtro]);
            return docs.filter((d) => filtro.descripcion.test(d.descripcion) && (!filtro.vendedor_id || !filtro.vendedor_id.$nin.includes(d.vendedor_id)));
          },
        }),
        lean: async () => {
          llamadas.push('mongo.existencias');
          return existencias.filter((d) => filtro.producto_id.$in.includes(d.producto_id));
        },
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
    '../config/mongo': { conectar: async () => { if (mongoCaido) throw caidaMongo(); } },
  });
  return { ...modulo, llamadas };
}

// ── Elasticsearch apagado: la búsqueda cae a Mongo ──────────────────────────

test('con Elasticsearch sano la búsqueda es la de siempre; Mongo solo se consulta para releer el stock de la página', async () => {
  const s = servicio({ busqueda: { buscar: { resultados: [{ id: 9, inventario: { precio: 5, cantidad: 3 }, total_vendido: 1 }], total: 1, facetas: {}, categorias: [], subcategorias: [] } }, existencias: [] });
  const r = plano(await s.buscar({ q: 'camiseta' }));
  assert.deepEqual(r.resultados.map((p) => p.id), [9]);
  assert.equal(r.modo, undefined);
  assert.deepEqual(s.llamadas, ['es.buscar', 'mongo.existencias']);
});

// ── El índice va atrasado en stock y ventas: se releen de Mongo ─────────────

const RESPUESTA_INDICE = {
  resultados: [
    { id: 1, descripcion: 'Camiseta azul', inventario: { precio: 50, cantidad: 21 }, total_vendido: 153 },
    { id: 2, descripcion: 'Camiseta roja', inventario: { precio: 60, cantidad: 9 }, total_vendido: 9 },
  ],
  total: 2, pagina: 1, tamano: 60, paginas: 1, arbol: [], ruta: [], atributos: [], precio: {}, filtros: {}, facetas: {}, categorias: [], subcategorias: [],
};

test('el stock y las ventas de cada tarjeta salen de Mongo, que los descuenta en cada compra; el resto del producto, del índice', async () => {
  const s = servicio({ busqueda: { buscar: RESPUESTA_INDICE }, existencias: [{ producto_id: 1, inventario: { cantidad: 17 }, total_vendido: 157 }] });
  const r = plano(await s.buscar({ q: 'camiseta' }));
  assert.deepEqual(r.resultados.map((p) => [p.id, p.inventario.cantidad, p.total_vendido, p.inventario.precio]), [[1, 17, 157, 50], [2, 9, 9, 60]], 'el #1 se actualiza; el #2, que Mongo no devolvió, queda como estaba');
  assert.equal(r.total, 2);
  assert.deepEqual(s.llamadas, ['es.buscar', 'mongo.existencias'], 'una sola consulta a Mongo para toda la página');
});

test('sin Mongo la búsqueda no falla: se muestran el stock y las ventas del índice', async () => {
  const s = servicio({ busqueda: { buscar: RESPUESTA_INDICE }, mongoCaido: true });
  const r = plano(await s.buscar({ q: 'camiseta' }));
  assert.deepEqual(r.resultados.map((p) => p.inventario.cantidad), [21, 9]);
});

test('una página sin resultados no consulta a Mongo, y el respaldo (que ya viene de Mongo) tampoco relee nada', async () => {
  const vacia = servicio({ busqueda: { buscar: { ...RESPUESTA_INDICE, resultados: [], total: 0 } } });
  await vacia.buscar({ q: 'zzz' });
  assert.deepEqual(vacia.llamadas, ['es.buscar']);
  const respaldo = servicio({ busqueda: { buscar: () => { throw caidaElastic(); } } });
  await respaldo.buscar({ q: 'camiseta' });
  assert.deepEqual(respaldo.llamadas, ['es.buscar', 'mongo.listar'], 'sin "mongo.existencias"');
});

// ── Un índice vacío no deja la portada en blanco ────────────────────────────

const INDICE_VACIO = { ...RESPUESTA_INDICE, resultados: [], total: 0 };

test('la portada con el índice VACÍO (Elasticsearch recién creado, sin backfill) se sirve desde Mongo', async () => {
  const s = servicio({ busqueda: { buscar: INDICE_VACIO } });
  const r = plano(await s.buscar({}));
  assert.equal(r.total, 3);
  assert.equal(r.modo, 'basico');
  assert.deepEqual(s.llamadas, ['es.buscar', 'mongo.listar']);
  const categoria = servicio({ busqueda: { buscar: INDICE_VACIO } });
  assert.equal(plano(await categoria.buscar({ categoriaId: ROPA })).total, 2, 'también una categoría sin otros filtros');
});

test('con filtros o texto, cero resultados es una respuesta legítima: no se busca en Mongo', async () => {
  for (const opciones of [{ q: 'zzz' }, { atributos: '{"Talla":"XXL"}' }, { precioMin: '99999' }, { pagina: '3' }]) {
    const s = servicio({ busqueda: { buscar: INDICE_VACIO } });
    assert.equal(plano(await s.buscar(opciones)).total, 0, JSON.stringify(opciones));
    assert.deepEqual(s.llamadas, ['es.buscar'], JSON.stringify(opciones));
  }
});

test('si Mongo tampoco tiene productos, o está apagado, la portada responde lo que dijo el índice', async () => {
  const sinProductos = servicio({ busqueda: { buscar: INDICE_VACIO }, producto: { listar: [] } });
  assert.equal(plano(await sinProductos.buscar({})).total, 0);
  const sinMongo = servicio({ busqueda: { buscar: INDICE_VACIO }, producto: { listar: () => { throw caidaMongo(); } } });
  const r = plano(await sinMongo.buscar({}));
  assert.equal(r.total, 0);
  assert.equal(r.modo, undefined, 'sigue siendo la respuesta del motor');
});

test('con Elasticsearch apagado la búsqueda sigue: texto sobre Mongo, con árbol, precio y conteos, marcada como básica', async () => {
  const s = servicio({ busqueda: { buscar: () => { throw caidaElastic(); } } });
  const r = plano(await s.buscar({ q: 'camiseta', ordenarPor: 'masVendidos' }));
  assert.equal(r.modo, 'basico', 'la interfaz avisa que no hay tolerancia a errores de tipeo');
  assert.equal(r.total, 3);
  assert.deepEqual(r.resultados.map((p) => p.id), [2, 1, 3], 'más vendidos primero, ordenado acá y no en Mongo');
  assert.deepEqual(r.arbol.map((c) => [c.nombre, c.cantidad, c.subcategorias.map((x) => [x.nombre, x.cantidad])]), [['Hogar', 1, [['Vajilla', 1]]], ['Ropa', 2, [['Camisetas', 2]]]]);
  assert.deepEqual(r.atributos, [], 'el contexto abarca dos subcategorías: los atributos se ofrecen al elegir una');
  assert.deepEqual(r.precio, { min: 15, max: 60, rangos: [{ desde: 10, hasta: 20, cantidad: 1 }, { desde: 50, hasta: 100, cantidad: 2 }] });
  assert.deepEqual(s.llamadas, ['es.buscar', 'mongo.listar']);
});

test('el respaldo le pide a Mongo SOLO el texto y calcula las facetas disyuntivas en memoria, con la forma del motor', async () => {
  let pedido;
  const s = servicio({ busqueda: { buscar: () => { throw caidaElastic(); } }, producto: { listar: (o) => { pedido = o; return PRODUCTOS; } } });
  const r = plano(await s.buscar({ q: 'camiseta', subcategoriaId: CAMISETAS, atributos: JSON.stringify({ Talla: ['M'] }), precioMin: '55' }));
  assert.deepEqual(plano(pedido), { q: 'camiseta' }, 'categoría, precio y atributos no viajan a Mongo: las facetas necesitan el conjunto sin recortar');
  assert.deepEqual(r.resultados.map((p) => p.id), [2], 'Talla M y precio mínimo 55');
  assert.deepEqual(r.atributos, [
    { nombre: 'Color', valores: [{ valor: 'Rojo', cantidad: 1, seleccionado: false }] },
    { nombre: 'Talla', valores: [{ valor: 'M', cantidad: 1, seleccionado: true }] },
  ], 'Talla cuenta con el precio pero sin su propio filtro; Color con todos');
  assert.deepEqual(r.ruta.map((x) => x.nombre), ['Ropa', 'Camisetas']);
  assert.deepEqual(r.facetas, { Color: ['Rojo'], Talla: ['M'] }, 'clave de la primera versión, derivada de `atributos`');
  assert.equal(r.modo, 'basico');
});

test('el respaldo y el motor devuelven las MISMAS claves: la interfaz no distingue quién contestó', async () => {
  const motor = { resultados: [], total: 0, pagina: 1, tamano: 60, paginas: 1, arbol: [], ruta: [], atributos: [], precio: {}, filtros: {}, facetas: {}, categorias: [], subcategorias: [] };
  const sana = servicio({ busqueda: { buscar: motor } });
  const caida = servicio({ busqueda: { buscar: () => { throw caidaElastic(); } } });
  const claves = (r) => Object.keys(plano(r)).sort();
  // Con texto: una portada sin resultados es otro caso (la guarda del índice vacío, más abajo).
  assert.deepEqual(claves(await caida.buscar({ q: 'x' })), [...claves(motor), 'modo'].sort());
  assert.deepEqual(claves(await sana.buscar({ q: 'x' })), claves(motor));
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
