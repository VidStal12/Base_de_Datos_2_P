const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// frontend/src/utils/filtrosBusqueda.js son funciones puras: se cargan igual que checkoutIntento.js
// (sin los `export`) y se prueban sin navegador.
function cargar() {
  const fuente = fs.readFileSync(path.join(__dirname, '../../frontend/src/utils/filtrosBusqueda.js'), 'utf8').replace(/export /g, '');
  const contexto = { URLSearchParams, module: { exports: {} } };
  vm.runInNewContext(`${fuente}\nmodule.exports = { FILTROS_VACIOS, leerFiltros, aParametros, conCategoria, conSubcategoria, conPagina, conOrden, conPrecio, sinAtributos, alternarAtributo, precioDeCubeta, paginasVisibles, hayFiltros };`, contexto);
  return contexto.module.exports;
}
const f = cargar();
const plano = (v) => JSON.parse(JSON.stringify(v));

test('la URL y los filtros son lo mismo: ir y volver no pierde nada, ni siquiera comillas o acentos', () => {
  const original = { ...plano(f.FILTROS_VACIOS), q: 'camiseta', subcategoriaId: 'sub1', atributos: { 'Tamaño de pantalla': ['55"', '65"'], Color: ['Azul'] }, precioMin: '50', precioMax: '99.99', ordenarPor: 'precioAsc', pagina: 3 };
  const url = new URLSearchParams(f.aParametros(original)).toString();
  assert.deepEqual(plano(f.leerFiltros(new URLSearchParams(url))), original);
});

test('lo vacío no viaja: sin filtros la URL queda limpia', () => {
  assert.deepEqual(plano(f.aParametros(f.FILTROS_VACIOS)), {});
});

test('un JSON de atributos roto o con otra forma se trata como "sin atributos"', () => {
  assert.deepEqual(plano(f.leerFiltros(new URLSearchParams({ atributos: '{no es json' })).atributos), {});
  assert.deepEqual(plano(f.leerFiltros(new URLSearchParams({ atributos: '[1,2]' })).atributos), {});
  assert.deepEqual(plano(f.leerFiltros(new URLSearchParams({ atributos: '{"Talla":"M"}' })).atributos), { Talla: ['M'] }, 'el formato antiguo (valor suelto) sigue valiendo');
  assert.equal(f.leerFiltros(new URLSearchParams({ pagina: '-4' })).pagina, 1);
});

test('marcar varios valores de un atributo es una selección múltiple; desmarcar el último quita el atributo', () => {
  let s = f.alternarAtributo(f.FILTROS_VACIOS, 'Talla', 'M');
  s = f.alternarAtributo(s, 'Talla', 'L');
  s = f.alternarAtributo(s, 'Color', 'Azul');
  assert.deepEqual(plano(s.atributos), { Talla: ['M', 'L'], Color: ['Azul'] });
  s = f.alternarAtributo(s, 'Talla', 'M');
  assert.deepEqual(plano(s.atributos), { Talla: ['L'], Color: ['Azul'] });
  s = f.alternarAtributo(f.alternarAtributo(s, 'Talla', 'L'), 'Color', 'Azul');
  assert.deepEqual(plano(s.atributos), {});
});

test('cambiar de nodo del árbol descarta los atributos (son de cada subcategoría) y cualquier cambio vuelve a la página 1', () => {
  const base = { ...plano(f.FILTROS_VACIOS), q: 'x', atributos: { Talla: ['M'] }, precioMin: '10', pagina: 4 };
  assert.deepEqual(plano(f.conSubcategoria(base, 's2')), { ...base, subcategoriaId: 's2', atributos: {}, pagina: 1 }, 'el texto y el precio se conservan');
  assert.equal(f.conCategoria(base, 'c1').pagina, 1);
  assert.equal(f.conCategoria(base, 'c1').subcategoriaId, '');
  assert.equal(f.conOrden(base, 'masVendidos').pagina, 1);
  assert.equal(f.conPrecio(base, '5', '20').pagina, 1);
  assert.equal(f.conPagina(base, 2).pagina, 2);
  assert.equal(f.alternarAtributo(base, 'Color', 'Azul').pagina, 1);
});

test('una cubeta de precio [desde, hasta) se pide como desde..hasta-0.01; la última no tiene máximo', () => {
  assert.deepEqual(plano(f.precioDeCubeta({ desde: 50, hasta: 100 })), { precioMin: '50', precioMax: '99.99' });
  assert.deepEqual(plano(f.precioDeCubeta({ desde: 20000, hasta: null })), { precioMin: '20000', precioMax: '' });
});

test('hayFiltros distingue "sin filtros" (muestra la portada) de cualquier filtro activo', () => {
  assert.equal(f.hayFiltros(f.FILTROS_VACIOS), false);
  assert.equal(f.hayFiltros({ ...plano(f.FILTROS_VACIOS), precioMax: '10' }), true);
  assert.equal(f.hayFiltros({ ...plano(f.FILTROS_VACIOS), atributos: { Talla: ['M'] } }), true);
});

test('el paginador muestra la primera, la última y la actual con sus vecinas; el resto, como puntos suspensivos', () => {
  assert.deepEqual(plano(f.paginasVisibles(1, 1)), [1]);
  assert.deepEqual(plano(f.paginasVisibles(2, 4)), [1, 2, 3, 4], 'pocas páginas: todas');
  assert.deepEqual(plano(f.paginasVisibles(10, 20)), [1, '…', 9, 10, 11, '…', 20]);
  assert.deepEqual(plano(f.paginasVisibles(1, 20)), [1, 2, '…', 20]);
  assert.deepEqual(plano(f.paginasVisibles(20, 20)), [1, '…', 19, 20]);
  assert.deepEqual(plano(f.paginasVisibles(3, 6)), [1, 2, 3, 4, '…', 6], 'un hueco de UNA página sí lleva puntos: no hay dos páginas que ocultar');
});
