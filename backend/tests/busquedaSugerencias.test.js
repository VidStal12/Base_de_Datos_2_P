const test = require('node:test');
const assert = require('node:assert/strict');
const { cargar } = require('./redisHelpers');

// busquedaService.sugerir() con un Elasticsearch y una lista de vendedores
// suspendidos de mentira: no abre conexiones. Lo que se prueba es la DECISIÓN
// (exactas primero, aproximadas solo si no hay ninguna) y la forma de la consulta,
// no el motor; contra el motor real lo cubre scripts/verificarBusqueda.js.
function servicio({ respuesta, suspendidos = [] }) {
  const peticiones = [];
  const es = { search: async (cuerpo) => { peticiones.push(JSON.parse(JSON.stringify(cuerpo))); return respuesta; } };
  const modulo = cargar('../src/services/busquedaService.js', {
    '../config/elasticsearch': { conectar: async () => es, conCircuito: async (operacion) => operacion(es), indice: () => 'indice_de_prueba' },
    './suspensionService': { vendedoresSuspendidos: async () => new Set(suspendidos) },
  });
  return { sugerir: modulo.sugerir, peticiones };
}

const opcion = (text, vendedor_id = 1) => ({ text, _source: { vendedor_id } });
const respuesta = (exactas, aproximadas) => ({
  suggest: { exactas: [{ options: exactas }], aproximadas: [{ options: aproximadas }] },
});
// Lo que devuelve el sandbox es de otro "realm": se copia a un arreglo normal para comparar.
const lista = (valor) => Array.from(valor);

const X100 = opcion('Smartphone X100');
const vecinos = [opcion('Smartphone batería extendida'), opcion('Smartphone cámara triple'), opcion('Smartphone gama alta')];

test('un texto vacío no consulta Elasticsearch', async () => {
  const { sugerir, peticiones } = servicio({ respuesta: respuesta([], []) });
  assert.deepEqual(lista(await sugerir('   ')), []);
  assert.deepEqual(lista(await sugerir('')), []);
  assert.equal(peticiones.length, 0);
});

test('una sola petición con dos suggesters: exactas sin fuzzy y aproximadas con fuzzy', async () => {
  const { sugerir, peticiones } = servicio({ respuesta: respuesta([X100], [X100, ...vecinos]) });
  await sugerir('smartphone x');
  assert.equal(peticiones.length, 1);
  const { exactas, aproximadas } = peticiones[0].suggest;
  assert.equal(exactas.prefix, 'smartphone x');
  assert.equal(aproximadas.prefix, 'smartphone x');
  assert.equal(exactas.completion.fuzzy, undefined, 'las exactas no deben llevar fuzzy');
  assert.deepEqual(aproximadas.completion.fuzzy, { fuzziness: 'AUTO' });
  for (const { completion } of [exactas, aproximadas]) {
    assert.equal(completion.field, 'sugerencia');
    assert.equal(completion.skip_duplicates, true);
    assert.deepEqual(completion.contexts, { estado: ['activo'] }, 'solo productos activos, también al sugerir');
    assert.equal(completion.size, 8);
  }
});

test('con coincidencias exactas se muestran solo esas, aunque haya aproximadas', async () => {
  const { sugerir } = servicio({ respuesta: respuesta([X100], [X100, ...vecinos]) });
  assert.deepEqual(lista(await sugerir('smartphone x')), ['Smartphone X100']);
});

test('sin coincidencias exactas se usan las aproximadas (la tolerancia a errores se conserva)', async () => {
  const bicicletas = [opcion('Bicicleta BMX'), opcion('Bicicleta urbana')];
  const { sugerir } = servicio({ respuesta: respuesta([], bicicletas) });
  assert.deepEqual(lista(await sugerir('bicicletta')), ['Bicicleta BMX', 'Bicicleta urbana']);
});

test('sin ninguna coincidencia devuelve una lista vacía', async () => {
  const { sugerir } = servicio({ respuesta: respuesta([], []) });
  assert.deepEqual(lista(await sugerir('zzzzzz')), []);
});

test('nunca devuelve más de 8 sugerencias', async () => {
  const muchas = Array.from({ length: 12 }, (_, i) => opcion(`Camiseta ${i}`));
  const { sugerir } = servicio({ respuesta: respuesta(muchas, []) });
  assert.equal(lista(await sugerir('camis')).length, 8);
});

test('con vendedores suspendidos pide más opciones y descarta las suyas', async () => {
  const { sugerir, peticiones } = servicio({
    suspendidos: [7],
    respuesta: respuesta([opcion('Camiseta oculta', 7), opcion('Camiseta visible', 1)], []),
  });
  assert.deepEqual(lista(await sugerir('camis')), ['Camiseta visible']);
  assert.equal(peticiones[0].suggest.exactas.completion.size, 24);
  assert.equal(peticiones[0].suggest.aproximadas.completion.size, 24);
});

test('si todas las exactas son de vendedores suspendidos, se usan las aproximadas visibles', async () => {
  const { sugerir } = servicio({
    suspendidos: [7],
    respuesta: respuesta([opcion('Smartphone X100', 7)], [opcion('Smartphone X100', 7), opcion('Smartphone gama alta', 1)]),
  });
  assert.deepEqual(lista(await sugerir('smartphone x')), ['Smartphone gama alta']);
});
