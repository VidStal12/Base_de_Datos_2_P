const { conectar } = require('../config/redis');
const { conectar: conectarMongo } = require('../config/mongo');
const Producto = require('../models/mongo/Producto');

// Datos de una oferta flash en Redis (Entrega 2, ver IA/ENTREGA-2-PLAN.md §4.2) —
// con la MISMA estructura y el MISMO protocolo de regeneración que el carrito
// (cartService.js), para que las dos cachés de Redis se lean y se razonen igual:
//
//   oferta:{id}:datos      hash: `_formato` + todos los datos del producto y de su
//                          oferta, un campo cada uno (los anidados, en JSON)
//   oferta:{id}:revision   contador; sube con cada edición del producto o de la
//                          oferta. Sin TTL, como `carrito:{id}:revision`
//   oferta:{id}:stock      el cupo en vivo — OTRA clave, atómica e independiente
//                          (ofertaFlashService.js): regenerar los datos nunca la toca
//
// Solo se guarda mientras la oferta está ACTIVA (activo, producto activo y sin
// vencer — corriendo o programada): un producto sin oferta, pausada o vencida se
// lee directo de Mongo y no ocupa nada en Redis.
//
// CÓMO SE DETECTA QUE LA CLAVE HAY QUE REGENERARLA (igual que el carrito):
//   1. Una sola lectura atómica (script Lua `leerOferta`) trae la revisión y todos
//      los campos del hash, y de paso renueva el TTL por inactividad — sin pasar
//      nunca del fin de la oferta (`vence_en`).
//   2. Con eso se decide si hay que regenerar. Hay que hacerlo si:
//        a. el hash NO existe: venció el TTL, Redis lo desalojó, se reinició o
//           alguien lo invalidó (es la señal de "expiró");
//        b. su `_formato` no es el vigente (cambió la estructura; o la clave es de
//           un formato anterior — una cadena JSON — que el script ya descartó);
//        c. un campo no se puede leer (JSON dañado), falta alguno o el `id` no
//           coincide con el producto pedido;
//        d. la copia es demasiado vieja: se generó hace más de VIDA_MAXIMA aunque
//           se siga leyendo. Es la red de seguridad de una invalidación perdida
//           (Redis inalcanzable justo cuando alguien editó): como cada lectura
//           renueva el TTL, sin este tope una oferta muy consultada conservaría
//           datos viejos — el precio de oferta que se cobra sale de esta copia —
//           hasta su fin. A diferencia del carrito, esta copia la lee todo el mundo.
//   3. Regenerar = leer Mongo, armar el hash completo y publicarlo con
//      `publicarOferta`, que SOLO escribe si la revisión sigue siendo la que se
//      leyó en el paso 1. Cada escritor de algo que se copia aquí sube esa
//      revisión (`invalidar`): productoService.actualizar, configurar o pausar la
//      oferta, resenaService.crear (el resumen de reseñas) y
//      catalogoSyncService.recalcularInventario (el precio normal). Así una
//      regeneración lenta que empezó ANTES de una edición no puede resucitar datos
//      viejos: su publicación falla y se vuelve a leer, hasta INTENTOS veces.
// Regenerar solo toca `datos`: el contador del cupo no se reinicia.
const TTL_SEGUNDOS = 450; // por inactividad, como el carrito; cada lectura lo renueva
const VIDA_MAXIMA_SEGUNDOS = 600; // edad máxima de una copia, se lea o no (señal d)
const FORMATO = '1';
const INTENTOS = 3;
const clave = (id) => `oferta:${id}:datos`;
const revisionClave = (id) => `oferta:${id}:revision`;
const ahoraEnSegundos = () => Math.floor(Date.now() / 1000);

// Todo lo que la oferta necesita para mostrarse y comprarse sin volver al catálogo
// en cada lectura. Lo único que NO se copia es la cantidad real de inventario:
// cambia con cada venta, su autoridad es MySQL y el cupo de la oferta vive en
// `oferta:{id}:stock`.
function datos(doc) {
  const principal = doc.imagenes?.find((img) => img.principal) || doc.imagenes?.[0];
  const oferta = doc.oferta_flash;
  return {
    id: doc.producto_id,
    descripcion: doc.descripcion,
    estado: doc.estado,
    imagen_url: principal?.url || '',
    imagenes: (doc.imagenes || []).map(({ url, alt, orden, principal: esPrincipal }) => ({ url, alt, orden, principal: esPrincipal })),
    atributos: (doc.atributos || []).map(({ nombre, valor }) => ({ nombre, valor })),
    subcategoria_id: doc.subcategoria_id ? String(doc.subcategoria_id._id || doc.subcategoria_id) : null,
    vendedor_id: doc.vendedor_id,
    vendedor_nombre: doc.vendedor_nombre,
    precio_normal: doc.inventario?.precio === undefined ? null : Number(doc.inventario.precio),
    resenas_resumen: { promedio: doc.resenas_resumen?.promedio ?? 0, cantidad: doc.resenas_resumen?.cantidad ?? 0 },
    version: doc.version ?? 1,
    oferta_flash: oferta
      ? { activo: oferta.activo, precio_oferta: oferta.precio_oferta, stock_oferta: oferta.stock_oferta, vigente_desde: oferta.vigente_desde, vigente_hasta: oferta.vigente_hasta, revision: oferta.revision }
      : null,
  };
}

// Un campo por dato; los valores sueltos como texto y los anidados en JSON. El
// orden de CAMPOS es también la lista de lo que TIENE que estar para que una
// lectura sea válida.
const LECTORES = {
  id: Number,
  vendedor_id: Number,
  version: Number,
  precio_normal: (valor) => (valor === '' ? null : Number(valor)),
  subcategoria_id: (valor) => (valor === '' ? null : valor),
  imagenes: JSON.parse,
  atributos: JSON.parse,
  resenas_resumen: JSON.parse,
  oferta_flash: JSON.parse,
};
const CAMPOS = ['id', 'descripcion', 'estado', 'imagen_url', 'imagenes', 'atributos', 'subcategoria_id', 'vendedor_id', 'vendedor_nombre', 'precio_normal', 'resenas_resumen', 'version', 'oferta_flash'];
const JSON_CAMPOS = new Set(['imagenes', 'atributos', 'resenas_resumen', 'oferta_flash']);

// `vence_en` (epoch en segundos) lo usa el script de lectura para no renovar el
// TTL más allá del fin de la oferta; `generado_en` dice cuándo se regeneró y de
// ahí sale la edad de la copia (señal d).
function aCampos(producto, venceEn) {
  const campos = { generado_en: new Date().toISOString(), vence_en: String(venceEn) };
  for (const campo of CAMPOS) {
    const valor = producto[campo];
    campos[campo] = JSON_CAMPOS.has(campo) ? JSON.stringify(valor) : valor === null || valor === undefined ? '' : String(valor);
  }
  return campos;
}

// null = hay que regenerar (formato distinto, campo ausente o ilegible, de otro
// producto, o demasiado vieja). Nunca lanza.
function deCampos(crudo, id, ahoraMs) {
  if (crudo._formato !== FORMATO) return null;
  // El valor absoluto cubre también un reloj adelantado: una copia "del futuro"
  // tampoco se considera fresca.
  const generada = Date.parse(crudo.generado_en);
  if (!Number.isFinite(generada) || Math.abs(ahoraMs - generada) > VIDA_MAXIMA_SEGUNDOS * 1000) return null;
  try {
    const producto = {};
    for (const campo of CAMPOS) {
      const valor = crudo[campo];
      if (valor === undefined) return null;
      producto[campo] = LECTORES[campo] ? LECTORES[campo](valor) : valor;
    }
    if (producto.id !== id || !Number.isInteger(producto.vendedor_id)) return null;
    if (!producto.oferta_flash || typeof producto.oferta_flash !== 'object') return null;
    return producto;
  } catch {
    return null;
  }
}

// Hasta cuándo vale tener esto en Redis (epoch en segundos), o null si la oferta no
// está activa y por lo tanto no se guarda.
function venceEn(producto) {
  const oferta = producto.oferta_flash;
  if (producto.estado !== 'activo' || oferta?.activo !== true) return null;
  const hasta = Math.floor(new Date(oferta.vigente_hasta).getTime() / 1000);
  return Number.isFinite(hasta) && hasta > ahoraEnSegundos() ? hasta : null;
}

async function cacheSegura(operacion) {
  try {
    return await operacion(conectar());
  } catch (err) {
    console.error('No se pudo leer/actualizar la caché de la oferta flash:', err.message);
  }
}

// Sube la revisión y borra los datos: la siguiente lectura los regenera con lo
// vigente. Lo llaman los escritores (editar el producto, configurar o pausar la
// oferta) — nunca publican datos ellos mismos, igual que las mutaciones del carrito.
async function invalidar(id) {
  await cacheSegura((redis) => redis.invalidarOferta(clave(id), revisionClave(id)));
}

async function actualizar(doc) {
  return invalidar(doc.producto_id);
}

async function obtener(id) {
  let producto;
  for (let intento = 0; intento < INTENTOS; intento += 1) {
    const cache = await cacheSegura((redis) => redis.leerOferta(clave(id), revisionClave(id), TTL_SEGUNDOS, ahoraEnSegundos()));
    const revision = cache?.[0] || '0';
    const campos = cache?.[1] || [];
    const crudo = {};
    for (let i = 0; i < campos.length; i += 2) crudo[campos[i]] = campos[i + 1];
    const guardado = deCampos(crudo, id, Date.now());
    if (guardado) return guardado; // caliente: ni Mongo ni SQL

    // Fría, vencida, de otro formato, dañada, invalidada o demasiado vieja: se
    // regenera desde Mongo.
    await conectarMongo();
    const doc = await Producto.findOne({ producto_id: id })
      .select('producto_id descripcion estado imagenes atributos subcategoria_id vendedor_id vendedor_nombre inventario.precio resenas_resumen version oferta_flash')
      .lean();
    if (!doc) throw new Error('Producto no encontrado');
    producto = datos(doc);

    const vence = venceEn(producto);
    if (vence === null) return producto; // sin oferta activa: no se guarda nada en Redis
    const ttl = Math.min(TTL_SEGUNDOS, vence - ahoraEnSegundos());
    const publicada = await cacheSegura((redis) =>
      redis.publicarOferta(clave(id), revisionClave(id), revision, ttl, JSON.stringify(aCampos(producto, vence)), FORMATO)
    );
    if (publicada === 0) continue; // hubo una edición durante esta lectura: volver a leer
    return producto;
  }
  // La revisión siguió cambiando durante todos los intentos: para quien LEE no es un
  // error — se le devuelve lo que se leyó de Mongo, sin publicarlo.
  return producto;
}

module.exports = { obtener, actualizar, invalidar, TTL_SEGUNDOS, VIDA_MAXIMA_SEGUNDOS, FORMATO };
