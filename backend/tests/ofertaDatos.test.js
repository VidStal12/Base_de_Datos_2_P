const test = require('node:test');
const assert = require('node:assert/strict');
const { cargar, redisFalso } = require('./redisHelpers');

const DATOS = 'oferta:1:datos';
const REVISION = 'oferta:1:revision';
const STOCK = 'oferta:1:stock';

// Un producto con oferta flash activa (venció hace nada ni vence pronto) y un
// doble de Mongo que cuenta cuántas veces se lo consulta.
function escenario({ vigenteHastaEnMs = 3600000 } = {}) {
  const redis = redisFalso();
  const ahora = Date.now();
  const doc = {
    producto_id: 1, descripcion: 'Flash', estado: 'activo', vendedor_id: 2, vendedor_nombre: 'Luis Ramírez', version: 3,
    imagenes: [{ principal: true, url: 'imagen', alt: 'Flash', orden: 1 }, { principal: false, url: 'otra', alt: 'Flash 2', orden: 2 }],
    atributos: [{ nombre: 'Talla', valor: 'M' }, { nombre: 'Color', valor: 'Azul' }],
    subcategoria_id: 'sub-1', resenas_resumen: { promedio: 4.5, cantidad: 2 },
    inventario: { precio: 10, cantidad: 99 },
    oferta_flash: { activo: true, precio_oferta: 8, stock_oferta: 5, vigente_desde: new Date(ahora - 1000), vigente_hasta: new Date(ahora + vigenteHastaEnMs) },
  };
  let consultas = 0;
  let alConsultar = null;
  const servicio = cargar('../src/services/ofertaDatosService.js', {
    '../config/redis': { conectar: () => redis }, '../config/mongo': { conectar: async () => {} },
    '../models/mongo/Producto': { findOne: () => ({ select: () => ({ lean: async () => {
      consultas += 1;
      return alConsultar ? alConsultar(consultas) : doc;
    } }) }) },
  });
  return { redis, doc, servicio, consultas: () => consultas, alConsultar: (fn) => { alConsultar = fn; } };
}

test('la oferta activa guarda en Redis TODOS los datos del producto: un hash con marca de formato, como el carrito', async () => {
  const e = escenario();
  const producto = await e.servicio.obtener(1);
  const hash = e.redis.hashes.get(DATOS);
  assert.equal(hash._formato, '1');
  assert.equal(hash.descripcion, 'Flash');
  assert.equal(hash.estado, 'activo');
  assert.equal(hash.imagen_url, 'imagen');
  assert.equal(JSON.parse(hash.imagenes).length, 2, 'todas las imágenes, no solo la principal');
  assert.equal(JSON.parse(hash.atributos)[1].valor, 'Azul');
  assert.equal(hash.subcategoria_id, 'sub-1');
  assert.equal(hash.vendedor_id, '2');
  assert.equal(hash.vendedor_nombre, 'Luis Ramírez');
  assert.equal(hash.precio_normal, '10');
  assert.equal(JSON.parse(hash.resenas_resumen).promedio, 4.5);
  assert.equal(hash.version, '3');
  assert.equal(JSON.parse(hash.oferta_flash).precio_oferta, 8);
  assert.equal(JSON.parse(hash.oferta_flash).stock_oferta, 5);
  assert.ok(hash.generado_en && Number(hash.vence_en) > Date.now() / 1000);
  // Lo único que no se copia: el inventario real (cambia con cada venta; su
  // autoridad es MySQL y el cupo de la oferta es otra clave).
  assert.equal(Object.keys(hash).some((campo) => /inventario|cantidad/.test(campo)), false);
  assert.equal(Object.values(hash).some((valor) => valor === '99'), false);
  // Y lo que devuelve obtener() es lo mismo que quedó guardado.
  assert.equal(producto.descripcion, 'Flash');
  assert.equal(producto.oferta_flash.precio_oferta, 8);
  assert.equal(producto.atributos.length, 2);
  assert.equal(e.redis.ttls.get(DATOS), 450, 'TTL por inactividad, como el carrito');
  assert.equal(e.redis.valores.size, 0, 'no toca el contador del cupo ni crea nada más');
  await e.servicio.obtener(1);
  assert.equal(e.consultas(), 1, 'la lectura caliente no consulta Mongo');
});

test('cada lectura renueva el TTL por inactividad, pero nunca más allá del fin de la oferta', async () => {
  const e = escenario();
  await e.servicio.obtener(1);
  e.redis.ttls.set(DATOS, 5); // casi vencida por inactividad
  await e.servicio.obtener(1);
  assert.equal(e.redis.ttls.get(DATOS), 450, 'leerla la renueva');

  const corta = escenario({ vigenteHastaEnMs: 100000 }); // la oferta termina en ~100 s
  await corta.servicio.obtener(1);
  assert.ok(corta.redis.ttls.get(DATOS) <= 100 && corta.redis.ttls.get(DATOS) >= 98, 'al regenerar, el TTL no pasa del fin de la oferta');
  corta.redis.ttls.set(DATOS, 5);
  await corta.servicio.obtener(1);
  assert.ok(corta.redis.ttls.get(DATOS) <= 100 && corta.redis.ttls.get(DATOS) > 5, 'al renovarlo tampoco: min(inactividad, lo que falta de la oferta)');
});

test('si la clave expiró se regenera sola desde el catálogo, sin reiniciar el contador del cupo', async () => {
  const e = escenario();
  await e.servicio.obtener(1);
  e.redis.valores.set(STOCK, '2');
  e.redis.ttls.set(STOCK, 40);
  await e.redis.del(DATOS); // lo que hace Redis cuando vence el TTL
  e.doc.descripcion = 'Descripción vigente';
  assert.equal((await e.servicio.obtener(1)).descripcion, 'Descripción vigente');
  assert.equal(e.consultas(), 2, 'una sola consulta al catálogo para regenerar');
  assert.equal(e.redis.hashes.get(DATOS).descripcion, 'Descripción vigente', 'y quedó publicada');
  assert.equal(e.redis.valores.get(STOCK), '2');
  assert.equal(e.redis.ttls.get(STOCK), 40);
});

test('una clave de otro formato, de un formato anterior, dañada, incompleta o de otro producto también se regenera', async () => {
  const e = escenario();
  const regenera = async (preparar, motivo) => {
    await e.servicio.obtener(1); // deja un hash válido
    const antes = e.consultas();
    preparar(e.redis.hashes.get(DATOS));
    const producto = await e.servicio.obtener(1);
    assert.equal(producto.descripcion, 'Flash', motivo);
    assert.equal(e.consultas(), antes + 1, `${motivo}: debía regenerar desde el catálogo`);
    assert.equal(e.redis.hashes.get(DATOS)._formato, '1', `${motivo}: y dejar un hash válido`);
  };
  await regenera((h) => { h._formato = '0'; }, 'formato distinto');
  await regenera((h) => { h.oferta_flash = '{inválido'; }, 'JSON dañado');
  await regenera((h) => { delete h.vendedor_nombre; }, 'falta un campo');
  await regenera((h) => { h.id = '2'; }, 'id de otro producto');
  await regenera((h) => { h.oferta_flash = 'null'; }, 'sin datos de oferta');
  await regenera((h) => { delete h.generado_en; }, 'sin fecha de generación');

  // El formato anterior de este mismo nombre era UNA CADENA JSON: se descarta en vez de fallar.
  await e.redis.del(DATOS);
  e.redis.valores.set(DATOS, JSON.stringify({ id: 1, descripcion: 'cadena vieja' }));
  assert.equal((await e.servicio.obtener(1)).descripcion, 'Flash');
  assert.equal(e.redis.valores.has(DATOS), false);
  assert.equal(e.redis.hashes.get(DATOS)._formato, '1');
});

test('una copia demasiado vieja se regenera aunque se siga leyendo: acota una invalidación perdida', async () => {
  const e = escenario();
  const { VIDA_MAXIMA_SEGUNDOS } = e.servicio;
  const envejecer = (segundos) => { e.redis.hashes.get(DATOS).generado_en = new Date(Date.now() - segundos * 1000).toISOString(); };

  await e.servicio.obtener(1);
  // Alguien editó el precio, pero Redis estaba inalcanzable y la invalidación se perdió:
  // la copia vieja sigue ahí, y cada lectura le renueva el TTL por inactividad.
  e.doc.oferta_flash.precio_oferta = 5;
  for (let i = 0; i < 3; i += 1) assert.equal((await e.servicio.obtener(1)).oferta_flash.precio_oferta, 8, 'dentro de su vida sigue sirviendo lo guardado');
  assert.equal(e.consultas(), 1);

  envejecer(VIDA_MAXIMA_SEGUNDOS - 5); // todavía dentro del tope
  assert.equal((await e.servicio.obtener(1)).oferta_flash.precio_oferta, 8);
  assert.equal(e.consultas(), 1);

  envejecer(VIDA_MAXIMA_SEGUNDOS + 5); // pasado el tope, la lectura descarta y regenera
  assert.equal((await e.servicio.obtener(1)).oferta_flash.precio_oferta, 5, 'se entera del precio nuevo sin que nadie lo invalide');
  assert.equal(e.consultas(), 2);
  assert.equal(JSON.parse(e.redis.hashes.get(DATOS).oferta_flash).precio_oferta, 5);
  assert.ok(Date.now() - Date.parse(e.redis.hashes.get(DATOS).generado_en) < 5000, 'y la copia nueva empieza su vida de cero');

  // Un reloj adelantado tampoco hace pasar por fresca una copia "del futuro".
  e.redis.hashes.get(DATOS).generado_en = new Date(Date.now() + (VIDA_MAXIMA_SEGUNDOS + 5) * 1000).toISOString();
  await e.servicio.obtener(1);
  assert.equal(e.consultas(), 3);
});

test('editar el producto o pausar la oferta invalida los datos (sube la revisión); la siguiente lectura regenera, sin reponer cupo', async () => {
  const e = escenario();
  await e.servicio.obtener(1);
  e.redis.valores.set(STOCK, '2');
  e.redis.ttls.set(STOCK, 40);
  e.doc.descripcion = 'Descripción actual';
  await e.servicio.actualizar(e.doc);
  assert.equal(e.redis.valores.get(REVISION), '1');
  assert.equal(e.redis.hashes.has(DATOS), false, 'el escritor borra; no publica él mismo');
  assert.equal((await e.servicio.obtener(1)).descripcion, 'Descripción actual');

  e.doc.oferta_flash.activo = false;
  await e.servicio.actualizar(e.doc);
  assert.equal(e.redis.valores.get(REVISION), '2');
  const pausada = await e.servicio.obtener(1);
  assert.equal(pausada.oferta_flash.activo, false);
  assert.equal(e.redis.hashes.has(DATOS), false, 'pausada: no ocupa Redis');
  assert.equal(e.redis.valores.get(STOCK), '2');
  assert.equal(e.redis.ttls.get(STOCK), 40);
});

test('una regeneración que empezó antes de una edición no puede publicar datos viejos', async () => {
  const e = escenario();
  const viejo = JSON.parse(JSON.stringify(e.doc)); // lo que el lector alcanzó a leer antes de la edición
  e.alConsultar(async (n) => {
    if (n > 1) return e.doc;
    e.doc.descripcion = 'Edición reciente';
    await e.servicio.actualizar(e.doc); // la edición llega mientras el lector todavía tiene lo viejo
    return viejo;
  });
  const producto = await e.servicio.obtener(1);
  assert.equal(producto.descripcion, 'Edición reciente', 'el lector se entera y vuelve a leer');
  assert.equal(e.consultas(), 2);
  assert.equal(e.redis.hashes.get(DATOS).descripcion, 'Edición reciente', 'lo viejo nunca llegó a Redis');
});

test('sin oferta activa (pausada, vencida, producto inactivo o sin oferta) no se guarda nada en Redis', async () => {
  const e = escenario();
  e.doc.oferta_flash.activo = false;
  assert.equal((await e.servicio.obtener(1)).oferta_flash.activo, false);

  e.doc.oferta_flash.activo = true;
  e.doc.oferta_flash.vigente_hasta = new Date(Date.now() - 1000);
  assert.equal((await e.servicio.obtener(1)).descripcion, 'Flash');

  e.doc.oferta_flash.vigente_hasta = new Date(Date.now() + 60000);
  e.doc.estado = 'inactivo';
  assert.equal((await e.servicio.obtener(1)).estado, 'inactivo');

  e.doc.estado = 'activo';
  delete e.doc.oferta_flash;
  assert.equal((await e.servicio.obtener(1)).oferta_flash, null);

  assert.equal(e.redis.hashes.size, 0);
  assert.equal(e.redis.valores.size, 0);
});

test('un producto que no existe se rechaza, y con Redis caído la lectura sigue saliendo del catálogo', async () => {
  const e = escenario();
  e.alConsultar(async () => null);
  await assert.rejects(e.servicio.obtener(1), /no encontrado/);

  const caido = escenario();
  caido.redis.leerOferta = async () => { throw new Error('Redis caído'); };
  caido.redis.publicarOferta = async () => { throw new Error('Redis caído'); };
  caido.redis.invalidarOferta = async () => { throw new Error('Redis caído'); };
  assert.equal((await caido.servicio.obtener(1)).oferta_flash.precio_oferta, 8);
  await caido.servicio.actualizar(caido.doc); // invalidar tampoco rompe al escritor
});
