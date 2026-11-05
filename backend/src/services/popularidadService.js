const crypto = require('node:crypto');
const Producto = require('../models/mongo/Producto');
const { conectar } = require('../config/mongo');
const { conCircuito, indice } = require('../config/elasticsearch');
const { registrarFallo } = require('../utils/resiliencia');

// Popularidad de los productos para el ranking de la búsqueda (IA/PLAN-ELASTICSEARCH-BUSQUEDA.md §17,
// fórmula en rankingBusqueda.js). Dos números viajan al índice: los CLICS (veces que alguien abrió la ficha)
// y las VENTAS (`total_vendido`). Las ventas ya existían, pero el índice las tenía atrasadas: el checkout
// descuenta total_vendido en Mongo y nunca reindexaba, así que «más vendido» se ordenaba con el valor de la
// última edición del producto. Ahora cada compra marca el producto y este servicio lo refresca.
//
// POR QUÉ UN BUFFER Y NO UNA ESCRITURA POR CLIC. Una actualización parcial en Elasticsearch reescribe el
// documento entero (Lucene no modifica en el sitio), vector de 384 números incluido. Hacerlo en cada visita
// a una ficha sería regalar el costo de indexar a una lectura. Los clics se juntan en memoria y cada
// `intervaloMs` (60 s) se vuelcan de una vez: un `$inc` por producto en Mongo (la fuente) y una sola petición
// `_bulk` al índice con los valores vigentes. Perder el buffer en una caída del proceso cuesta, como mucho, el
// último minuto de clics: es una señal de ordenamiento, no un dato contable, y por eso no merece Redis ni
// outbox (mismo criterio de mejor esfuerzo que busquedaSyncService.js).
//
// QUÉ ES UN CLIC. Una persona distinta abriendo la ficha de un producto activo, una vez por ventana
// (`ventanaMs`, 30 min): recargar la página o volver atrás no suma. La persona es la cuenta si hay sesión;
// si no, un hash de IP + navegador. No cuentan el vendedor dueño del producto ni un administrador (abrir la
// ficha para editarla no es interés de un comprador). Es resistencia a lo accidental, no a un ataque: quien
// quiera inflar clics con miles de navegadores distintos puede; para eso está la revisión humana del resto
// del sistema, y el peso de los clics es el menor de los tres (rankingBusqueda.PESOS).
//
// Todo está en memoria del proceso: con varias instancias del backend cada una cuenta lo suyo y los `$inc`
// se suman (conmutativos); lo único que no se comparte es la ventana de deduplicación.

const MAXIMO_PENDIENTES = 5000; // productos distintos con clics sin volcar: tope contra una Mongo caída por horas
const MAXIMO_VISTOS = 20000; // pares (visitante, producto) recordados para no contar dos veces

// POPULARIDAD_ENABLED (true), POPULARIDAD_INTERVALO_MS (60000) y POPULARIDAD_VENTANA_CLIC_MS (1800000).
// Un valor mal escrito se rechaza en vez de caer en el defecto sin avisar (como bloqueoService.configuracion).
function configuracion(env = process.env) {
  const intervaloMs = Number(env.POPULARIDAD_INTERVALO_MS || 60000);
  if (!Number.isInteger(intervaloMs) || intervaloMs < 1000 || intervaloMs > 2147483647) {
    throw new Error('POPULARIDAD_INTERVALO_MS debe ser un entero entre 1000 y 2147483647');
  }
  const ventanaMs = Number(env.POPULARIDAD_VENTANA_CLIC_MS || 1800000);
  if (!Number.isInteger(ventanaMs) || ventanaMs < 0 || ventanaMs > 86400000) {
    throw new Error('POPULARIDAD_VENTANA_CLIC_MS debe ser un entero entre 0 y 86400000');
  }
  return {
    habilitado: !['false', '0'].includes(String(env.POPULARIDAD_ENABLED || 'true').toLowerCase()),
    intervaloMs,
    ventanaMs,
  };
}

const clicsPendientes = new Map(); // producto_id → clics sin sumar todavía en Mongo
const porRefrescar = new Set(); // producto_id cuya copia del índice hay que igualar a Mongo (clics y ventas)
const vistos = new Map(); // «visitante|producto» → cuándo se contó por última vez
let temporizador = null;
let vaciando = null;

function visitanteDe({ usuario, ip, userAgent }) {
  if (usuario?.id_usuario) return `u:${usuario.id_usuario}`;
  return `a:${crypto.createHash('sha256').update(`${ip ?? ''}|${userAgent ?? ''}`).digest('hex').slice(0, 24)}`;
}

function podarVistos(ahoraMs, ventanaMs) {
  for (const [clave, cuando] of vistos) if (ahoraMs - cuando >= ventanaMs) vistos.delete(clave);
  // Si aun así no cabe (mucho tráfico dentro de una sola ventana), se olvidan los más antiguos.
  for (const clave of [...vistos.keys()].slice(0, Math.max(0, vistos.size - MAXIMO_VISTOS))) vistos.delete(clave);
}

// Cuenta (o no) un clic. Síncrona, barata y nunca lanza: la llama la ruta del detalle y una falla acá no
// debe tocar la respuesta. Devuelve true si el clic se contó.
function registrarClic({ productoId, vendedorId, usuario, ip, userAgent, ahoraMs = Date.now() }, env = process.env) {
  try {
    const { habilitado, ventanaMs } = configuracion(env);
    const id = Number(productoId);
    if (!habilitado || !Number.isInteger(id) || id < 1) return false;
    if (usuario?.rol === 'administrador') return false;
    if (usuario?.id_usuario && Number(usuario.id_usuario) === Number(vendedorId)) return false;

    const clave = `${visitanteDe({ usuario, ip, userAgent })}|${id}`;
    const ultimo = vistos.get(clave);
    if (ultimo !== undefined && ahoraMs - ultimo < ventanaMs) return false;
    vistos.set(clave, ahoraMs);
    if (vistos.size > MAXIMO_VISTOS) podarVistos(ahoraMs, ventanaMs);

    if (!clicsPendientes.has(id) && clicsPendientes.size >= MAXIMO_PENDIENTES) return false;
    clicsPendientes.set(id, (clicsPendientes.get(id) ?? 0) + 1);
    return true;
  } catch (err) {
    registrarFallo('No se pudo contar el clic de un producto', err);
    return false;
  }
}

// El checkout ya descontó `total_vendido` en Mongo: el índice tiene que enterarse en la próxima vuelta.
// Solo anota los ids (un Set en memoria); el valor se lee de Mongo al volcar.
function marcarVentas(productoIds) {
  for (const id of productoIds ?? []) {
    const numero = Number(id);
    if (Number.isInteger(numero) && numero > 0) porRefrescar.add(numero);
  }
}

// Vuelca lo acumulado: (1) suma los clics en Mongo, la fuente; (2) lee de Mongo los valores vigentes de
// clics y ventas de cada producto tocado; (3) los copia al índice en una sola petición `_bulk`. Solo una
// vuelta a la vez. Si Mongo no responde, lo pendiente se devuelve al buffer para el próximo intento; si falla
// el índice, los productos quedan en `porRefrescar` (Mongo ya tiene la verdad, falta igualar la copia).
// Un producto que el índice no conoce (404) se ignora: lo llenará `npm run busqueda:backfill`.
function vaciar() {
  if (vaciando) return vaciando;
  vaciando = vaciarAhora().finally(() => {
    vaciando = null;
  });
  return vaciando;
}

async function vaciarAhora() {
  const clics = [...clicsPendientes];
  const ids = new Set([...clics.map(([id]) => id), ...porRefrescar]);
  if (ids.size === 0) return { productos: 0, clics: 0 };
  clicsPendientes.clear();
  porRefrescar.clear();

  const devolver = (clicsPorDevolver, idsPorDevolver) => {
    for (const [id, n] of clicsPorDevolver) clicsPendientes.set(id, (clicsPendientes.get(id) ?? 0) + n);
    for (const id of idsPorDevolver) porRefrescar.add(id);
  };

  try {
    await conectar();
  } catch (err) {
    devolver(clics, ids);
    registrarFallo('No se pudo volcar la popularidad de los productos (Mongo no responde; se reintenta)', err);
    return { productos: 0, clics: 0, error: err.message };
  }

  // 1) Mongo: un $inc por producto. Los que fallan se devuelven al buffer; el resto sigue.
  let sumados = 0;
  const fallidos = [];
  for (const [id, n] of clics) {
    try {
      await Producto.updateOne({ producto_id: id }, { $inc: { clics: n } });
      sumados += n;
    } catch (err) {
      fallidos.push([id, n]);
      registrarFallo('No se pudo sumar los clics de un producto en Mongo', err);
    }
  }
  devolver(fallidos, []);

  // 2) y 3) El índice, con lo que Mongo tiene AHORA (valores absolutos, no incrementos: repetir esta
  // escritura es inofensivo).
  try {
    const docs = await Producto.find({ producto_id: { $in: [...ids] } }).select('producto_id clics total_vendido').lean();
    if (docs.length > 0) {
      const operaciones = docs.flatMap((doc) => [
        { update: { _index: indice(), _id: String(doc.producto_id), retry_on_conflict: 3 } },
        { doc: { clics: doc.clics ?? 0, total_vendido: doc.total_vendido ?? 0 } },
      ]);
      const respuesta = await conCircuito((cliente) => cliente.bulk({ operations: operaciones }));
      if (respuesta.errors) {
        for (const item of respuesta.items) {
          const resultado = item.update;
          if (resultado?.error && resultado.status !== 404) {
            porRefrescar.add(Number(resultado._id));
            registrarFallo(`No se pudo actualizar el producto #${resultado._id} en el índice`, new Error(resultado.error.reason));
          }
        }
      }
    }
  } catch (err) {
    for (const id of ids) porRefrescar.add(id);
    registrarFallo('No se pudo copiar la popularidad al índice de búsqueda (se reintenta)', err);
    return { productos: ids.size, clics: sumados, error: err.message };
  }
  return { productos: ids.size, clics: sumados };
}

// El volcado periódico corre dentro del servidor (server.js), no en app.js: importar Express en una prueba no
// inicia ningún temporizador. `unref`: no mantiene vivo el proceso por sí solo.
function iniciar(env = process.env) {
  const { habilitado, intervaloMs } = configuracion(env);
  if (!habilitado || temporizador) return false;
  temporizador = setInterval(() => {
    vaciar().catch((err) => registrarFallo('Falló el volcado de popularidad', err));
  }, intervaloMs);
  temporizador.unref?.();
  return true;
}

// Al apagar el servidor: se detiene el temporizador y se intenta un último volcado, para no perder el minuto en curso.
async function detener() {
  if (temporizador) clearInterval(temporizador);
  temporizador = null;
  await vaciar().catch(() => {});
}

// Solo para pruebas y diagnóstico.
function estado() {
  return { clicsPendientes: new Map(clicsPendientes), porRefrescar: new Set(porRefrescar), vistos: vistos.size };
}

function reiniciar() {
  clicsPendientes.clear();
  porRefrescar.clear();
  vistos.clear();
}

module.exports = { configuracion, registrarClic, marcarVentas, vaciar, iniciar, detener, estado, reiniciar };
