const test = require('node:test');
const assert = require('node:assert/strict');
const { cargar, redisFalso } = require('./redisHelpers');

function escenario() {
  const redis = redisFalso();
  const doc = { producto_id: 1, descripcion: 'Flash', estado: 'activo', vendedor_id: 2, imagenes: [{ principal: true, url: 'imagen' }], inventario: { precio: 10, cantidad: 99 }, oferta_flash: { activo: true, precio_oferta: 8, stock_oferta: 5, vigente_desde: new Date(), vigente_hasta: new Date(Date.now() + 60000) } };
  let consultas = 0;
  const servicio = cargar('../src/services/ofertaDatosService.js', {
    '../config/redis': { conectar: () => redis }, '../config/mongo': { conectar: async () => {} },
    '../models/mongo/Producto': { findOne: () => ({ select: () => ({ lean: async () => { consultas += 1; return doc; } }) }) },
  });
  return { redis, doc, servicio, consultas: () => consultas };
}

test('flash guarda información propia importante sin inventario ni dependencia del carrito', async () => {
  const e = escenario();
  await e.servicio.obtener(1);
  const datos = JSON.parse(e.redis.valores.get('oferta:1:datos'));
  assert.equal(datos.descripcion, 'Flash');
  assert.equal(datos.imagen_url, 'imagen');
  assert.equal(datos.oferta_flash.precio_oferta, 8);
  assert.equal(datos.oferta_flash.stock_oferta, 5);
  assert.equal('inventario' in datos, false);
  assert.equal(e.redis.valores.size, 1);
  assert.equal(e.redis.ttls.get('oferta:1:datos'), 60);
  await e.servicio.obtener(1);
  assert.equal(e.consultas(), 1, 'lectura caliente no consulta Mongo');
});

test('editar producto o pausar oferta publica sus datos sin reponer cupo', async () => {
  const e = escenario();
  await e.servicio.obtener(1);
  e.redis.valores.set('oferta:1:stock', '2');
  e.redis.ttls.set('oferta:1:stock', 40);
  e.doc.descripcion = 'Descripción actual';
  e.doc.oferta_flash.activo = false;
  await e.servicio.actualizar(e.doc);
  const datos = await e.servicio.obtener(1);
  assert.equal(datos.descripcion, 'Descripción actual');
  assert.equal(datos.oferta_flash.activo, false);
  assert.equal(e.redis.valores.get('oferta:1:stock'), '2');
  assert.equal(e.redis.ttls.get('oferta:1:stock'), 40);
});

test('al expirar o corromperse los datos, se recargan sin reiniciar el contador', async () => {
  const e = escenario();
  e.redis.valores.set('oferta:1:stock', '1');
  e.redis.valores.set('oferta:1:datos', '{inválido');
  assert.equal((await e.servicio.obtener(1)).oferta_flash.precio_oferta, 8);
  await e.servicio.invalidar(1);
  e.doc.oferta_flash.precio_oferta = 7;
  assert.equal((await e.servicio.obtener(1)).oferta_flash.precio_oferta, 7);
  assert.equal(e.redis.valores.get('oferta:1:stock'), '1');
});

test('una lectura fría no pisa los datos publicados por una edición concurrente', async () => {
  const e = escenario();
  const set = e.redis.set;
  e.redis.set = async (...args) => {
    if (args[4] === 'NX') e.redis.valores.set('oferta:1:datos', JSON.stringify({ id: 1, descripcion: 'Edición reciente' }));
    return set(...args);
  };
  await e.servicio.obtener(1);
  assert.equal((await e.servicio.obtener(1)).descripcion, 'Edición reciente');
});
