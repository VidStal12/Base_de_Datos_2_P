const test = require('node:test');
const assert = require('node:assert/strict');
const reglas = require('../src/services/reglasRelacionados');

// Las reglas de negocio de «productos relacionados», sin motor ni base: lo que se prueba es qué se queda y qué
// se descarta de una lista de candidatos que ya viene en orden de relevancia.
const producto = (id, descripcion, vendedor_id, cantidad = 5) => ({ id, descripcion, vendedor_id, inventario: { precio: 10, cantidad } });
const ids = (lista) => lista.map((p) => p.id);

test('los valores por omisión son los del diseño: 6 a mostrar, ocultar con menos de 2, coseno mínimo en el rango útil del modelo', () => {
  assert.equal(reglas.MOSTRAR, 6);
  assert.equal(reglas.MINIMO, 2);
  assert.ok(reglas.CANDIDATOS > reglas.MOSTRAR, 'se piden más vecinos de los que se muestran, para poder descartar repetidos y agotados');
  assert.ok(reglas.UMBRAL_COSENO > 0.7 && reglas.UMBRAL_COSENO < 1, 'los vectores de e5 se agrupan entre 0,7 y 1: un umbral más bajo deja pasar cualquier cosa');
});

test('se respeta el orden de relevancia y se corta en el límite', () => {
  const candidatos = Array.from({ length: 10 }, (_, i) => producto(i + 1, `Producto ${i + 1}`, i % 4));
  assert.deepEqual(ids(reglas.elegir(candidatos)), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(ids(reglas.elegir(candidatos, { limite: 3 })), [1, 2, 3]);
});

test('con menos candidatos que el límite devuelve los que hay, sin rellenar', () => {
  assert.deepEqual(ids(reglas.elegir([producto(1, 'A', 1), producto(2, 'B', 2)])), [1, 2]);
  assert.deepEqual(reglas.elegir([]), []);
});

test('un título repetido se muestra una sola vez (el más relevante), sin importar mayúsculas ni espacios', () => {
  const candidatos = [
    producto(1, 'Camiseta polo', 1),
    producto(2, '  camiseta   POLO ', 2),
    producto(3, 'Camiseta de algodón', 1),
  ];
  assert.deepEqual(ids(reglas.elegir(candidatos)), [1, 3]);
});

test('el mismo título que el producto que se está mirando tampoco aporta nada', () => {
  const candidatos = [producto(1, 'Smartphone X100', 2), producto(2, 'Smartphone X200', 2), producto(3, 'Celular económico', 5)];
  assert.deepEqual(ids(reglas.elegir(candidatos, { titulo: 'smartphone x100' })), [2, 3]);
  assert.deepEqual(ids(reglas.elegir(candidatos)), [1, 2, 3], 'sin título de referencia no se descarta nada por eso');
});

test('lo agotado va al final, con el orden de relevancia conservado dentro de cada grupo', () => {
  const candidatos = [
    producto(1, 'A', 1, 0),
    producto(2, 'B', 2, 4),
    producto(3, 'C', 1, 0),
    producto(4, 'D', 2, 1),
  ];
  assert.deepEqual(ids(reglas.elegir(candidatos)), [2, 4, 1, 3]);
});

test('un producto sin inventario conocido cuenta como agotado, no rompe nada', () => {
  const sinInventario = { id: 9, descripcion: 'Sin datos', vendedor_id: 1 };
  assert.deepEqual(ids(reglas.elegir([sinInventario, producto(1, 'A', 2)])), [1, 9]);
});

test('un mismo vendedor ocupa a lo sumo la mitad de la lista: con 6 lugares, 3', () => {
  const delMismo = Array.from({ length: 6 }, (_, i) => producto(i + 1, `Del mismo ${i + 1}`, 7));
  const deOtros = [producto(11, 'Otro 1', 8), producto(12, 'Otro 2', 9)];
  assert.deepEqual(ids(reglas.elegir([...delMismo, ...deOtros])), [1, 2, 3, 11, 12], 'tres del vendedor 7 y los otros dos; nadie más para completar');
});

test('el tope se calcula sobre el límite pedido y se redondea hacia arriba', () => {
  const todosDelMismo = Array.from({ length: 6 }, (_, i) => producto(i + 1, `P${i + 1}`, 7));
  assert.equal(reglas.elegir(todosDelMismo, { limite: 4 }).length, 2);
  assert.equal(reglas.elegir(todosDelMismo, { limite: 5 }).length, 3);
  assert.equal(reglas.elegir(todosDelMismo, { limite: 1 }).length, 1);
});

test('con dos vendedores y tres productos parecidos de cada uno caben los seis (el caso del catálogo de desarrollo)', () => {
  const candidatos = [1, 2, 3].flatMap((n) => [producto(n, `Luis ${n}`, 2), producto(n + 10, `Marta ${n}`, 5)]);
  assert.equal(reglas.elegir(candidatos).length, 6);
});

test('no modifica la lista que recibe', () => {
  const candidatos = [producto(1, 'A', 1, 0), producto(2, 'B', 1), producto(2, 'B', 1)];
  const copia = JSON.parse(JSON.stringify(candidatos));
  reglas.elegir(candidatos);
  assert.deepEqual(JSON.parse(JSON.stringify(candidatos)), copia);
});
