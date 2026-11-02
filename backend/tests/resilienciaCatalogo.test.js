const test = require('node:test');
const assert = require('node:assert/strict');
const { cargar } = require('./redisHelpers');
const resiliencia = require('../src/utils/resiliencia');
const { ServicioNoDisponible } = resiliencia;

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
  { id: 1, nombre: 'Camiseta azul', total_vendido: 5, inventario: { precio: 50, cantidad: 9 }, subcategoria: subCamisetas, atributos: [{ nombre: 'Talla', valor: 'M' }, { nombre: 'Color', valor: 'Azul' }] },
  { id: 2, nombre: 'Camiseta roja', total_vendido: 9, inventario: { precio: 60, cantidad: 9 }, subcategoria: subCamisetas, atributos: [{ nombre: 'Talla', valor: 'M' }, { nombre: 'Color', valor: 'Rojo' }] },
  { id: 3, nombre: 'Taza', total_vendido: 1, inventario: { precio: 15, cantidad: 9 }, subcategoria: { id: VAJILLA, subcategoria: 'Vajilla', categoria_id: HOGAR, categoria: 'Hogar' }, atributos: [] },
];

// `actividad` precarga la lista de actividad reciente de Redis por usuario ({ 7: [{ tipo, valor }, …] }, la más
// reciente primero); `tendencia` es el historial de compras (tendenciaService.recomendar); `redisCaido` apaga Redis.
function servicio({ busqueda = {}, producto = {}, categoria = {}, tendencia = {}, actividad = {}, suspendidos = [], docs = [], existencias = [], mongoCaido = false, redisCaido = false } = {}) {
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
            return docs.filter((d) => filtro.nombre.test(d.nombre) && (!filtro.vendedor_id || !filtro.vendedor_id.$nin.includes(d.vendedor_id)));
          },
        }),
        lean: async () => {
          llamadas.push('mongo.existencias');
          return existencias.filter((d) => filtro.producto_id.$in.includes(d.producto_id));
        },
      }),
    }),
  };
  // Un Redis de mentira que sabe lo justo de listas (lrem, lpush, ltrim, lrange, expire) para la actividad reciente.
  const listas = new Map(Object.entries(actividad).map(([id, entradas]) => [`actividad:${id}`, entradas.map((e) => JSON.stringify(e))]));
  const ttl = new Map();
  const redis = {
    lrem: async (clave, _cuantos, valor) => { listas.set(clave, (listas.get(clave) ?? []).filter((v) => v !== valor)); },
    lpush: async (clave, valor) => { listas.set(clave, [valor, ...(listas.get(clave) ?? [])]); },
    ltrim: async (clave, desde, hasta) => { listas.set(clave, (listas.get(clave) ?? []).slice(desde, hasta + 1)); },
    expire: async (clave, segundos) => { ttl.set(clave, segundos); },
    lrange: async (clave, desde, hasta) => (listas.get(clave) ?? []).slice(desde, hasta + 1),
  };
  const fallos = [];
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
      vendedorOculto: registrar('mongo.vendedorOculto', producto.vendedorOculto ?? false),
    },
    './categoriaService': { listar: registrar('mongo.categorias', categoria.listar ?? []) },
    './suspensionService': { vendedoresSuspendidos: async () => new Set(suspendidos) },
    './tendenciaService': { recomendar: registrar('tendencia.recomendar', tendencia.recomendar ?? { productos: [] }) },
    '../models/mongo/Producto': Producto,
    '../config/mongo': { conectar: async () => { if (mongoCaido) throw caidaMongo(); } },
    '../config/redis': { conectar: async () => { if (redisCaido) throw new ServicioNoDisponible('redis'); return redis; } },
    // El registrarFallo real escribe en la consola (una línea por caída): acá solo se anota qué se intentó avisar.
    '../utils/resiliencia': { ...resiliencia, registrarFallo: (contexto) => { fallos.push(contexto); } },
  });
  return { ...modulo, llamadas, listas, ttl, fallos };
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
    { id: 1, nombre: 'Camiseta azul', inventario: { precio: 50, cantidad: 21 }, total_vendido: 153 },
    { id: 2, nombre: 'Camiseta roja', inventario: { precio: 60, cantidad: 9 }, total_vendido: 9 },
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
  await vacia.buscar({ precioMin: '99999' }); // con texto habría sugerencias: ver «Sin resultados» más abajo
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

test('con filtros, cero resultados es una respuesta legítima: no se busca en Mongo', async () => {
  for (const opciones of [{ atributos: '{"Talla":"XXL"}' }, { precioMin: '99999' }, { pagina: '3' }]) {
    const s = servicio({ busqueda: { buscar: INDICE_VACIO } });
    assert.equal(plano(await s.buscar(opciones)).total, 0, JSON.stringify(opciones));
    assert.deepEqual(s.llamadas, ['es.buscar'], JSON.stringify(opciones));
  }
});

test('con texto, cero resultados tampoco se busca en Mongo: lo único que se agrega son las sugerencias, y la respuesta sigue en cero', async () => {
  const pedidos = [];
  const s = servicio({ busqueda: { buscar: INDICE_VACIO }, producto: { listar: (o) => { pedidos.push(plano(o)); return PRODUCTOS; } } });
  const r = plano(await s.buscar({ q: 'zzz' }));
  assert.equal(r.total, 0);
  assert.equal(r.modo, undefined, 'sigue siendo la respuesta del motor');
  assert.ok(pedidos.every((o) => o.q === undefined), 'a Mongo nunca se le pide «zzz»: solo la portada del índice vacío, para las sugerencias');
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
  const motor = { resultados: [PRODUCTOS[0]], total: 1, pagina: 1, tamano: 60, paginas: 1, arbol: [], ruta: [], atributos: [], precio: {}, filtros: {}, facetas: {}, categorias: [], subcategorias: [] };
  const sana = servicio({ busqueda: { buscar: motor } });
  const caida = servicio({ busqueda: { buscar: () => { throw caidaElastic(); } } });
  const claves = (r) => Object.keys(plano(r)).sort();
  // Con resultados: sin ellos la respuesta suma las sugerencias (más abajo) y una portada vacía es otro caso (la guarda del índice vacío).
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
  const docs = Array.from({ length: 12 }, (_, i) => ({ nombre: `Camiseta ${i % 10}`, vendedor_id: i < 2 ? 7 : 8 }));
  const s = servicio({ busqueda: { sugerir: () => { throw caidaElastic(); } }, suspendidos: [7], docs });
  const sugerencias = plano(await s.sugerir('camis'));
  assert.equal(sugerencias.length, 8);
  assert.equal(new Set(sugerencias).size, 8, 'sin repetidos');
  assert.ok(!sugerencias.includes('Camiseta 0') && !sugerencias.includes('Camiseta 1'), 'las del vendedor suspendido no se sugieren');
  const [, filtro] = s.llamadas.find((l) => Array.isArray(l));
  assert.equal(filtro.estado, 'activo');
  assert.ok(filtro.nombre.test('CAMISETA roja') && !filtro.nombre.test('una camiseta'), 'prefijo, sin distinguir mayúsculas');
  assert.deepEqual(plano(await servicio({ busqueda: { sugerir: () => { throw caidaElastic(); } } }).sugerir('   ')), [], 'un texto vacío no consulta nada');
});

test('el texto de las sugerencias es literal: un paréntesis suelto no rompe la consulta', async () => {
  const s = servicio({ busqueda: { sugerir: () => { throw caidaElastic(); } }, docs: [{ nombre: 'Camiseta (azul)', vendedor_id: 1 }] });
  assert.deepEqual(plano(await s.sugerir('camiseta (a')), ['Camiseta (azul)']);
});

// ── Sin resultados: sugerencias y actividad reciente del usuario ────────────
//
// Cuando un TEXTO no encuentra nada, la respuesta sigue diciendo total 0 pero suma `sugeridos` y de dónde salieron
// (`origenSugerencia`): la última actividad del usuario (una búsqueda que sí dio resultados, o el último producto
// que abrió), su historial de compras o, sin sesión o sin nada de eso, los más vendidos. La actividad vive en una
// lista de Redis por usuario; se guarda en segundo plano, así que las pruebas dejan correr la cola antes de mirarla.

const VACIA = { ...RESPUESTA_INDICE, resultados: [], total: 0 };
// El motor contesta según lo que se le pide: «camiseta» y la portada de más vendidos (sin texto) sí; lo demás, nada.
const motorSegunTexto = (o) => (o.q === 'camiseta' || !o.q ? RESPUESTA_INDICE : VACIA);
const cola = () => new Promise((resolver) => setImmediate(resolver));

test('sin resultados y sin sesión se ofrecen los más vendidos; no se toca Redis ni el historial de compras', async () => {
  const s = servicio({ busqueda: { buscar: motorSegunTexto } });
  const r = plano(await s.buscar({ q: 'zzz' }));
  assert.equal(r.total, 0, 'la respuesta sigue siendo la de cero resultados');
  assert.equal(r.origenSugerencia, 'tendencia');
  assert.deepEqual(r.sugeridos.map((p) => p.id), [1, 2]);
  assert.equal(r.terminoBusquedaReciente, undefined);
  assert.deepEqual(s.llamadas, ['es.buscar', 'es.buscar', 'mongo.existencias'], 'la segunda consulta es la de más vendidos y su stock se relee una vez');
  assert.equal(s.listas.size, 0);
});

test('con sesión, sin resultados se repite la última búsqueda que sí dio resultados y se dice cuál fue', async () => {
  const s = servicio({ busqueda: { buscar: motorSegunTexto }, actividad: { 7: [{ tipo: 'busqueda', valor: 'camiseta' }] } });
  const r = plano(await s.buscar({ q: 'zzz' }, 7));
  assert.equal(r.total, 0);
  assert.equal(r.origenSugerencia, 'busquedaReciente');
  assert.equal(r.terminoBusquedaReciente, 'camiseta');
  assert.deepEqual(r.sugeridos.map((p) => p.id), [1, 2]);
  assert.ok(!s.llamadas.includes('tendencia.recomendar'), 'no hace falta el historial de compras');
});

test('las sugerencias por búsqueda reciente muestran el stock vigente de Mongo, no el del índice', async () => {
  const s = servicio({
    busqueda: { buscar: motorSegunTexto },
    actividad: { 7: [{ tipo: 'busqueda', valor: 'camiseta' }] },
    existencias: [{ producto_id: 1, inventario: { cantidad: 0 }, total_vendido: 200 }],
  });
  const r = plano(await s.buscar({ q: 'zzz' }, 7));
  assert.deepEqual(r.sugeridos.map((p) => [p.id, p.inventario.cantidad]), [[1, 0], [2, 9]], 'el #1 se agotó después de indexarse; el #2 sigue como estaba');
});

test('con sesión, si lo último que hizo fue ver un producto, ese producto es la sugerencia', async () => {
  const s = servicio({
    busqueda: { buscar: motorSegunTexto },
    producto: { obtener: (id) => ({ id, nombre: 'Smartphone', estado: 'activo', vendedor_id: 3 }) },
    actividad: { 7: [{ tipo: 'producto', valor: 5 }, { tipo: 'busqueda', valor: 'camiseta' }] },
  });
  const r = plano(await s.buscar({ q: 'zzz' }, 7));
  assert.equal(r.origenSugerencia, 'productoVisto');
  assert.deepEqual(r.sugeridos.map((p) => p.id), [5], 'gana lo más reciente de las dos cosas');
});

test('un producto visto que ya está pausado, o cuyo vendedor se suspendió, NO se sugiere: se sigue con el historial de compras', async () => {
  const historial = { productos: [{ id: 8, nombre: 'Parecido', precio_recomendado: 40, precio_normal: 50 }] };
  const casos = [
    ['pausado (inactivo)', { obtener: (id) => ({ id, estado: 'inactivo', vendedor_id: 3 }) }],
    ['de un vendedor suspendido', { obtener: (id) => ({ id, estado: 'activo', vendedor_id: 3 }), vendedorOculto: true }],
  ];
  for (const [nombre, producto] of casos) {
    const s = servicio({ producto, tendencia: { recomendar: historial }, actividad: { 7: [{ tipo: 'producto', valor: 5 }] } });
    const r = plano(await s.buscar({ q: 'zzz' }, 7));
    assert.equal(r.origenSugerencia, 'historial', nombre);
    assert.deepEqual(r.sugeridos.map((p) => p.id), [8], nombre);
  }
});

test('sin actividad reciente se usa el historial de compras; sin historial, los más vendidos', async () => {
  const conHistorial = servicio({ busqueda: { buscar: motorSegunTexto }, tendencia: { recomendar: { productos: [{ id: 8 }] } } });
  assert.equal(plano(await conHistorial.buscar({ q: 'zzz' }, 7)).origenSugerencia, 'historial');
  const sinHistorial = servicio({ busqueda: { buscar: motorSegunTexto } });
  const r = plano(await sinHistorial.buscar({ q: 'zzz' }, 7));
  assert.equal(r.origenSugerencia, 'tendencia');
  assert.ok(sinHistorial.llamadas.includes('tendencia.recomendar'), 'con sesión se pregunta primero por lo personal');
});

test('una búsqueda que sí encontró algo se guarda como actividad, solo con sesión: sin repetidos, a lo sumo 5 y con 30 días de vida', async () => {
  const s = servicio({ busqueda: { buscar: RESPUESTA_INDICE } });
  await s.buscar({ q: '  camiseta ' }, 7);
  await cola();
  await s.buscar({ q: 'camiseta' }, 7);
  await cola();
  assert.deepEqual(s.listas.get('actividad:7'), [JSON.stringify({ tipo: 'busqueda', valor: 'camiseta' })], 'recortado y sin repetir');
  assert.equal(s.ttl.get('actividad:7'), 60 * 60 * 24 * 30);
  for (const texto of ['a', 'b', 'c', 'd', 'e']) {
    await s.buscar({ q: texto }, 7);
    await cola();
  }
  assert.equal(s.listas.get('actividad:7').length, 5, 'las más viejas se descartan');
  assert.deepEqual(JSON.parse(s.listas.get('actividad:7')[0]), { tipo: 'busqueda', valor: 'e' }, 'la más reciente va primero');
  await s.buscar({ q: 'sin sesión' });
  await cola();
  assert.deepEqual([...s.listas.keys()], ['actividad:7'], 'sin sesión no se guarda nada');
});

test('lo que no encontró nada no se guarda como actividad', async () => {
  const s = servicio({ busqueda: { buscar: motorSegunTexto } });
  await s.buscar({ q: 'zzz' }, 7);
  await cola();
  assert.equal(s.listas.size, 0);
});

test('un ?q repetido (Express lo entrega como arreglo) no rompe la búsqueda con sesión y se guarda como el texto que se buscó', async () => {
  const s = servicio({ busqueda: { buscar: RESPUESTA_INDICE } });
  const r = plano(await s.buscar({ q: ['camiseta', 'pantalon'] }, 7));
  assert.equal(r.total, 2);
  await cola();
  const [entrada] = s.listas.get('actividad:7');
  assert.deepEqual(JSON.parse(entrada), { tipo: 'busqueda', valor: 'camiseta,pantalon' });
  const sinResultados = servicio({ busqueda: { buscar: VACIA } });
  assert.equal(plano(await sinResultados.buscar({ q: ['a', 'b'] }, 7)).total, 0, 'tampoco rompe cuando no hay resultados');
});

test('ver un producto solo cuenta como actividad con sesión', async () => {
  const s = servicio();
  s.registrarVistaProducto(undefined, 5);
  s.registrarVistaProducto(7, 5);
  await cola();
  assert.deepEqual(s.listas.get('actividad:7').map((e) => JSON.parse(e)), [{ tipo: 'producto', valor: 5 }]);
  assert.equal(s.listas.size, 1, 'el anónimo no deja rastro');
});

test('con Redis apagado la búsqueda sigue: no se guarda la actividad y las sugerencias salen de las otras capas', async () => {
  const conResultados = servicio({ busqueda: { buscar: RESPUESTA_INDICE }, redisCaido: true });
  assert.equal(plano(await conResultados.buscar({ q: 'camiseta' }, 7)).total, 2);
  await cola();
  assert.deepEqual(conResultados.fallos, ['No se pudo registrar la actividad reciente'], 'se avisa, sin romper nada');
  const sinResultados = servicio({ busqueda: { buscar: motorSegunTexto }, redisCaido: true, tendencia: { recomendar: { productos: [{ id: 8 }] } } });
  const r = plano(await sinResultados.buscar({ q: 'zzz' }, 7));
  assert.equal(r.total, 0);
  assert.equal(r.origenSugerencia, 'historial', 'sin la lista de actividad se sigue con el historial de compras');
});

test('si las sugerencias no se pueden calcular, la búsqueda sigue siendo la de cero resultados, sin error', async () => {
  const s = servicio({ busqueda: { buscar: (o) => { if (o.ordenarPor) throw new Error('consulta de más vendidos rota'); return VACIA; } } });
  const r = plano(await s.buscar({ q: 'zzz' }));
  assert.equal(r.total, 0);
  assert.equal(r.sugeridos, undefined);
  assert.deepEqual(s.fallos, ['No se pudieron calcular sugeridosSinResultados']);
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
      listarDesdeIndice: [{ id: 5, nombre: 'Desde el índice' }],
      obtenerDelIndice: { id: 5, nombre: 'Desde el índice' },
      categoriasDelIndice: [{ id: 'c1', categoria: 'Ropa', subcategorias: [] }],
    },
  });
  assert.deepEqual(plano(await s.listar({ q: 'x' })), [{ id: 5, nombre: 'Desde el índice' }]);
  const detalle = plano(await s.obtener(5));
  assert.equal(detalle.nombre, 'Desde el índice');
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
