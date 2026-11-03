const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// frontend/src/utils/productosVendedor.js son funciones puras: se cargan igual que ofertas.js (sin los `export`) y se
// prueban sin navegador. La ruta se puede cambiar con PRODUCTOS_VENDEDOR_FUENTE para probar copias mutadas del módulo.
function cargar() {
  const ruta = process.env.PRODUCTOS_VENDEDOR_FUENTE || path.join(__dirname, '../../frontend/src/utils/productosVendedor.js');
  const fuente = fs.readFileSync(ruta, 'utf8').replace(/export /g, '');
  const contexto = { module: { exports: {} } };
  vm.runInNewContext(
    `${fuente}\nmodule.exports = { POR_PAGINA, POCO_STOCK, ORDENES, normalizar, tokensDeBusqueda, coincide, puntaje, FILTROS_VACIOS, nivelStock, filtrar, facetas, agruparPorCategoria, ordenEfectivo, ordenar, paginar, leerFiltros, aParametros, conBusqueda, conEstado, conSubcategoria, conStock, conOrden, conPagina, conPor, sinFiltros, hayFiltros, sanear, resaltar, fragmento };`,
    contexto
  );
  return contexto.module.exports;
}
const v = cargar();
const plano = (valor) => JSON.parse(JSON.stringify(valor));

const ROPA = { id: 's-cam', subcategoria: 'Camisetas', categoria: 'Ropa' };
const PANTALONES = { id: 's-pan', subcategoria: 'Pantalones', categoria: 'Ropa' };
const CELULARES = { id: 's-cel', subcategoria: 'Celulares', categoria: 'Electrónica' };
const COCINA = { id: 's-coc', subcategoria: 'Cocina', categoria: 'Hogar' };

function producto(id, nombre, extra = {}) {
  return { id, nombre, descripcion: '', estado: 'activo', subcategoria: ROPA, atributos: [], inventario: { precio: 50, cantidad: 20 }, total_vendido: 0, ...extra };
}

const CATALOGO = [
  producto(1, 'Camiseta premium de algodón orgánico', { descripcion: 'Talla: M. Color: Azul.', atributos: [{ nombre: 'Talla', valor: 'M' }, { nombre: 'Color', valor: 'Azul' }], inventario: { precio: 54.93, cantidad: 15 }, total_vendido: 9 }),
  producto(2, 'Smartphone X100', { subcategoria: CELULARES, atributos: [{ nombre: 'Almacenamiento', valor: '128GB' }, { nombre: 'Color', valor: 'Negro' }], inventario: { precio: 2599, cantidad: 3 }, total_vendido: 3 }),
  producto(12, 'Camiseta oversize streetwear', { estado: 'inactivo', inventario: { precio: 44.17, cantidad: 0 }, total_vendido: 1 }),
  producto(21, 'Pantalón jeans slim fit', { subcategoria: PANTALONES, descripcion: 'Corte ajustado en la pierna para vestir a diario.', inventario: { precio: 120, cantidad: 8 }, total_vendido: 5 }),
  producto(30, 'Taza cerámica', { subcategoria: COCINA, descripcion: 'Un regalo ideal para acompañar una camiseta.', inventario: { precio: 18, cantidad: 100 } }),
  producto(128, 'LM555 temporizador', { subcategoria: COCINA, inventario: { precio: 9.5, cantidad: 5 } }),
];
// Array.from: una lista que devuelve el módulo cargado en el `vm` es de OTRO realm y deepEqual no la iguala a un literal.
const ids = (lista) => Array.from(lista, (p) => p.id);

test('normalizar quita tildes, mayúsculas y espacios de más; las palabras de la búsqueda no se repiten', () => {
  assert.equal(v.normalizar('  Algodón   ORGÁNICO  '), 'algodon organico');
  assert.equal(v.normalizar(null), '');
  assert.deepEqual(plano(v.tokensDeBusqueda('  Camiseta  camiseta AZUL ')), ['camiseta', 'azul']);
  assert.deepEqual(plano(v.tokensDeBusqueda('')), []);
  assert.equal(v.tokensDeBusqueda('a b c d e f g h i j k l').length, 8, 'a lo sumo 8 palabras');
});

test('coincide exige TODAS las palabras, sin importar tildes ni orden, en nombre, categoría, atributos o descripción', () => {
  const t = (q) => ids(CATALOGO.filter((p) => v.coincide(p, v.tokensDeBusqueda(q))));
  assert.deepEqual(t(''), [1, 2, 12, 21, 30, 128], 'sin texto no filtra nada');
  assert.deepEqual(t('CAMISETA'), [1, 12, 30], 'nombre (y la descripción de la taza)');
  assert.deepEqual(t('algodon'), [1], 'sin tilde encuentra «algodón»');
  assert.deepEqual(t('pantalon'), [21]);
  assert.deepEqual(t('azul camiseta'), [1], 'todas las palabras, en cualquier orden');
  assert.deepEqual(t('camiseta negro'), [], 'si una palabra no está en ningún campo, no sale');
  assert.deepEqual(t('electronica'), [2], 'la categoría también se busca, sin tilde');
  assert.deepEqual(t('talla m'), [1], 'atributos: nombre y valor');
  assert.deepEqual(t('128gb'), [2], 'un valor de atributo');
  assert.deepEqual(t('ajustado'), [21], 'la descripción');
});

test('#12 es exactamente el producto 12; 12 también encuentra su id, pero no confunde 1 con 12', () => {
  const t = (q) => ids(CATALOGO.filter((p) => v.coincide(p, v.tokensDeBusqueda(q))));
  assert.deepEqual(t('#12'), [12]);
  assert.deepEqual(t('#1'), [1], '«#1» no es el producto 12 ni el 128');
  assert.deepEqual(t('#128'), [128]);
  assert.deepEqual(t('#99'), []);
  assert.deepEqual(t('128'), [2, 128], 'el id 128 y el «128GB» del texto');
  assert.deepEqual(t('#12 camiseta'), [12], 'el id se combina con el texto');
});

test('la relevancia pone primero lo que coincide en el nombre (al empezar), luego la categoría, los atributos y la descripción', () => {
  // Una subcategoría neutra: la de por defecto de estos productos se llama «Camisetas» y falsearía el ranking.
  const neutra = { subcategoria: { id: 's-n', subcategoria: 'Varios', categoria: 'General' } };
  const lista = [
    producto(1, 'Regalo especial', { ...neutra, descripcion: 'incluye una taza de camiseta' }),
    producto(2, 'Set de camiseta y gorra', neutra),
    producto(3, 'Supercamiseta lisa', neutra),
    producto(4, 'Camiseta lisa', neutra),
    producto(5, 'Chaqueta', { ...neutra, atributos: [{ nombre: 'Tipo', valor: 'camiseta interior' }] }),
    producto(6, 'Bufanda', { subcategoria: { id: 's-x', subcategoria: 'Camisetas', categoria: 'Ropa' } }),
  ];
  const tokens = v.tokensDeBusqueda('camiseta');
  const orden = ids(v.ordenar(lista.filter((p) => v.coincide(p, tokens)), '', tokens));
  assert.deepEqual(orden, [4, 2, 3, 6, 5, 1], 'empieza el nombre > empieza una palabra > en medio de una palabra > categoría > atributos > descripción');
  assert.ok(v.puntaje(lista[3], tokens) > v.puntaje(lista[1], tokens));
});

test('ordenar devuelve una copia y cada criterio ordena como dice; a igual valor gana el más reciente', () => {
  const original = [...CATALOGO];
  const por = (orden) => ids(v.ordenar(CATALOGO, orden));
  assert.deepEqual(CATALOGO, original, 'la lista original no se toca');
  assert.deepEqual(por(''), [128, 30, 21, 12, 2, 1], 'por defecto, sin texto: los más recientes');
  assert.deepEqual(por('relevancia'), [128, 30, 21, 12, 2, 1], 'sin texto la relevancia es lo más reciente');
  assert.deepEqual(por('nombreAsc'), [12, 1, 128, 21, 2, 30], '«Camiseta oversize» va antes que «Camiseta premium»');
  assert.deepEqual(por('nombreDesc'), [30, 2, 21, 128, 1, 12]);
  assert.deepEqual(por('precioAsc'), [128, 30, 12, 1, 21, 2]);
  assert.deepEqual(por('precioDesc'), [2, 21, 1, 12, 30, 128]);
  assert.deepEqual(por('stockAsc'), [12, 2, 128, 21, 1, 30]);
  assert.deepEqual(por('stockDesc'), [30, 1, 21, 128, 2, 12]);
  assert.deepEqual(por('vendidos'), [1, 21, 2, 12, 128, 30], 'más vendidos primero; los empates, el más reciente');
  assert.deepEqual(por('algo-raro'), [128, 30, 21, 12, 2, 1], 'un criterio desconocido cae al más reciente');
  assert.equal(v.ordenEfectivo('', true), 'relevancia');
  assert.equal(v.ordenEfectivo('', false), 'recientes');
  assert.equal(v.ordenEfectivo('precioAsc', true), 'precioAsc');
});

test('el nombre se ordena en español y con números naturales (Producto 2 antes que Producto 10)', () => {
  const lista = [producto(1, 'Producto 10'), producto(2, 'Árbol'), producto(3, 'Producto 2'), producto(4, 'zapato')];
  assert.deepEqual(ids(v.ordenar(lista, 'nombreAsc')), [2, 3, 1, 4]);
});

test('el nivel de stock tiene bordes claros: 0 agotado, de 1 a 5 poco, desde 6 con stock; un dato roto cuenta como agotado', () => {
  const con = (cantidad) => v.nivelStock({ inventario: { cantidad } });
  assert.equal(con(0), 'agotado');
  assert.equal(con(1), 'poco');
  assert.equal(con(5), 'poco');
  assert.equal(con(6), 'con');
  assert.equal(con(null), 'agotado');
  assert.equal(con('7'), 'con', 'la cantidad que llega como texto se entiende');
  assert.equal(v.nivelStock({}), 'agotado');
  assert.equal(v.POCO_STOCK, 5);
});

test('filtrar combina estado, categoría, stock y texto', () => {
  const f = (cambios) => ids(v.filtrar(CATALOGO, { ...v.FILTROS_VACIOS, ...cambios }));
  assert.deepEqual(f({}), [1, 2, 12, 21, 30, 128]);
  assert.deepEqual(f({ estado: 'inactivo' }), [12]);
  assert.deepEqual(f({ estado: 'activo' }), [1, 2, 21, 30, 128]);
  assert.deepEqual(f({ sub: 's-coc' }), [30, 128]);
  assert.deepEqual(f({ stock: 'agotado' }), [12]);
  assert.deepEqual(f({ stock: 'poco' }), [2, 128]);
  assert.deepEqual(f({ stock: 'con' }), [1, 21, 30]);
  assert.deepEqual(f({ q: 'camiseta', estado: 'activo' }), [1, 30]);
  assert.deepEqual(f({ q: 'camiseta', estado: 'activo', sub: 's-cam' }), [1]);
  assert.deepEqual(f({ q: 'camiseta', sub: 's-cel' }), []);
});

test('las facetas cuentan cada opción con los OTROS filtros aplicados, no con el suyo (marcar «Activos» no esconde los inactivos)', () => {
  const r = plano(v.facetas(CATALOGO, { ...v.FILTROS_VACIOS, estado: 'activo' }));
  assert.deepEqual(r.estados, { total: 6, activo: 5, inactivo: 1 }, 'los estados ignoran el filtro de estado');
  assert.deepEqual(r.stock, { total: 5, con: 3, poco: 2, agotado: 0 }, 'el stock sí respeta «solo activos»');
  const buscando = plano(v.facetas(CATALOGO, { ...v.FILTROS_VACIOS, q: 'camiseta' }));
  assert.deepEqual(buscando.estados, { total: 3, activo: 2, inactivo: 1 }, 'la búsqueda siempre cuenta');
  const porSub = Object.fromEntries(buscando.subcategorias.map((s) => [s.nombre, s.cantidad]));
  assert.deepEqual(porSub, { Camisetas: 2, Pantalones: 0, Cocina: 1, Celulares: 0 }, 'todas las subcategorías figuran, con 0 si nada coincide');
  const conSub = plano(v.facetas(CATALOGO, { ...v.FILTROS_VACIOS, sub: 's-cam' }));
  assert.equal(conSub.subcategorias.find((s) => s.id === 's-pan').cantidad, 1, 'el conteo de categorías ignora el filtro de categoría');
  assert.equal(conSub.estados.total, 2, 'pero los estados sí lo respetan');
  assert.deepEqual(plano(v.facetas([], v.FILTROS_VACIOS)), { estados: { total: 0, activo: 0, inactivo: 0 }, stock: { total: 0, con: 0, poco: 0, agotado: 0 }, subcategorias: [] });
});

test('las subcategorías salen ordenadas por categoría y nombre, y se agrupan para el <select>', () => {
  const grupos = plano(v.agruparPorCategoria(v.facetas(CATALOGO, v.FILTROS_VACIOS).subcategorias));
  assert.deepEqual(grupos.map((g) => [g.categoria, g.subs.map((s) => s.nombre)]), [['Electrónica', ['Celulares']], ['Hogar', ['Cocina']], ['Ropa', ['Camisetas', 'Pantalones']]]);
});

test('paginar da el rango, acota la página pedida y no inventa páginas', () => {
  const cien = Array.from({ length: 95 }, (_, i) => i + 1);
  let p = v.paginar(cien, 1, 10);
  assert.deepEqual([p.pagina, p.paginas, p.desde, p.hasta, p.total, p.items.length], [1, 10, 1, 10, 95, 10]);
  p = v.paginar(cien, 10, 10);
  assert.deepEqual([p.desde, p.hasta, p.items.length, p.items[0]], [91, 95, 5, 91]);
  assert.equal(v.paginar(cien, 99, 10).pagina, 10, 'una página de más muestra la última');
  assert.equal(v.paginar(cien, 0, 10).pagina, 1);
  assert.equal(v.paginar(cien, -3, 10).pagina, 1);
  assert.equal(v.paginar(cien, Number.NaN, 10).pagina, 1);
  assert.equal(v.paginar(cien, 2, 25).items[0], 26);
  assert.equal(v.paginar(cien, 1, 7).por, 10, 'un tamaño que no es una opción vuelve al de por defecto');
  const vacio = v.paginar([], 3, 10);
  assert.deepEqual([vacio.pagina, vacio.paginas, vacio.desde, vacio.hasta, vacio.total, vacio.items.length], [1, 1, 0, 0, 0, 0]);
});

test('la URL: se lee lo válido, se descarta lo inválido y no se escribe lo que es el valor por defecto', () => {
  const leer = (consulta) => plano(v.leerFiltros(new URLSearchParams(consulta)));
  assert.deepEqual(leer(''), { q: '', estado: '', sub: '', stock: '', orden: '', pagina: 1, por: 0 });
  assert.deepEqual(leer('q=camiseta&estado=inactivo&sub=s-cam&stock=poco&orden=precioAsc&pagina=3&por=25'), { q: 'camiseta', estado: 'inactivo', sub: 's-cam', stock: 'poco', orden: 'precioAsc', pagina: 3, por: 25 });
  assert.deepEqual(leer('estado=roto&stock=xx&orden=xx&pagina=-4&por=7'), { q: '', estado: '', sub: '', stock: '', orden: '', pagina: 1, por: 0 });
  assert.equal(leer('orden=relevancia').orden, '', '«relevancia» es el valor por defecto con texto: no se guarda');
  assert.equal(leer(`q=${'a'.repeat(500)}`).q.length, 120, 'una búsqueda enorme se acota');
  assert.deepEqual(plano(v.aParametros(v.FILTROS_VACIOS)), {});
  assert.deepEqual(plano(v.aParametros({ q: 'taza', estado: 'activo', sub: 's-coc', stock: 'con', orden: 'nombreAsc', pagina: 2, por: 50 })), { q: 'taza', estado: 'activo', sub: 's-coc', stock: 'con', orden: 'nombreAsc', pagina: '2', por: '50' });
  const ida = { q: 'a b', estado: 'activo', sub: 's-pan', stock: 'agotado', orden: 'vendidos', pagina: 4, por: 10 };
  assert.deepEqual(leer(new URLSearchParams(plano(v.aParametros(ida))).toString()), ida, 'ida y vuelta');
});

test('cada cambio de filtro vuelve a la página 1; cambiar de página no toca los filtros; «limpiar» conserva orden y tamaño', () => {
  const base = { q: 'x', estado: 'activo', sub: 's-cam', stock: 'poco', orden: 'precioAsc', pagina: 5, por: 25 };
  for (const cambio of [v.conBusqueda(base, 'otra'), v.conEstado(base, ''), v.conSubcategoria(base, ''), v.conStock(base, ''), v.conOrden(base, 'vendidos'), v.conPor(base, 50)]) {
    assert.equal(cambio.pagina, 1);
  }
  assert.deepEqual(plano(v.conPagina(base, 2)), { ...base, pagina: 2 });
  assert.deepEqual(plano(v.sinFiltros(base)), { q: '', estado: '', sub: '', stock: '', orden: 'precioAsc', pagina: 1, por: 25 });
  assert.equal(v.conBusqueda(base, 'z'.repeat(300)).q.length, 120);
  assert.equal(v.hayFiltros(base), true);
  assert.equal(v.hayFiltros({ ...v.FILTROS_VACIOS, orden: 'precioAsc', por: 50, pagina: 3 }), false, 'orden y tamaño de página no son filtros');
  for (const clave of ['q', 'estado', 'sub', 'stock']) assert.equal(v.hayFiltros({ ...v.FILTROS_VACIOS, [clave]: 'x' }), true, clave);
});

test('una subcategoría de la URL que el vendedor no tiene se ignora', () => {
  assert.equal(v.sanear({ ...v.FILTROS_VACIOS, sub: 'borrada' }, CATALOGO).sub, '');
  assert.equal(v.sanear({ ...v.FILTROS_VACIOS, sub: 's-cam' }, CATALOGO).sub, 's-cam');
  assert.equal(v.sanear({ ...v.FILTROS_VACIOS, sub: 's-cam' }, []).sub, '');
});

test('resaltar marca las coincidencias en el texto ORIGINAL (con sus tildes y mayúsculas) y une las que se pisan', () => {
  const marcado = (texto, q) => plano(v.resaltar(texto, v.tokensDeBusqueda(q))).filter((t) => t.resaltado).map((t) => t.texto);
  assert.deepEqual(marcado('Camiseta de ALGODÓN orgánico', 'algodon'), ['ALGODÓN'], 'sin tilde encuentra el original con tilde');
  assert.deepEqual(marcado('Camiseta de algodón', 'CAMI de'), ['Cami', 'de'], 'varias palabras, cada una en su lugar');
  assert.deepEqual(marcado('Camiseta', 'cam amis'), ['Camis'], 'dos palabras que se pisan quedan en un solo tramo');
  assert.deepEqual(marcado('Camiseta', 'camiseta ise'), ['Camiseta'], 'una palabra contenida en otra no acorta el tramo');
  assert.deepEqual(marcado('Pantalón corto', 'pantalon'), ['Pantalón']);
  const tramos = plano(v.resaltar('Camiseta azul', v.tokensDeBusqueda('azul')));
  assert.deepEqual(tramos, [{ texto: 'Camiseta ', resaltado: false }, { texto: 'azul', resaltado: true }]);
  assert.equal(tramos.map((t) => t.texto).join(''), 'Camiseta azul', 'los tramos siempre reconstruyen el texto original');
  assert.deepEqual(plano(v.resaltar('Sin coincidencias', v.tokensDeBusqueda('xyz'))), [{ texto: 'Sin coincidencias', resaltado: false }]);
  assert.deepEqual(plano(v.resaltar('Texto', [])), [{ texto: 'Texto', resaltado: false }]);
  assert.deepEqual(plano(v.resaltar('', v.tokensDeBusqueda('a'))), [{ texto: '', resaltado: false }]);
  assert.deepEqual(plano(v.resaltar(null, v.tokensDeBusqueda('a'))), [{ texto: '', resaltado: false }]);
  assert.deepEqual(marcado('Producto #12 de 12', '#12'), [], 'un #id no se resalta como texto');
  assert.deepEqual(marcado('Taza 12 oz', '12'), ['12']);
  assert.deepEqual(marcado('Año 😀 niño', 'nino'), ['niño'], 'la ñ y los emojis no desalinean el resaltado');
  assert.equal(plano(v.resaltar('Año 😀 niño', ['ano'])).map((t) => t.texto).join(''), 'Año 😀 niño');
  // «ñ» escrita como n + tilde suelta (texto pegado desde otras aplicaciones): son dos unidades que valen UNA letra al buscar
  const descompuesto = 'niño gris';
  assert.deepEqual(marcado(descompuesto, 'nino'), ['niño'], 'se resalta la palabra completa, con su tilde suelta');
  assert.deepEqual(plano(v.resaltar(descompuesto, v.tokensDeBusqueda('gris'))).map((t) => t.texto), ['niño ', 'gris'], 'y lo que viene después queda bien alineado');
});

test('el fragmento muestra el trozo de descripción o de atributos que explica la coincidencia, y nada si el nombre ya la explica', () => {
  const frag = (id, q) => plano(v.fragmento(CATALOGO.find((p) => p.id === id), v.tokensDeBusqueda(q)));
  assert.equal(frag(1, 'camiseta'), null, 'está en el nombre: no hace falta explicarla');
  assert.equal(frag(2, '#2'), null);
  assert.equal(frag(2, 'electronica'), null, 'la categoría ya se ve en la fila');
  assert.equal(frag(2, ''), null, 'sin búsqueda no hay fragmento');
  assert.deepEqual(frag(21, 'ajustado'), { etiqueta: 'Descripción', texto: 'Corte ajustado en la pierna para vestir a diario.' });
  assert.deepEqual(frag(2, '128gb'), { etiqueta: 'Atributos', texto: 'Almacenamiento: 128GB · Color: Negro' });
  assert.equal(frag(30, 'camiseta').etiqueta, 'Descripción', 'la taza sale por su descripción');
  const largo = producto(50, 'Sombrero', { descripcion: `${'Lorem ipsum dolor sit amet '.repeat(6)}paja toquilla ${'consectetur adipiscing elit '.repeat(6)}` });
  const recorte = plano(v.fragmento(largo, v.tokensDeBusqueda('toquilla')));
  assert.ok(recorte.texto.startsWith('… ') && recorte.texto.endsWith(' …'), 'se recorta con puntos suspensivos a ambos lados');
  assert.ok(recorte.texto.includes('toquilla') && recorte.texto.length < 140);
  const palabras = new Set(largo.descripcion.trim().split(' '));
  assert.ok(recorte.texto.replace(/^… /, '').replace(/ …$/, '').split(' ').every((p) => palabras.has(p)), 'nunca parte una palabra por la mitad');
  const medio = producto(52, 'Gorra', { descripcion: `${'palabra '.repeat(12)}buscada ${'palabra '.repeat(3)}`.trim() });
  assert.equal(plano(v.fragmento(medio, v.tokensDeBusqueda('buscada'))).texto, medio.descripcion, 'un texto de hasta 135 caracteres se muestra entero, sin recortes');
  assert.equal(plano(v.fragmento(producto(51, 'Sin texto'), v.tokensDeBusqueda('zzz'))), null);
});

test('las opciones de la pantalla son las que entiende la URL', () => {
  assert.deepEqual(plano(v.POR_PAGINA), [10, 25, 50]);
  assert.ok(v.ORDENES.some((o) => o.valor === 'relevancia') && v.ORDENES.some((o) => o.valor === 'recientes'));
  for (const { valor } of v.ORDENES.filter((o) => o.valor !== 'relevancia')) assert.equal(v.leerFiltros(new URLSearchParams({ orden: valor })).orden, valor, valor);
});
