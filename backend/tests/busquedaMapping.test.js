const test = require('node:test');
const assert = require('node:assert/strict');
const { MAPPING } = require('../src/config/elasticsearch');
const { aDocumento } = require('../src/services/busquedaSyncService');

// Estas pruebas no abren ninguna conexión (config/elasticsearch.js solo crea el
// cliente dentro de conectar()) ni tocan el índice real. Guardan una sola cosa:
// que el documento que arma aDocumento() y MAPPING se mantengan alineados.
// Con `dynamic: 'strict'` un campo que el documento trae y el mapping no declara
// hace fallar el indexado, y como indexarProducto() solo registra el error
// (mejor esfuerzo) el producto quedaría fuera de las búsquedas sin que nada
// avise. Aquí ese descuido falla ANTES de llegar a producción.

// Un producto con todas las partes opcionales presentes. `extra` en el atributo
// simula lo que puede traer un subdocumento de Mongo (p. ej. un _id): el
// documento de búsqueda solo debe llevar nombre y valor.
const completo = {
  id: 1,
  descripcion: 'Camiseta polo clásica',
  vendedor_id: 2,
  vendedor_nombre: 'Luis Ramírez',
  imagen_url: 'https://example.com/camiseta.png',
  subcategoria: { id: 'sub1', categoria_id: 'cat1', subcategoria: 'Camisetas', categoria: 'Ropa' },
  atributos: [{ nombre: 'Talla', valor: 'M', extra: 'no debe indexarse' }, { nombre: 'Color', valor: 'Azul' }],
  inventario: { precio: 80.83, cantidad: 5 },
  estado: 'activo',
  total_vendido: 3,
};

// El mínimo que puede llegar: sin subcategoría, sin inventario, sin atributos.
const minimo = { id: 2, descripcion: 'Producto sin datos', estado: 'inactivo' };

const declarados = Object.keys(MAPPING.properties);
const sinDeclarar = (claves, permitidas) => claves.filter((clave) => !permitidas.includes(clave));
// El vector del producto (lo calcula embeddingService con el modelo local): aquí uno cualquiera de la dimensión del mapping.
const VECTOR = Array.from({ length: MAPPING.properties.embedding.dims }, (_, i) => (i === 0 ? 1 : 0));

test('el mapping es estricto: ningún campo se crea por inferencia', () => {
  assert.equal(MAPPING.dynamic, 'strict');
});

test('todo campo que aDocumento() produce está declarado en el mapping', () => {
  const doc = aDocumento(completo, VECTOR);
  const faltan = sinDeclarar(Object.keys(doc), declarados);
  assert.deepEqual(faltan, [], `aDocumento() produce campos que MAPPING no declara (strict los rechazaría): ${faltan.join(', ')}`);
});

test('los atributos indexados solo llevan los campos declarados dentro de "atributos"', () => {
  const doc = aDocumento(completo);
  const permitidos = Object.keys(MAPPING.properties.atributos.properties);
  assert.equal(doc.atributos.length, 2);
  for (const atributo of doc.atributos) {
    const faltan = sinDeclarar(Object.keys(atributo), permitidos);
    assert.deepEqual(faltan, [], `un atributo trae campos sin declarar: ${faltan.join(', ')}`);
  }
});

test('el campo de autocompletado solo usa los contextos declarados', () => {
  const doc = aDocumento(completo);
  const contextos = MAPPING.properties.sugerencia.contexts.map((c) => c.name);
  const faltan = sinDeclarar(Object.keys(doc.sugerencia.contexts), contextos);
  assert.deepEqual(faltan, [], `sugerencia usa contextos sin declarar: ${faltan.join(', ')}`);
  assert.deepEqual(doc.sugerencia.contexts.estado, ['activo']);
});

test('todo campo declarado en el mapping lo llena aDocumento() (si no, buscar por él nunca encuentra nada)', () => {
  const producidos = Object.keys(aDocumento(completo, VECTOR));
  const sinLlenar = sinDeclarar(declarados, producidos);
  assert.deepEqual(sinLlenar, [], `MAPPING declara campos que aDocumento() nunca llena: ${sinLlenar.join(', ')}`);
});

test('el conjunto de campos no depende de los datos del producto', () => {
  const conTodo = Object.keys(aDocumento(completo, VECTOR)).sort();
  const conLoMinimo = Object.keys(aDocumento(minimo, VECTOR)).sort();
  assert.deepEqual(conLoMinimo, conTodo);
  assert.deepEqual(aDocumento(minimo).atributos, []);
});

test('el vector es opcional y SOLO ese campo: sin él el documento trae todo lo demás (lo que permite un update parcial que no lo pisa)', () => {
  const conVector = Object.keys(aDocumento(completo, VECTOR)).sort();
  const sinVector = Object.keys(aDocumento(completo)).sort();
  assert.deepEqual(sinVector, conVector.filter((clave) => clave !== 'embedding'));
  assert.equal(aDocumento(completo).embedding, undefined);
  assert.equal('embedding' in aDocumento(completo), false, 'ni siquiera como null: un null borraría el vector que ya tiene el documento');
  assert.equal(aDocumento(completo, VECTOR).embedding, VECTOR);
});

test('el campo del vector es un dense_vector de coseno con las dimensiones del modelo', () => {
  const embedding = MAPPING.properties.embedding;
  assert.equal(embedding.type, 'dense_vector');
  assert.equal(embedding.similarity, 'cosine');
  assert.equal(embedding.index, true, 'sin index:true no hay kNN aproximado');
  assert.equal(embedding.dims, require('../src/config/embeddingsModelo').DIMENSION, 'el mapping y el modelo se mueven juntos');
});

test('cada campo del mapping declara su tipo, y los de texto su analizador', () => {
  const revisar = (propiedades, ruta) => {
    for (const [nombre, definicion] of Object.entries(propiedades)) {
      assert.ok(definicion.type, `${ruta}${nombre} no declara su tipo`);
      if (definicion.type === 'text') assert.ok(definicion.analyzer, `${ruta}${nombre} es text sin analizador explícito`);
      if (definicion.properties) revisar(definicion.properties, `${ruta}${nombre}.`);
    }
  };
  revisar(MAPPING.properties, '');
});
