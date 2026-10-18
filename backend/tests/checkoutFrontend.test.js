const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function cargar(checkoutApi) {
  const almacenamiento = new Map();
  const fuente = fs.readFileSync(path.join(__dirname, '../../frontend/src/utils/checkoutIntento.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/export /g, '');
  const contexto = { checkoutApi, sessionStorage: {
    getItem: (k) => almacenamiento.get(k) || null,
    setItem: (k, v) => almacenamiento.set(k, v), removeItem: (k) => almacenamiento.delete(k),
  }, module: { exports: {} } };
  vm.runInNewContext(`${fuente}\nmodule.exports = { cargarIntento, renovarIntento };`, contexto);
  return { ...contexto.module.exports, almacenamiento };
}

test('recargar tras perder la respuesta recupera el mismo intento y no prepara otro', async () => {
  const e = cargar({ intento: async (id) => ({ intentoId: id, estado: 'completado', compraId: 7 }) });
  e.almacenamiento.set('normal:7', 'ABC');
  const r = await e.cargarIntento('normal:7', () => assert.fail('no crear otra compra'), 'token');
  assert.equal(r.intentoId, 'ABC');
  assert.equal(r.recuperado, true);
  assert.equal(r.compraId, 7);
});
test('MySQL/red inaccesible conserva el intento, sin reemplazarlo por otro', async () => {
  const e = cargar({ intento: async () => { throw Object.assign(new Error('sin conexión'), { status: 503 }); } });
  e.almacenamiento.set('flash:7:3', 'ABC');
  await assert.rejects(e.cargarIntento('flash:7:3', () => assert.fail('no preparar'), 'token'), /conexión/);
  assert.equal(e.almacenamiento.get('flash:7:3'), 'ABC');
});
test('si se confirma mientras el usuario pide revisar, muestra el pedido y no crea otro', async () => {
  const e = cargar({ cancelar: async () => ({ intentoId: 'ABC', estado: 'completado', compraId: 8 }) });
  const r = await e.renovarIntento('normal:7', { intentoId: 'ABC', estado: 'pendiente' }, () => assert.fail('no renovar'), 'token');
  assert.equal(r.compraId, 8);
  assert.equal(r.recuperado, true);
});
test('otra compra intencional solicita renovación con el identificador anterior', async () => {
  const e = cargar({ cancelar: async () => ({ intentoId: 'ABC', estado: 'completado' }) });
  const r = await e.renovarIntento('flash:7:3', { intentoId: 'ABC', estado: 'completado' }, async (datos) => {
    assert.equal(datos.anteriorIntentoId, 'ABC');
    return { intentoId: 'DEF', estado: 'pendiente' };
  }, 'token');
  assert.equal(r.intentoId, 'DEF');
  assert.equal(e.almacenamiento.get('flash:7:3'), 'DEF');
});
