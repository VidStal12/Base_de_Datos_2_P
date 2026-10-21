const test = require('node:test');
const assert = require('node:assert/strict');
const { cargar } = require('./redisHelpers');
const facetas = require('../src/services/facetasBusqueda');

// Facetas de la búsqueda sin conexiones: la consulta que se le manda a Elasticsearch (con un cliente
// de mentira que la anota), cómo se lee su respuesta, y el mismo cálculo en JavaScript que usa el
// respaldo con Mongo. Contra el motor real lo cubre scripts/verificarBusqueda.js.
const plano = (valor) => JSON.parse(JSON.stringify(valor));
const RESPUESTA_VACIA = { hits: { total: { value: 0 }, hits: [] }, aggregations: {} };

function motor({ respuesta = RESPUESTA_VACIA, suspendidos = [] } = {}) {
  const peticiones = [];
  const es = { search: async (cuerpo) => { peticiones.push(plano(cuerpo)); return respuesta; } };
  const modulo = cargar('../src/services/busquedaService.js', {
    '../config/elasticsearch': { conectar: async () => es, conCircuito: async (operacion) => operacion(es), indice: () => 'indice_de_prueba' },
    './suspensionService': { vendedoresSuspendidos: async () => new Set(suspendidos) },
  });
  return { ...modulo, peticiones };
}

const CAMISETAS = 'sub-camisetas';
const ROPA = 'cat-ropa';
const nested = (nombre, valores) => ({ nested: { path: 'atributos', query: { bool: { filter: [{ term: { 'atributos.nombre': nombre } }, { terms: { 'atributos.valor': valores } }] } } } });

// ── Lo que llega por la URL ─────────────────────────────────────────────────

test('el texto y los números sueltos se limpian: lo inválido se ignora, no rompe la búsqueda', () => {
  const f = facetas.normalizarConsulta({ q: '  camiseta ', categoriaId: '', precioMin: 'abc', precioMax: '-5', ordenarPor: 'hack' });
  assert.equal(f.q, 'camiseta');
  assert.equal(f.categoriaId, undefined, 'un texto vacío es "sin filtro"');
  assert.equal(f.precioMin, undefined);
  assert.equal(f.precioMax, undefined, 'un precio negativo no es un filtro');
  assert.equal(f.ordenarPor, undefined, 'solo valen los órdenes conocidos');
  assert.deepEqual(plano(facetas.normalizarConsulta({ precioMin: '100', precioMax: '50' })), plano({ ...facetas.normalizarConsulta({}), precioMin: 50, precioMax: 100 }), 'mín y máx invertidos se acomodan');
});

test('la página y el tamaño tienen tope: desde + tamaño nunca pasa de la ventana del motor', () => {
  assert.equal(facetas.normalizarConsulta({}).tamano, 60);
  assert.equal(facetas.normalizarConsulta({ tamano: '9999' }).tamano, 100, 'la ruta pública acepta hasta 100 por página');
  assert.equal(facetas.normalizarConsulta({ tamano: '500' }, { tamanoMaximo: 500 }).tamano, 500, 'el catálogo servido desde el índice pide 500 a propósito');
  assert.equal(facetas.normalizarConsulta({ pagina: '0' }).pagina, 1);
  assert.equal(facetas.normalizarConsulta({ pagina: 'x' }).pagina, 1);
  const alFinal = facetas.normalizarConsulta({ pagina: '99999', tamano: '100' });
  assert.ok(alFinal.pagina * alFinal.tamano <= facetas.VENTANA_MAXIMA);
});

test('atributos acepta un valor suelto o una lista, descarta el JSON inválido y respeta los topes', () => {
  assert.deepEqual(plano(facetas.normalizarAtributos('{"Talla":"M","Color":["Azul","Rojo","Azul"],"Vacío":"","Lista":[]}')), { Talla: ['M'], Color: ['Azul', 'Rojo'] });
  assert.deepEqual(plano(facetas.normalizarAtributos('{no es json')), {});
  assert.deepEqual(plano(facetas.normalizarAtributos('[1,2]')), {});
  assert.deepEqual(plano(facetas.normalizarAtributos({ Talla: 'M' })), { Talla: ['M'] }, 'también llega ya como objeto (llamadas internas)');
  const muchos = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`a${i}`, 'x']));
  assert.equal(Object.keys(facetas.normalizarAtributos(muchos)).length, 10, 'cada nombre elegido cuesta una agregación: tope de 10');
  assert.equal(facetas.normalizarAtributos({ Color: Array.from({ length: 50 }, (_, i) => `v${i}`) }).Color.length, 20);
});

// ── La consulta que se le manda al motor ────────────────────────────────────

test('sin filtros es un match_all sobre productos activos, sin post_filter y con desempate fijo', async () => {
  const e = motor();
  await e.buscar({});
  const [p] = e.peticiones;
  assert.deepEqual(p.query.bool.must, [{ match_all: {} }]);
  assert.deepEqual(p.query.bool.filter, [{ term: { estado: 'activo' } }]);
  assert.equal(p.post_filter, undefined);
  assert.deepEqual(p.sort, [{ producto_id: 'asc' }]);
  assert.equal(p.size, 60);
  assert.equal(p.from, 0);
  assert.equal(p.track_total_hits, true, 'el total de la paginación es exacto, no "10000+"');
});

test('categoría, precio y atributos van en post_filter y NO en query; estado y suspendidos, en query', async () => {
  const e = motor({ suspendidos: [11, 13] });
  await e.buscar({ q: 'camiseta', subcategoriaId: CAMISETAS, precioMin: '50', precioMax: '100', atributos: '{"Talla":["M","L"]}' });
  const [p] = e.peticiones;
  assert.deepEqual(p.query.bool.filter, [{ term: { estado: 'activo' } }], 'ninguna faceta en query: recortaría las agregaciones');
  assert.deepEqual(p.query.bool.must_not, [{ terms: { vendedor_id: [11, 13] } }], 'los suspendidos en query: alcanzan al total, al árbol y a cada faceta');
  assert.deepEqual(p.post_filter.bool.filter, [{ term: { subcategoria_id: CAMISETAS } }, { range: { precio: { gte: 50, lte: 100 } } }, nested('Talla', ['M', 'L'])]);
  assert.equal(JSON.stringify(p.post_filter).includes('vendedor_id'), false, 'la exclusión de suspendidos jamás va en post_filter');
  assert.deepEqual(p.sort, [{ _score: 'desc' }, { producto_id: 'asc' }], 'con texto se ordena por relevancia');
});

test('la subcategoría manda sobre la categoría; varios valores de un atributo viajan en terms (con term el motor responde 400)', async () => {
  const e = motor();
  await e.buscar({ categoriaId: ROPA, subcategoriaId: CAMISETAS, atributos: { Color: ['Azul', 'Rojo'], Talla: 'M' } });
  const filtros = e.peticiones[0].post_filter.bool.filter;
  assert.deepEqual(filtros[0], { term: { subcategoria_id: CAMISETAS } });
  assert.equal(filtros.some((f) => JSON.stringify(f).includes('categoria_id":"cat')), false);
  assert.deepEqual(filtros.slice(1), [nested('Color', ['Azul', 'Rojo']), nested('Talla', ['M'])]);
});

test('cada agregación aplica TODOS los filtros de faceta menos el suyo (facetas disyuntivas)', async () => {
  const e = motor();
  await e.buscar({ subcategoriaId: CAMISETAS, precioMin: 50, atributos: { Talla: ['M'], Color: ['Azul'] } });
  const { aggs } = e.peticiones[0];
  const cat = { term: { subcategoria_id: CAMISETAS } };
  const precio = { range: { precio: { gte: 50 } } };
  assert.deepEqual(Object.keys(aggs).sort(), ['arbol', 'atributos', 'attr_0', 'attr_1', 'precio']);
  assert.deepEqual(aggs.arbol.terms, { field: 'categoria_id', size: 100 });
  assert.deepEqual(aggs.arbol.aggs.con_precio, { filter: { range: { precio: { gte: 50 } } } }, 'el árbol no lleva categoría ni atributos; el precio se cuenta por nodo');
  assert.deepEqual(aggs.precio.filter.bool.filter, [cat, nested('Talla', ['M']), nested('Color', ['Azul'])], 'el precio no se filtra a sí mismo');
  assert.deepEqual(aggs.atributos.filter.bool.filter, [cat, precio, nested('Talla', ['M']), nested('Color', ['Azul'])]);
  assert.deepEqual(aggs.atributos.aggs.n.aggs.nombres.terms.exclude, ['Talla', 'Color'], 'los elegidos tienen bloque propio');
  assert.deepEqual(aggs.attr_0.filter.bool.filter, [cat, precio, nested('Color', ['Azul'])], 'Talla se cuenta sin el filtro de Talla...');
  assert.deepEqual(aggs.attr_1.filter.bool.filter, [cat, precio, nested('Talla', ['M'])], '...y Color sin el de Color');
});

test('el nombre de cada agregación no sale del nombre del atributo (un "[", "]" o ">" lo invalidaría)', async () => {
  const e = motor();
  await e.buscar({ atributos: { 'Talla [cm]': 'M', 'a>b': 'x' } });
  assert.deepEqual(Object.keys(e.peticiones[0].aggs).filter((k) => k.startsWith('attr_')), ['attr_0', 'attr_1']);
  assert.equal(e.peticiones[0].aggs.attr_0.aggs.n.aggs.solo.filter.term['atributos.nombre'], 'Talla [cm]');
});

test('sin facetas (catálogo servido desde el índice) los filtros van directo a query y no se piden agregaciones', async () => {
  const e = motor();
  await e.buscar({ subcategoriaId: CAMISETAS, atributos: { Talla: 'M' } }, { vendedorId: 7, conFacetas: false });
  const [p] = e.peticiones;
  assert.equal(p.aggs, undefined);
  assert.equal(p.post_filter, undefined);
  assert.deepEqual(p.query.bool.filter, [{ term: { estado: 'activo' } }, { term: { vendedor_id: 7 } }, { term: { subcategoria_id: CAMISETAS } }, nested('Talla', ['M'])]);
});

test('orden y paginación: todos los órdenes desempatan por producto_id y la página se traduce a from/size', async () => {
  const e = motor();
  for (const ordenarPor of ['masVendidos', 'precioAsc', 'precioDesc']) await e.buscar({ ordenarPor, pagina: 3, tamano: 20 });
  assert.deepEqual(e.peticiones.map((p) => p.sort), [
    [{ total_vendido: 'desc' }, { producto_id: 'asc' }],
    [{ precio: 'asc' }, { producto_id: 'asc' }],
    [{ precio: 'desc' }, { producto_id: 'asc' }],
  ]);
  assert.ok(e.peticiones.every((p) => p.from === 40 && p.size === 20));
});

// ── Cómo se lee la respuesta del motor ──────────────────────────────────────

const cubeta = (key, doc_count, extra = {}) => ({ key, doc_count, ...extra });
const nombre = (texto) => ({ buckets: [cubeta(texto, 1)] });

// El mismo catálogo de tres productos para el motor (agregaciones escritas a mano) y para el
// respaldo (lista de Mongo): si los dos dicen lo mismo, la interfaz no nota quién contestó.
const PRODUCTOS = [
  { id: 1, descripcion: 'Camiseta azul', total_vendido: 5, inventario: { precio: 50, cantidad: 9 }, subcategoria: { id: CAMISETAS, subcategoria: 'Camisetas', categoria_id: ROPA, categoria: 'Ropa' }, atributos: [{ nombre: 'Talla', valor: 'M' }, { nombre: 'Color', valor: 'Azul' }] },
  { id: 2, descripcion: 'Camiseta roja', total_vendido: 9, inventario: { precio: 60, cantidad: 9 }, subcategoria: { id: CAMISETAS, subcategoria: 'Camisetas', categoria_id: ROPA, categoria: 'Ropa' }, atributos: [{ nombre: 'Talla', valor: 'M' }, { nombre: 'Color', valor: 'Rojo' }] },
  { id: 3, descripcion: 'Taza', total_vendido: 1, inventario: { precio: 15, cantidad: 9 }, subcategoria: { id: 'sub-vajilla', subcategoria: 'Vajilla', categoria_id: 'cat-hogar', categoria: 'Hogar' }, atributos: [] },
];
// Lo que respondería Elasticsearch a { subcategoriaId: CAMISETAS, atributos: { Talla: ['M'] }, precioMin: 55 } sobre PRODUCTOS.
const RESPUESTA_CAMISETAS = {
  hits: { total: { value: 1 }, hits: [{ _id: '2', _source: { descripcion: 'Camiseta roja', precio: 60, cantidad: 9 } }] },
  aggregations: {
    arbol: { buckets: [
      cubeta('cat-hogar', 1, { nombre: nombre('Hogar'), con_precio: { doc_count: 0 }, subcategorias: { buckets: [cubeta('sub-vajilla', 1, { nombre: nombre('Vajilla'), con_precio: { doc_count: 0 } })] } }),
      cubeta(ROPA, 2, { nombre: nombre('Ropa'), con_precio: { doc_count: 1 }, subcategorias: { buckets: [cubeta(CAMISETAS, 2, { nombre: nombre('Camisetas'), con_precio: { doc_count: 1 } })] } }),
    ] },
    precio: { doc_count: 2, stats: { min: 50, max: 60 }, rangos: { buckets: [{ key: '*-10.0', to: 10, doc_count: 0 }, { key: '50.0-100.0', from: 50, to: 100, doc_count: 2 }, { key: '20000.0-*', from: 20000, doc_count: 0 }] } },
    atributos: { doc_count: 1, n: { doc_count: 2, nombres: { buckets: [cubeta('Color', 1, { valores: { buckets: [cubeta('Rojo', 1)] } })] } } },
    attr_0: { doc_count: 1, n: { doc_count: 2, solo: { doc_count: 1, valores: { buckets: [cubeta('M', 1)] } } } },
  },
};
const sinResultados = ({ resultados, ...resto }) => resto;

test('el motor y el respaldo dan la MISMA respuesta (salvo `resultados`) sobre el mismo catálogo', async () => {
  const consulta = { subcategoriaId: CAMISETAS, atributos: '{"Talla":["M"]}', precioMin: '55' };
  const delMotor = plano(sinResultados(await motor({ respuesta: RESPUESTA_CAMISETAS }).buscar(consulta)));
  const delRespaldo = plano(sinResultados(facetas.desdeLista(PRODUCTOS, facetas.normalizarConsulta(consulta))));
  assert.deepEqual(delMotor, delRespaldo);
  assert.equal(delMotor.total, 1);
  assert.deepEqual(delMotor.atributos.map((a) => a.nombre), ['Color', 'Talla'], 'grupos en orden alfabético fijo: no saltan al marcar algo');
});

test('el árbol sale ordenado por nombre, con el conteo con precio por nodo y la ruta de migas', async () => {
  const r = plano(await motor({ respuesta: RESPUESTA_CAMISETAS }).buscar({ subcategoriaId: CAMISETAS, precioMin: 55 }));
  assert.deepEqual(r.arbol.map((c) => [c.nombre, c.cantidad, c.seleccionada]), [['Hogar', 0, false], ['Ropa', 1, true]], 'Hogar existe para el texto pero ningún producto llega al precio: 0');
  assert.deepEqual(r.arbol[1].subcategorias, [{ id: CAMISETAS, nombre: 'Camisetas', cantidad: 1, seleccionada: true }]);
  assert.deepEqual(r.ruta, [{ tipo: 'categoria', id: ROPA, nombre: 'Ropa' }, { tipo: 'subcategoria', id: CAMISETAS, nombre: 'Camisetas' }]);
});

test('con solo subcategoriaId (como llega desde el menú) las migas incluyen la categoría', async () => {
  const r = plano(await motor({ respuesta: RESPUESTA_CAMISETAS }).buscar({ subcategoriaId: CAMISETAS }));
  assert.deepEqual(r.ruta.map((x) => x.nombre), ['Ropa', 'Camisetas']);
  const soloCategoria = plano(await motor({ respuesta: RESPUESTA_CAMISETAS }).buscar({ categoriaId: ROPA }));
  assert.deepEqual(soloCategoria.ruta.map((x) => x.nombre), ['Ropa']);
});

test('un valor elegido que ya no tiene resultados sigue en la lista, con cantidad 0 (si no, no habría cómo desmarcarlo)', async () => {
  const sinTalla = { ...RESPUESTA_CAMISETAS, aggregations: { ...RESPUESTA_CAMISETAS.aggregations, attr_0: { n: { solo: { valores: { buckets: [cubeta('S', 2)] } } } } } };
  const r = plano(await motor({ respuesta: sinTalla }).buscar({ subcategoriaId: CAMISETAS, atributos: { Talla: ['XL'] } }));
  const talla = r.atributos.find((a) => a.nombre === 'Talla');
  assert.deepEqual(talla.valores, [{ valor: 'S', cantidad: 2, seleccionado: false }, { valor: 'XL', cantidad: 0, seleccionado: true }]);
  assert.deepEqual(r.facetas.Talla, ['S', 'XL'], 'la clave de la primera versión también lo conserva');
});

test('los atributos solo se ofrecen cuando el contexto cae en UNA subcategoría', async () => {
  const dosSubcategorias = { ...RESPUESTA_CAMISETAS };
  const variasEnRopa = plano(await motor({ respuesta: dosSubcategorias }).buscar({}));
  assert.deepEqual(variasEnRopa.atributos, [], 'sin elegir nada el texto cae en Ropa y en Hogar: "Talla" de camisetas y de zapatos no se mezclan');
  const unaSola = plano(await motor({ respuesta: dosSubcategorias }).buscar({ categoriaId: ROPA }));
  assert.ok(unaSola.atributos.length > 0, 'dentro de Ropa solo hay camisetas con ese texto: sí se ofrecen');
});

test('el precio mínimo y máximo vienen redondeados a centavos (el índice los guarda como float de 32 bits)', async () => {
  const flotante = { ...RESPUESTA_CAMISETAS, aggregations: { ...RESPUESTA_CAMISETAS.aggregations, precio: { stats: { min: 44.16999816894531, max: 279.5 }, rangos: { buckets: [] } } } };
  const r = plano(await motor({ respuesta: flotante }).buscar({}));
  assert.deepEqual(r.precio, { min: 44.17, max: 279.5, rangos: [] });
});

test('una respuesta sin agregaciones no rompe nada (el doble de bloqueoOcultarVendedor responde así)', async () => {
  const r = plano(await motor().buscar({ q: 'x' }));
  assert.deepEqual(r.resultados, []);
  assert.equal(r.total, 0);
  assert.equal(r.paginas, 1);
  assert.deepEqual(r.arbol, []);
  assert.deepEqual(r.precio, { min: null, max: null, rangos: [] });
});

// ── El mismo cálculo en JavaScript (respaldo con Mongo) ─────────────────────

// Camisetas con varias tallas, para ver qué cuenta cada faceta cuando se marca una.
const camiseta = (id, talla, color, precio) => ({
  id, total_vendido: id, inventario: { precio }, subcategoria: { id: CAMISETAS, subcategoria: 'Camisetas', categoria_id: ROPA, categoria: 'Ropa' },
  atributos: [{ nombre: 'Talla', valor: talla }, { nombre: 'Color', valor: color }],
});
const CAMISETAS_SURTIDAS = [camiseta(1, 'S', 'Azul', 20), camiseta(2, 'M', 'Azul', 40), camiseta(3, 'M', 'Rojo', 60), camiseta(4, 'L', 'Rojo', 80), camiseta(5, 'L', 'Azul', 120)];
const calcular = (consulta, lista = CAMISETAS_SURTIDAS) => plano(facetas.desdeLista(lista, facetas.normalizarConsulta({ subcategoriaId: CAMISETAS, ...consulta })));
const valores = (r, atributo) => Object.fromEntries(r.atributos.find((a) => a.nombre === atributo).valores.map((v) => [v.valor, v.cantidad]));

test('marcar un valor NO hace desaparecer a sus hermanos: Talla=M sigue mostrando S y L con su conteo', () => {
  const r = calcular({ atributos: { Talla: 'M' } });
  assert.equal(r.total, 2);
  assert.deepEqual(valores(r, 'Talla'), { M: 2, L: 2, S: 1 }, 'Talla se cuenta sin su propio filtro');
  assert.deepEqual(valores(r, 'Color'), { Azul: 1, Rojo: 1 }, 'Color sí se recorta por Talla=M');
});

test('varios valores del mismo atributo se suman (O) y atributos distintos se exigen todos (Y)', () => {
  assert.equal(calcular({ atributos: { Talla: ['M', 'L'] } }).total, 4);
  assert.equal(calcular({ atributos: { Talla: ['M', 'L'], Color: ['Rojo'] } }).total, 2);
  const r = calcular({ atributos: { Talla: ['M', 'L'], Color: ['Rojo'] } });
  assert.deepEqual(valores(r, 'Talla'), { M: 1, L: 1 }, 'Talla con Color=Rojo aplicado, pero sin su propio filtro (S no tiene rojas)');
  assert.deepEqual(valores(r, 'Color'), { Rojo: 2, Azul: 2 }, 'Color con Talla∈{M,L} aplicado, sin su propio filtro');
});

test('el árbol no se recorta por la categoría elegida ni por atributos, pero sí por el precio', () => {
  const lista = [...CAMISETAS_SURTIDAS, { id: 9, inventario: { precio: 90 }, subcategoria: { id: 'sub-vajilla', subcategoria: 'Vajilla', categoria_id: 'cat-hogar', categoria: 'Hogar' }, atributos: [] }];
  const r = calcular({ atributos: { Talla: 'M' }, precioMin: 50 }, lista);
  assert.deepEqual(r.arbol.map((c) => [c.nombre, c.cantidad]), [['Hogar', 1], ['Ropa', 3]], 'Ropa: 60, 80 y 120 llegan a 50; las hermanas siguen ahí');
  assert.equal(r.total, 1, 'pero los resultados sí llevan todos los filtros: Talla M y desde 50');
});

test('el precio ofrece mínimo, máximo y cubetas SIN aplicarse el rango de precio a sí mismo', () => {
  const r = calcular({ precioMin: 50, precioMax: 100 });
  assert.equal(r.total, 2);
  assert.deepEqual(r.precio, {
    min: 20, max: 120,
    rangos: [{ desde: 20, hasta: 50, cantidad: 2 }, { desde: 50, hasta: 100, cantidad: 2 }, { desde: 100, hasta: 200, cantidad: 1 }],
  }, 'se ve todo el rango disponible para poder ampliarlo');
});

test('una cubeta es [desde, hasta): con precioMax = hasta - 0.01 el total coincide con el conteo de la cubeta', () => {
  const lista = [camiseta(1, 'S', 'Azul', 99.99), camiseta(2, 'S', 'Azul', 100), camiseta(3, 'S', 'Azul', 50)];
  const r = calcular({}, lista);
  const cubeta50 = r.precio.rangos.find((c) => c.desde === 50);
  assert.equal(cubeta50.cantidad, 2, '50 y 99.99; el de 100 exacto es de la siguiente');
  assert.equal(calcular({ precioMin: 50, precioMax: 99.99 }, lista).total, cubeta50.cantidad);
  assert.equal(calcular({ precioMin: 50, precioMax: 100 }, lista).total, 3, 'con 100 inclusive NO coincidiría');
});

test('paginación y orden: desempata por id, no repite productos entre páginas y no se pasa de la última', () => {
  const lista = Array.from({ length: 7 }, (_, i) => camiseta(i + 1, 'M', 'Azul', 10));
  const pagina = (n) => calcular({ ordenarPor: 'precioAsc', pagina: n, tamano: 3 }, lista);
  assert.deepEqual([1, 2, 3].map((n) => pagina(n).resultados.map((p) => p.id)), [[1, 2, 3], [4, 5, 6], [7]]);
  assert.equal(pagina(1).paginas, 3);
  assert.equal(pagina(1).total, 7);
  assert.deepEqual(calcular({ ordenarPor: 'masVendidos', tamano: 2 }, lista).resultados.map((p) => p.id), [7, 6]);
});

test('un producto sin subcategoría no rompe el cálculo (el motor tampoco lo agrupa)', () => {
  const r = calcular({}, [...CAMISETAS_SURTIDAS, { id: 99, inventario: { precio: 10 }, atributos: [] }]);
  assert.equal(r.arbol[0].subcategorias[0].cantidad, 5);
});

// ── Lo que NO se puede pedir por la URL pública ─────────────────────────────

test('los parámetros internos (incluirInactivos, vendedorId, conFacetas) no se aceptan por la URL pública', async () => {
  const e = motor({ suspendidos: [11] });
  // Lo que llegaría en GET /api/busqueda?incluirInactivos=1&vendedorId=11&conFacetas=false&tamano=500
  await e.buscar({ incluirInactivos: '1', vendedorId: '11', conFacetas: 'false', tamano: '500' });
  const [p] = e.peticiones;
  assert.deepEqual(p.query.bool.filter, [{ term: { estado: 'activo' } }], 'siguen sin verse los inactivos');
  assert.deepEqual(p.query.bool.must_not, [{ terms: { vendedor_id: [11] } }], 'ni los de un vendedor suspendido');
  assert.ok(p.aggs, 'las facetas se piden igual');
  assert.equal(p.size, 100, 'y el tamaño tiene su tope');
});

test('el catálogo servido desde el índice sí puede pedir inactivos, un vendedor y 500 por página (llamada interna)', async () => {
  const e = motor({ suspendidos: [11] });
  await e.listarDesdeIndice({ mostrarInactivos: true, vendedorId: 7 });
  const [p] = e.peticiones;
  assert.deepEqual(p.query.bool.filter, [{ term: { vendedor_id: 7 } }], 'sin filtro de estado');
  assert.equal(p.query.bool.must_not, undefined, 'quien ve los inactivos ve también los de vendedores suspendidos (como en Mongo)');
  assert.equal(p.size, 500);
  assert.equal(p.aggs, undefined);
});
