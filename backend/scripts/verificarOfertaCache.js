require('dotenv').config();
const mongoose = require('mongoose');
const prisma = require('../src/config/prisma');
const redisConfig = require('../src/config/redis');
// Igual que verificarOfertaFlash.js: ofertaFlashService/ofertaDatosService leen el
// catálogo y Mongoose necesita Categoria registrado en el proceso.
require('../src/models/mongo/Categoria');
const Producto = require('../src/models/mongo/Producto');
const { conectar: conectarMongo } = require('../src/config/mongo');
const ofertaDatos = require('../src/services/ofertaDatosService');
const ofertaFlashService = require('../src/services/ofertaFlashService');
const catalogoSyncService = require('../src/services/catalogoSyncService');
const { afirmar, prepararCuenta, asegurarProducto } = require('./lib/datosPrueba');

// Evidencia, contra un Redis de verdad, de que los datos de una oferta flash se
// guardan con la estructura del carrito y se REGENERAN cuando hace falta (ver el
// comentario de ofertaDatosService.js: hash con marca de formato + revisión + TTL
// deslizante + lectura atómica en Lua). Las pruebas aisladas (`npm run test:redis`)
// cubren la lógica con un Redis simulado; esto prueba que el Lua real hace lo
// mismo. Usa un producto SINTÉTICO — no toca la oferta real del producto #1 — y lo
// deja pausado y sin claves en Redis al terminar.
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await conectarMongo();
  const redis = redisConfig.conectar();
  const mayorista = await prepararCuenta('fraude.mayorista@example.com', 'Fraude Mayorista', 'tok_fraude_mayorista', { rol: 'vendedor', nacimiento: '1984-02-02' });
  const producto = await asegurarProducto(mayorista.usuario, '[PRUEBA flash] Producto de la caché de oferta', 25, {
    subcategoria: 'Cocina', atributos: [{ nombre: 'Material', valor: 'Acero' }, { nombre: 'Color', valor: 'Gris' }], cantidad: 10,
  });
  const id = producto.id;
  const datos = `oferta:${id}:datos`;
  const revision = `oferta:${id}:revision`;
  const cupo = `oferta:${id}:stock`;
  const ofertaDe = (hastaEnMs, activo = true) => ({
    activo, precio_oferta: 20, stock_oferta: 5, vigente_desde: new Date(Date.now() - 60000), vigente_hasta: new Date(Date.now() + hastaEnMs),
  });
  const preparar = async (hastaEnMs = 2 * 3600000, { activo = true, estado = 'activo', descripcion = '[PRUEBA flash] Producto de la caché de oferta' } = {}) => {
    await Producto.updateOne({ producto_id: id }, { $set: { estado, descripcion, oferta_flash: ofertaDe(hastaEnMs, activo) } });
    await ofertaDatos.invalidar(id);
  };
  const campos = async () => redis.hgetall(datos);
  const sembrarCupo = async () => { await redis.set(cupo, '3', 'EX', 3600); };

  try {
    await redis.del(datos, revision, cupo);
    await preparar();
    await sembrarCupo();

    // --- 1) Lectura fría: se genera el hash con TODOS los datos ---
    const antes = Date.now();
    const generado = await ofertaDatos.obtener(id);
    afirmar(generado.descripcion === '[PRUEBA flash] Producto de la caché de oferta' && generado.oferta_flash.precio_oferta === 20, 'la lectura fría debe devolver el producto con su oferta');
    afirmar((await redis.type(datos)) === 'hash', 'los datos de la oferta deben ser un HASH (como el carrito), no una cadena');
    const hash = await campos();
    afirmar(hash._formato === ofertaDatos.FORMATO, 'el hash debe llevar su marca de formato');
    for (const campo of ['id', 'descripcion', 'estado', 'imagen_url', 'imagenes', 'atributos', 'subcategoria_id', 'vendedor_id', 'vendedor_nombre', 'precio_normal', 'resenas_resumen', 'version', 'oferta_flash', 'generado_en', 'vence_en']) {
      afirmar(hash[campo] !== undefined, `falta el campo "${campo}" en el hash de la oferta`);
    }
    afirmar(JSON.parse(hash.atributos).length === 2 && hash.vendedor_id === String(mayorista.usuario.id_usuario) && Number(hash.precio_normal) === 25, 'el hash debe traer atributos, vendedor y precio normal');
    afirmar(!Object.keys(hash).some((c) => /inventario|cantidad/.test(c)), 'el inventario real no se copia: su autoridad es MySQL y el cupo es otra clave');
    const ttlFrio = await redis.ttl(datos);
    afirmar(ttlFrio > 440 && ttlFrio <= 450, `el TTL por inactividad debe ser ~450 s (es ${ttlFrio})`);
    afirmar(Math.abs(Number(hash.vence_en) - Math.floor(new Date(generado.oferta_flash.vigente_hasta).getTime() / 1000)) <= 1, '`vence_en` debe ser el fin de la oferta');
    const viaServicio = await ofertaFlashService.consultarStock(id);
    afirmar(viaServicio.activo === true && viaServicio.restante === 3 && viaServicio.producto.imagenes && viaServicio.producto.atributos.length === 2, 'consultarStock debe servir todos los datos y el cupo en vivo');
    console.log(`OK 1: lectura fría → hash con ${Object.keys(hash).length} campos (formato ${hash._formato}), TTL ${ttlFrio}s.`);

    // --- 2) TTL deslizante: leer la oferta renueva su vida ---
    await redis.expire(datos, 100);
    await ofertaDatos.obtener(id);
    const ttlRenovado = await redis.ttl(datos);
    afirmar(ttlRenovado > 440, `leer la oferta debe renovar el TTL a ~450 s (quedó en ${ttlRenovado})`);
    console.log(`OK 2: TTL deslizante — con 100 s de vida, una lectura lo devuelve a ${ttlRenovado}s.`);

    // --- 3) Expiró: se regenera sola, sin reiniciar el contador del cupo ---
    const generadoAntes = (await campos()).generado_en;
    await esperar(5);
    await redis.pexpire(datos, 1);
    await esperar(50);
    afirmar((await redis.exists(datos)) === 0, 'la clave debía haber vencido');
    await Producto.updateOne({ producto_id: id }, { $set: { descripcion: '[PRUEBA flash] Descripción editada' } }); // cambió mientras no estaba en Redis
    const regenerado = await ofertaDatos.obtener(id);
    afirmar(regenerado.descripcion === '[PRUEBA flash] Descripción editada', 'al vencer, la lectura debe regenerar con lo vigente del catálogo');
    const hashNuevo = await campos();
    afirmar(hashNuevo._formato === '1' && hashNuevo.generado_en !== generadoAntes, 'y dejar publicado un hash nuevo');
    afirmar((await redis.get(cupo)) === '3', 'regenerar los datos NO debe reiniciar el contador del cupo');
    console.log('OK 3: la clave venció → se regeneró sola con lo vigente, y el cupo siguió en 3.');

    // --- 4) Cómo se detecta que hay que regenerar: formato, estructura, tipo ---
    await preparar(2 * 3600000, { descripcion: '[PRUEBA flash] Producto de la caché de oferta' });
    const casos = [
      ['formato distinto', async () => { await ofertaDatos.obtener(id); await redis.hset(datos, '_formato', '0'); }],
      ['un campo con JSON dañado', async () => { await ofertaDatos.obtener(id); await redis.hset(datos, 'oferta_flash', '{inválido'); }],
      ['un campo ausente', async () => { await ofertaDatos.obtener(id); await redis.hdel(datos, 'vendedor_nombre'); }],
      ['el hash de otro producto', async () => { await ofertaDatos.obtener(id); await redis.hset(datos, 'id', String(id + 1000)); }],
      ['una clave del formato anterior (una cadena JSON en el mismo nombre)', async () => { await redis.del(datos); await redis.set(datos, JSON.stringify({ id, descripcion: 'cadena vieja' }), 'EX', 60); }],
      // La red de seguridad de una invalidación perdida: cada lectura renueva el TTL,
      // así que sin un tope de edad una oferta muy consultada no soltaría nunca la copia.
      ['una copia más vieja que su vida máxima, aunque se siga leyendo', async () => {
        await ofertaDatos.obtener(id);
        await redis.hset(datos, 'generado_en', new Date(Date.now() - (ofertaDatos.VIDA_MAXIMA_SEGUNDOS + 5) * 1000).toISOString());
      }],
    ];
    for (const [motivo, estropear] of casos) {
      await estropear();
      const producto = await ofertaDatos.obtener(id);
      afirmar(producto.descripcion === '[PRUEBA flash] Producto de la caché de oferta', `${motivo}: debe regenerar con el catálogo`);
      const regenerada = await campos();
      afirmar((await redis.type(datos)) === 'hash' && regenerada._formato === '1', `${motivo}: debe dejar un hash válido (sin WRONGTYPE)`);
      afirmar(Date.now() - Date.parse(regenerada.generado_en) < 30000, `${motivo}: la copia nueva debe haberse generado ahora`);
    }
    afirmar((await redis.get(cupo)) === '3', 'ninguna regeneración debe tocar el cupo');
    console.log(`OK 4: se regenera ante ${casos.length} señales (formato, JSON dañado, campo ausente, otro producto, clave de formato anterior, copia más vieja que ${ofertaDatos.VIDA_MAXIMA_SEGUNDOS} s).`);

    // --- 5) Una edición invalida (sube la revisión); la siguiente lectura regenera ---
    const revisionAntes = Number((await redis.get(revision)) || 0);
    await Producto.updateOne({ producto_id: id }, { $set: { descripcion: '[PRUEBA flash] Tras la edición' } });
    await ofertaDatos.actualizar(await Producto.findOne({ producto_id: id }));
    afirmar(Number(await redis.get(revision)) === revisionAntes + 1 && (await redis.exists(datos)) === 0, 'editar debe subir la revisión y borrar los datos');
    afirmar((await ofertaDatos.obtener(id)).descripcion === '[PRUEBA flash] Tras la edición', 'la siguiente lectura debe regenerar con lo nuevo');
    console.log('OK 5: una edición sube la revisión y borra los datos; la lectura siguiente regenera.');

    // --- 6) Publicar con una revisión vieja no pisa nada; y la concurrencia en frío converge ---
    const hashAntes = await campos();
    const vieja = String(Number(await redis.get(revision)) - 1);
    const rechazada = await redis.publicarOferta(datos, revision, vieja, 450, JSON.stringify({ descripcion: 'DATOS VIEJOS' }), '1');
    afirmar(rechazada === 0 && (await campos()).descripcion === hashAntes.descripcion, 'publicar con una revisión vieja debe devolver 0 y no tocar los datos');
    await redis.del(datos);
    const lecturas = await Promise.all(Array.from({ length: 20 }, () => ofertaDatos.obtener(id)));
    afirmar(lecturas.every((p) => p.descripcion === '[PRUEBA flash] Tras la edición'), '20 lecturas simultáneas en frío deben devolver lo mismo');
    afirmar((await campos())._formato === '1' && (await redis.get(cupo)) === '3', 'y dejar un solo hash válido, con el cupo intacto');
    console.log('OK 6: una revisión vieja no publica (devuelve 0); 20 lecturas simultáneas en frío convergen en un hash válido.');

    // --- 7) El TTL nunca pasa del fin de la oferta ---
    await preparar(40000);
    await ofertaDatos.obtener(id);
    const ttlCorto = await redis.ttl(datos);
    afirmar(ttlCorto > 0 && ttlCorto <= 40, `con la oferta terminando en 40 s el TTL no puede pasar de 40 s (es ${ttlCorto})`);
    await preparar(4000);
    await ofertaDatos.obtener(id);
    await esperar(2200);
    await ofertaDatos.obtener(id); // una lectura a mitad de camino: renueva, pero solo hasta el fin de la oferta
    const ttlFinal = await redis.ttl(datos);
    afirmar(ttlFinal >= 0 && ttlFinal <= 2, `a ~2 s del fin, leer no puede estirar el TTL a 450 s (quedó en ${ttlFinal})`);
    await esperar(2500);
    afirmar((await redis.exists(datos)) === 0, 'terminada la oferta, la clave debe haber desaparecido sola');
    const vencida = await ofertaFlashService.consultarStock(id);
    afirmar(vencida.activo === false && vencida.motivo === 'vencida', 'una oferta vencida se informa como tal');
    afirmar((await redis.exists(datos)) === 0, 'y una oferta vencida NO vuelve a ocupar Redis');
    console.log(`OK 7: el TTL (${ttlCorto}s) y su renovación (${ttlFinal}s) no pasan del fin de la oferta; vencida, se limpia sola y no se regenera.`);

    // --- 8) Oferta pausada o producto inactivo: no se guarda nada ---
    await preparar(2 * 3600000, { activo: false });
    const pausada = await ofertaDatos.obtener(id);
    afirmar(pausada.oferta_flash.activo === false && (await redis.exists(datos)) === 0, 'una oferta pausada se lee del catálogo y no ocupa Redis');
    await preparar(2 * 3600000, { estado: 'inactivo' });
    await ofertaDatos.obtener(id);
    afirmar((await redis.exists(datos)) === 0, 'un producto inactivo tampoco');
    afirmar((await redis.get(cupo)) === '3', 'y el cupo nunca se tocó en toda la verificación');
    console.log('OK 8: oferta pausada o producto inactivo → se lee del catálogo y no se guarda nada en Redis.');

    // --- 9) Todo escritor de lo que se copia invalida: la reconciliación del inventario ---
    // Mongo guarda el precio normal como COPIA del de MySQL; si se desvía y la oferta
    // lo cacheó, reconciliar tiene que arrastrar también la copia de Redis. (Corre la
    // reconciliación real, la misma del botón del administrador: idempotente, solo
    // reescribe en Mongo lo que MySQL dice.)
    await preparar();
    await Producto.updateOne({ producto_id: id }, { $set: { 'inventario.precio': 999 } }); // desvío en la copia de Mongo
    await ofertaDatos.invalidar(id);
    afirmar(Number((await ofertaDatos.obtener(id)).precio_normal) === 999 && (await redis.exists(datos)) === 1, 'la copia desviada quedó cacheada en Redis');
    await catalogoSyncService.recalcularInventario();
    afirmar((await redis.exists(datos)) === 0, 'reconciliar el inventario debe invalidar la copia de la oferta activa');
    afirmar(Number((await ofertaDatos.obtener(id)).precio_normal) === 25, 'y la siguiente lectura debe traer el precio de MySQL, no el desviado');
    afirmar((await redis.get(cupo)) === '3', 'sin tocar el cupo');
    console.log('OK 9: reconciliar el inventario invalida la copia de una oferta activa; la lectura siguiente regenera con el precio de MySQL.');

    console.log('Todas las verificaciones de la caché de la oferta flash pasaron.');
  } finally {
    // Limpieza: el producto sintético queda pausado y sin claves en Redis.
    await Producto.updateOne(
      { producto_id: id },
      { $set: { estado: 'inactivo', descripcion: '[PRUEBA flash] Producto de la caché de oferta', 'oferta_flash.activo': false } }
    );
    await redis.del(datos, revision, cupo);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await mongoose.disconnect();
    redisConfig.cerrar();
  });
