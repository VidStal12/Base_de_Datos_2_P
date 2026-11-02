const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// frontend/src/utils/ofertas.js son funciones puras: se cargan igual que filtrosBusqueda.js (sin los `export`) y se
// prueban sin navegador.
function cargar() {
  const fuente = fs.readFileSync(path.join(__dirname, '../../frontend/src/utils/ofertas.js'), 'utf8').replace(/export /g, '');
  const contexto = { module: { exports: {} } };
  vm.runInNewContext(
    `${fuente}\nmodule.exports = { porcentajeDescuento, segundosRestantes, cuentaRegresiva, urgencia, porcentajeRestante, nivelStock, normalizarOferta, ORDENES_OFERTA, ordenarOfertas, resumenOfertas, proximoVencimiento, primerasEnTerminar, fecha: (ms) => new Date(ms) };`,
    contexto
  );
  return contexto.module.exports;
}
const o = cargar();
const plano = (v) => JSON.parse(JSON.stringify(v));

const AHORA = Date.parse('2026-10-28T12:00:00.000Z');
const en = (segundos) => new Date(AHORA + segundos * 1000).toISOString();

test('el descuento es el ahorro redondeado, sin mostrar jamás 100 % ni etiquetas de algo que no es más barato', () => {
  assert.equal(o.porcentajeDescuento(100, 75), 25);
  assert.equal(o.porcentajeDescuento('200.00', '150'), 25, 'el precio de MySQL llega como texto');
  assert.equal(o.porcentajeDescuento(199.99, 149.99), 25);
  assert.equal(o.porcentajeDescuento(100, 0.4), 99, '99,6 % redondea a 100 pero se muestra 99');
  assert.equal(o.porcentajeDescuento(100, 0), 99, 'una oferta gratis tampoco dice 100 %');
  assert.equal(o.porcentajeDescuento(100, 100), 0);
  assert.equal(o.porcentajeDescuento(100, 120), 0, 'una "oferta" más cara no lleva etiqueta');
  assert.equal(o.porcentajeDescuento(0, 10), 0);
  assert.equal(o.porcentajeDescuento('abc', 10), 0);
  assert.equal(o.porcentajeDescuento(100, -5), 0);
  assert.equal(o.porcentajeDescuento(undefined, undefined), 0);
});

test('los segundos que faltan se redondean hacia arriba y nunca bajan de cero', () => {
  assert.equal(o.segundosRestantes(en(90), AHORA), 90);
  assert.equal(o.segundosRestantes(new Date(AHORA + 90500).toISOString(), AHORA), 91, '00:01 se ve hasta el último instante');
  assert.equal(o.segundosRestantes(en(0), AHORA), 0);
  assert.equal(o.segundosRestantes(en(-3600), AHORA), 0, 'una oferta ya vencida');
  assert.equal(o.segundosRestantes(o.fecha(AHORA + 5500), AHORA), 6, 'también acepta un Date, con sus milisegundos');
  for (const rota of [undefined, null, '', 'mañana', NaN]) assert.equal(o.segundosRestantes(rota, AHORA), 0, `${rota}`);
});

test('la cuenta regresiva muestra días solo cuando los hay y siempre dos cifras', () => {
  assert.equal(o.cuentaRegresiva(0), '00:00');
  assert.equal(o.cuentaRegresiva(59), '00:59');
  assert.equal(o.cuentaRegresiva(61), '01:01');
  assert.equal(o.cuentaRegresiva(3599), '59:59');
  assert.equal(o.cuentaRegresiva(3600), '01:00:00');
  assert.equal(o.cuentaRegresiva(3 * 3600 + 14 * 60 + 9), '03:14:09');
  assert.equal(o.cuentaRegresiva(86400), '1 d 00:00:00');
  assert.equal(o.cuentaRegresiva(2 * 86400 + 3 * 3600 + 14 * 60 + 9), '2 d 03:14:09');
  assert.equal(o.cuentaRegresiva(90.9), '01:30', 'los decimales se descartan');
  assert.equal(o.cuentaRegresiva(-20), '00:00');
  assert.equal(o.cuentaRegresiva(NaN), '00:00');
  assert.equal(o.cuentaRegresiva(undefined), '00:00');
});

test('la urgencia sube al quedar menos de una hora y más aún al quedar menos de diez minutos', () => {
  assert.equal(o.urgencia(0), 'critica');
  assert.equal(o.urgencia(599), 'critica');
  assert.equal(o.urgencia(600), 'alta');
  assert.equal(o.urgencia(3599), 'alta');
  assert.equal(o.urgencia(3600), 'normal');
  assert.equal(o.urgencia(9 * 86400), 'normal');
});

test('el cupo restante se acota entre 0 y 100, y sin un total válido no se inventa un faltante', () => {
  assert.equal(o.porcentajeRestante(5, 20), 25);
  assert.equal(o.porcentajeRestante(0, 20), 0);
  assert.equal(o.porcentajeRestante(25, 20), 100, 'el remanente nunca pasa del cupo');
  assert.equal(o.porcentajeRestante(-3, 20), 0);
  assert.equal(o.porcentajeRestante(5, 0), 100);
  assert.equal(o.porcentajeRestante(0, 0), 100, '0 de 0 no es NaN');
  assert.equal(o.porcentajeRestante(5, undefined), 100);
  assert.equal(o.porcentajeRestante(undefined, 20), 100);
});

test('el nivel de stock avisa al quedar el 25 % y el 10 % del cupo, o muy pocas unidades aunque el cupo sea chico', () => {
  assert.equal(o.nivelStock(6, 20), 'normal');
  assert.equal(o.nivelStock(5, 20), 'poco');
  assert.equal(o.nivelStock(3, 20), 'poco');
  assert.equal(o.nivelStock(2, 20), 'agotandose');
  assert.equal(o.nivelStock(0, 20), 'agotandose');
  assert.equal(o.nivelStock(50, 500), 'agotandose', 'justo el 10 % de un cupo grande');
  assert.equal(o.nivelStock(55, 500), 'poco', 'el 11 %');
  assert.equal(o.nivelStock(125, 500), 'poco', 'justo el 25 %');
  assert.equal(o.nivelStock(130, 500), 'normal', 'el 26 %');
  assert.equal(o.nivelStock(200, 500), 'normal');
  assert.equal(o.nivelStock(20, 500), 'agotandose', 'el 4 % de un cupo grande');
  assert.equal(o.nivelStock(4, 4), 'poco', 'un cupo de 4 es poco desde el principio: son pocas unidades en total');
  assert.equal(o.nivelStock(1, 4), 'agotandose', '«queda 1» de un cupo chico es la última aunque sea el 25 %');
  assert.equal(o.nivelStock(2, 2), 'agotandose');
  assert.equal(o.nivelStock(5, 10), 'poco', 'quedan 5 de 10 (el 50 %): son pocas unidades aunque el porcentaje no lo diga');
  assert.equal(o.nivelStock(6, 10), 'normal');
  assert.equal(o.nivelStock(1, 0), 'agotandose', 'sin total no se sabe el porcentaje, pero la última unidad apura igual');
  assert.equal(o.nivelStock(40, 0), 'normal', 'sin total y con de sobra no se inventa un faltante');
});

const producto = (extra = {}) => ({
  id: 7,
  nombre: 'Audífonos Bluetooth', descripcion: 'Escucha sin cables.',
  vendedor_id: 3,
  vendedor_nombre: 'Ana',
  imagen_url: 'https://img.example/7.jpg',
  inventario: { precio: '200.00', cantidad: 50 },
  oferta_flash: { stock_oferta: 10, vigente_hasta: en(7200) },
  ...extra,
});
const stock = (extra = {}) => ({ activo: true, producto: 7, precio_oferta: 150, restante: 4, vigente_hasta: en(3600), ...extra });

test('una oferta se arma con el precio normal del producto y lo que dice AHORA el stock (restante y fin)', () => {
  assert.deepEqual(plano(o.normalizarOferta({ producto: producto(), stock: stock() })), {
    id: 7,
    nombre: 'Audífonos Bluetooth', descripcion: 'Escucha sin cables.',
    vendedorId: 3,
    vendedor: 'Ana',
    imagen: 'https://img.example/7.jpg',
    precioNormal: 200,
    precioOferta: 150,
    descuento: 25,
    restante: 4,
    total: 10,
    vigenteHasta: en(3600),
  });
});

test('sin cupo original o sin fecha en el stock, la oferta usa lo que haya en vez de romperse', () => {
  const sinCupo = o.normalizarOferta({ producto: producto({ oferta_flash: undefined }), stock: stock({ vigente_hasta: undefined }) });
  assert.equal(sinCupo.total, 4, 'el cupo original se aproxima por lo que queda');
  assert.equal(sinCupo.vigenteHasta, undefined);
  const sinImagen = o.normalizarOferta({ producto: producto({ imagen_url: null, inventario: undefined }), stock: stock() });
  assert.equal(sinImagen.imagen, '');
  assert.equal(sinImagen.precioNormal, 0);
  assert.equal(sinImagen.descuento, 0, 'sin precio normal no hay etiqueta de descuento');
  assert.equal(o.normalizarOferta({ producto: producto(), stock: stock({ vigente_hasta: undefined }) }).vigenteHasta, en(7200), 'cae a la fecha del producto');
});

const oferta = (id, extra) => ({ id, descuento: 10, precioOferta: 100, restante: 5, vigenteHasta: en(1000), ...extra });
const ids = (lista) => plano(lista.map((x) => x.id));

test('ordenar ofertas no toca la lista original y cada criterio hace lo que dice', () => {
  const lista = [
    oferta(1, { vigenteHasta: en(5000), descuento: 30, precioOferta: 300, restante: 9 }),
    oferta(2, { vigenteHasta: en(1000), descuento: 10, precioOferta: 100, restante: 3 }),
    oferta(3, { vigenteHasta: en(3000), descuento: 50, precioOferta: 200, restante: 1 }),
  ];
  const antes = ids(lista);
  assert.deepEqual(ids(o.ordenarOfertas(lista, 'terminaPronto')), [2, 3, 1]);
  assert.deepEqual(ids(o.ordenarOfertas(lista, 'mayorDescuento')), [3, 1, 2]);
  assert.deepEqual(ids(o.ordenarOfertas(lista, 'menorPrecio')), [2, 3, 1]);
  assert.deepEqual(ids(o.ordenarOfertas(lista, 'ultimasUnidades')), [3, 2, 1]);
  assert.deepEqual(ids(lista), antes, 'la lista original queda como estaba');
});

test('un criterio desconocido deja el orden como llegó, y los empates conservan el orden de llegada', () => {
  const lista = [oferta(1), oferta(2), oferta(3)];
  assert.deepEqual(ids(o.ordenarOfertas(lista, 'inventado')), [1, 2, 3]);
  assert.deepEqual(ids(o.ordenarOfertas(lista, undefined)), [1, 2, 3]);
  assert.deepEqual(ids(o.ordenarOfertas(lista, 'mayorDescuento')), [1, 2, 3], 'mismo descuento: sin cambios');
  assert.deepEqual(ids(o.ordenarOfertas([oferta(1, { vigenteHasta: 'sin fecha' }), oferta(2)], 'terminaPronto')), [2, 1], 'sin fecha válida va al final');
});

test('todas las opciones del selector de orden están implementadas (ninguna es letra muerta)', () => {
  assert.ok(o.ORDENES_OFERTA.length >= 3);
  const valores = o.ORDENES_OFERTA.map((x) => x.valor);
  assert.equal(new Set(valores).size, valores.length);
  // una lista que ningún criterio deja en el orden de llegada [1, 2, 3]
  const lista = [
    oferta(1, { vigenteHasta: en(3000), descuento: 10, precioOferta: 300, restante: 9 }),
    oferta(2, { vigenteHasta: en(2000), descuento: 20, precioOferta: 200, restante: 5 }),
    oferta(3, { vigenteHasta: en(1000), descuento: 30, precioOferta: 100, restante: 1 }),
  ];
  for (const { valor, texto } of o.ORDENES_OFERTA) {
    assert.ok(texto, valor);
    assert.notDeepEqual(ids(o.ordenarOfertas(lista, valor)), [1, 2, 3], `${valor} no ordena nada`);
  }
});

test('el resumen cuenta solo las ofertas que siguen vivas y dice en cuánto termina la primera', () => {
  const lista = [oferta(1, { vigenteHasta: en(4000) }), oferta(2, { vigenteHasta: en(120) }), oferta(3, { vigenteHasta: en(-10) })];
  assert.deepEqual(plano(o.resumenOfertas(lista, AHORA)), { cantidad: 2, terminaPrimero: 120 });
  assert.deepEqual(plano(o.resumenOfertas([], AHORA)), { cantidad: 0, terminaPrimero: 0 });
  assert.deepEqual(plano(o.resumenOfertas([oferta(1, { vigenteHasta: en(-1) })], AHORA)), { cantidad: 0, terminaPrimero: 0 });
});

test('al recortar la lista se quedan las ofertas que terminan primero, no las primeras en llegar', () => {
  const producto = (id, hasta) => ({ id, oferta_flash: hasta === undefined ? undefined : { vigente_hasta: hasta } });
  const lista = [producto(1, en(9000)), producto(2, en(100)), producto(3, en(5000)), producto(4, en(50)), producto(5, en(7000))];
  assert.deepEqual(ids(o.primerasEnTerminar(lista, 2)), [4, 2], 'las dos que terminan antes, en ese orden');
  assert.deepEqual(ids(o.primerasEnTerminar(lista, 99)), [4, 2, 3, 5, 1], 'con límite de sobra devuelve todas, ordenadas');
  assert.deepEqual(ids(o.primerasEnTerminar(lista, 0)), []);
  assert.deepEqual(ids(lista), [1, 2, 3, 4, 5], 'la lista original no se toca');
  const rotas = [producto(1, 'pronto'), producto(2, en(10)), producto(3, undefined), producto(4, en(10))];
  assert.deepEqual(ids(o.primerasEnTerminar(rotas, 4)), [2, 4, 1, 3], 'sin fecha válida al final, y los empates en orden de llegada');
});

test('el próximo vencimiento ignora lo ya vencido y lo que no tiene fecha: nunca pide volver a cargar en bucle', () => {
  assert.equal(o.proximoVencimiento([oferta(1, { vigenteHasta: en(4000) }), oferta(2, { vigenteHasta: en(120) }), oferta(3, { vigenteHasta: en(-10) })], AHORA), 120000);
  assert.equal(o.proximoVencimiento([], AHORA), null);
  assert.equal(o.proximoVencimiento([oferta(1, { vigenteHasta: en(-1) }), oferta(2, { vigenteHasta: en(0) })], AHORA), null, 'vencida o venciendo ya: nada que esperar');
  assert.equal(o.proximoVencimiento([oferta(1, { vigenteHasta: undefined }), oferta(2, { vigenteHasta: 'pronto' })], AHORA), null);
  assert.equal(o.proximoVencimiento([oferta(1, { vigenteHasta: 'pronto' }), oferta(2, { vigenteHasta: en(7) })], AHORA), 7000, 'una fecha rota no tapa a las demás');
});
