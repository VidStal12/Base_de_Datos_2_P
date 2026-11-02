const test = require('node:test');
const assert = require('node:assert/strict');
const { cargar } = require('./redisHelpers');

// busquedaSyncService.indexarProducto() con un Elasticsearch y un modelo de mentira. La regla que se guarda acá es la
// de IA/PLAN-ENTREGA-FINAL.md §3.4b: un `index` completo SIN el vector lo BORRA (comprobado contra el motor real), así
// que sin vector nuevo el producto se actualiza con un `update` parcial que deja el que ya tiene.
const plano = (valor) => JSON.parse(JSON.stringify(valor));
const VECTOR = [0.6, 0.8];
const PRODUCTO = {
  id: 7,
  nombre: 'Polo',
  descripcion: 'Camiseta polo clásica',
  vendedor_id: 2,
  vendedor_nombre: 'Luis Ramírez',
  imagen_url: '',
  subcategoria: { id: 'sub1', categoria_id: 'cat1', subcategoria: 'Camisetas', categoria: 'Ropa' },
  atributos: [{ nombre: 'Talla', valor: 'M' }],
  inventario: { precio: 80, cantidad: 5 },
  estado: 'activo',
  total_vendido: 3,
};

// `modelo`: lo que hace incrustar() — un vector, o una función que lanza. `motor`: lo que hace cada operación del cliente.
function servicio({ modelo = async () => [VECTOR], motor = async () => ({ result: 'ok' }) } = {}) {
  const operaciones = [];
  const textos = [];
  const avisos = [];
  const cliente = {
    index: async (cuerpo) => { operaciones.push(['index', plano(cuerpo)]); return motor('index'); },
    update: async (cuerpo) => { operaciones.push(['update', plano(cuerpo)]); return motor('update'); },
  };
  const modulo = cargar(
    '../src/services/busquedaSyncService.js',
    {
      '../config/elasticsearch': { conCircuito: async (operacion) => operacion(cliente), indice: () => 'indice_de_prueba' },
      './embeddingService': {
        incrustar: async (lista) => { textos.push(...lista); return modelo(lista); },
        textoDeProducto: (producto) => `TEXTO(${producto.descripcion})`,
      },
    },
    {},
    { console: { error: (...args) => avisos.push(args.join(' ')), log() {} } }
  );
  return { ...modulo, operaciones, textos, avisos };
}

const sinModelo = () => { throw new Error('El modelo de embeddings no está disponible: faltan archivos'); };

test('con el modelo, el producto se indexa COMPLETO con su vector recién calculado', async () => {
  const s = servicio();
  assert.equal(await s.indexarProducto(PRODUCTO), true);
  assert.equal(s.operaciones.length, 1);
  const [tipo, cuerpo] = s.operaciones[0];
  assert.equal(tipo, 'index');
  assert.equal(cuerpo.index, 'indice_de_prueba');
  assert.equal(cuerpo.id, '7');
  assert.deepEqual(cuerpo.document.embedding, VECTOR);
  assert.equal(cuerpo.document.descripcion, 'Camiseta polo clásica');
});

test('el vector es el del texto del producto, calculado en cada alta o edición', async () => {
  const s = servicio();
  await s.indexarProducto(PRODUCTO);
  await s.indexarProducto({ ...PRODUCTO, descripcion: 'Camiseta polo azul' });
  assert.deepEqual(s.textos, ['TEXTO(Camiseta polo clásica)', 'TEXTO(Camiseta polo azul)']);
});

test('SIN el modelo se actualiza en vez de reemplazar: el documento nunca se indexa completo sin su vector', async () => {
  const s = servicio({ modelo: sinModelo });
  assert.equal(await s.indexarProducto(PRODUCTO), false, 'el backfill cuenta que este no recibió vector');
  assert.equal(s.operaciones.length, 1);
  const [tipo, cuerpo] = s.operaciones[0];
  assert.equal(tipo, 'update', 'un `index` completo sin `embedding` borraría el vector que el documento ya tiene');
  assert.equal(cuerpo.id, '7');
  assert.deepEqual(cuerpo.upsert, cuerpo.script.params.doc, 'un producto nuevo se crea, sin vector');
  assert.ok(cuerpo.retry_on_conflict >= 1, 'dos ediciones seguidas no se pisan con un error de versión');
  assert.equal('embedding' in cuerpo.script.params.doc, false, 'ni siquiera como null: un null lo borraría igual');
  assert.equal(cuerpo.script.params.doc.descripcion, 'Camiseta polo clásica', 'el resto del documento sí se actualiza');
  assert.deepEqual(cuerpo.script.params.doc.atributos, [{ nombre: 'Talla', valor: 'M' }]);
});

test('el update parcial lleva todos los campos del documento menos el vector (si falta alguno, quedaría desactualizado)', async () => {
  const conModelo = servicio();
  await conModelo.indexarProducto(PRODUCTO);
  const sinModeloSvc = servicio({ modelo: sinModelo });
  await sinModeloSvc.indexarProducto(PRODUCTO);
  const completo = { ...conModelo.operaciones[0][1].document };
  delete completo.embedding;
  assert.deepEqual(sinModeloSvc.operaciones[0][1].script.params.doc, completo);
});

test('un solo aviso por caída del modelo, no uno por cada producto que se edite mientras dure; al volver, vuelve a avisar', async () => {
  let disponible = false;
  const s = servicio({ modelo: async () => { if (!disponible) sinModelo(); return [VECTOR]; } });
  await s.indexarProducto(PRODUCTO);
  await s.indexarProducto({ ...PRODUCTO, id: 8 });
  await s.indexarProducto({ ...PRODUCTO, id: 9 });
  assert.equal(s.avisos.length, 1);
  assert.match(s.avisos[0], /producto #7/);
  assert.match(s.avisos[0], /no está disponible/);
  disponible = true;
  assert.equal(await s.indexarProducto({ ...PRODUCTO, id: 10 }), true);
  disponible = false;
  await s.indexarProducto({ ...PRODUCTO, id: 11 });
  assert.equal(s.avisos.length, 2, 'una caída nueva se avisa de nuevo');
});

test('cualquier fallo del modelo (no solo «no está»), también un error del runtime, deja el producto indexado sin vector', async () => {
  const s = servicio({ modelo: () => { throw new Error('ONNX runtime: fallo de memoria'); } });
  assert.equal(await s.indexarProducto(PRODUCTO), false);
  assert.deepEqual(s.operaciones.map(([tipo]) => tipo), ['update']);
});

test('si el motor falla no se lanza nada (mejor esfuerzo: crear o editar un producto no se rompe) y se informa el fallo', async () => {
  const s = servicio({ motor: async () => { throw new Error('connect ECONNREFUSED'); } });
  assert.equal(await s.indexarProducto(PRODUCTO), false);
  assert.ok(s.avisos.some((aviso) => /No se pudo indexar el producto #7/.test(aviso)));
  const sinModeloNiMotor = servicio({ modelo: sinModelo, motor: async () => { throw new Error('connect ECONNREFUSED'); } });
  assert.equal(await sinModeloNiMotor.indexarProducto(PRODUCTO), false);
});

test('el documento con vector declara todos sus campos; sin vector no declara `embedding`', () => {
  const { aDocumento } = servicio();
  assert.equal('embedding' in aDocumento(PRODUCTO), false);
  assert.deepEqual(aDocumento(PRODUCTO, VECTOR).embedding, VECTOR);
  assert.equal(aDocumento(PRODUCTO, undefined).estado, 'activo');
});
