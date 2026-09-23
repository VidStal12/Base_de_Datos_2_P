const prisma = require('../config/prisma');
const { conectar: conectarMongo } = require('../config/mongo');
const { conectar: conectarRedis } = require('../config/redis');
const Producto = require('../models/mongo/Producto');
const checkoutService = require('./checkoutService');
const productoService = require('./productoService');

// Ofertas por tendencia (Entrega 2, ver IA/ENTREGA-2-PLAN.md §4.5) — a
// diferencia de la oferta flash de ofertaFlashService.js (que un vendedor
// configura a mano sobre SU producto), esto analiza el historial real de
// compras de un usuario para encontrar, de forma automática, productos
// similares de OTROS vendedores — sin que nadie la configure. Las dos
// conviven: esto no toca ofertaFlashService.js ni checkoutService.checkout()
// para nada, solo reutiliza checkoutOferta() como guardia 2 (ver comprar()).
const RECHAZADO = -1;
const CANTIDAD_RECOMENDACIONES = 6;
// 15% — simple y fácil de defender en el informe; un lugar natural para
// afinar más adelante (p. ej. mayor descuento cuanto más se aleje del
// vendedor preferido) sin cambiar la mecánica de abajo.
const DESCUENTO_PORCENTAJE = 0.15;
// TTL del caché de la recomendación en Redis, Y del cupo personal de compra
// (ver comprar()) — las dos cosas vencen juntas a propósito: si la
// recomendación ya no está cacheada, tampoco tiene sentido que el cupo para
// comprarla a ese precio siga vivo.
const CACHE_TTL_SEGUNDOS = 3600;
// Cuántas unidades puede llevarse ESTE usuario a su precio recomendado —
// deliberadamente chico (no es una oferta flash con pool compartido entre
// todo el mundo, es "tu propio cupo" para el producto que el análisis
// encontró para vos).
const CUPO_PERSONAL = 2;

function claveCache(usuarioId) {
  return `recomendaciones:${usuarioId}`;
}
function claveCupo(productoId, usuarioId) {
  return `oferta-recomendada:${productoId}:${usuarioId}:stock`;
}

// Misma fórmula usada en calcularRecomendaciones() (para mostrar) y en
// comprar() (para cobrar, sobre un precio recién leído) — separada en una
// función para que las dos SIEMPRE apliquen el mismo redondeo, en vez de
// arriesgar que diverjan si alguien cambia una copia y no la otra.
function calcularPrecioRecomendado(precioNormal) {
  return Math.round(precioNormal * (1 - DESCUENTO_PORCENTAJE) * 100) / 100;
}

// Historial de compras (MySQL, fuente de verdad) resuelto contra el catálogo
// (Mongo) — no hay join real entre las dos bases, se resuelve acá mismo:
// junta compra_detalle.id_producto con Producto.producto_id a mano, en vez
// de forzar una relación que no existe a nivel de base de datos.
async function analizarTendencia(usuarioId) {
  const detalles = await prisma.compra_detalle.findMany({
    where: { compra: { id_usuario: usuarioId } },
    select: { id_producto: true, cantidad: true },
  });
  if (detalles.length === 0) return null;

  await conectarMongo();
  const productoIds = [...new Set(detalles.map((d) => d.id_producto))];
  const productos = await Producto.find({ producto_id: { $in: productoIds } }).lean();
  const porId = new Map(productos.map((p) => [p.producto_id, p]));

  // 1) La subcategoría donde más unidades compró en total — "compra muchos
  // celulares" es exactamente esto: igualdad de subcategoría, ordenado por
  // volumen.
  const unidadesPorSubcategoria = new Map();
  for (const d of detalles) {
    const p = porId.get(d.id_producto);
    if (!p) continue; // producto borrado del catálogo entre que se compró y ahora
    const key = String(p.subcategoria_id);
    unidadesPorSubcategoria.set(key, (unidadesPorSubcategoria.get(key) || 0) + d.cantidad);
  }
  if (unidadesPorSubcategoria.size === 0) return null;
  const [subcategoriaId] = [...unidadesPorSubcategoria.entries()].sort((a, b) => b[1] - a[1])[0];

  // 2) Dentro de esa subcategoría, el valor MÁS común para cada nombre de
  // atributo por separado (no el par nombre+valor con más unidades en
  // general) — así "Almacenamiento" y "RAM" quedan representados los dos,
  // en vez de que uno solo, el más frecuente de todos, tape al resto. Mismo
  // criterio para el vendedor preferido.
  const conteoAtributos = new Map(); // "nombre::valor" -> unidades
  const conteoVendedor = new Map(); // vendedor_id -> unidades
  for (const d of detalles) {
    const p = porId.get(d.id_producto);
    if (!p || String(p.subcategoria_id) !== subcategoriaId) continue;
    for (const { nombre, valor } of p.atributos || []) {
      const key = `${nombre}::${valor}`;
      conteoAtributos.set(key, (conteoAtributos.get(key) || 0) + d.cantidad);
    }
    conteoVendedor.set(p.vendedor_id, (conteoVendedor.get(p.vendedor_id) || 0) + d.cantidad);
  }

  const mejorPorNombre = new Map(); // nombre -> {valor, unidades}
  for (const [key, unidades] of conteoAtributos) {
    const [nombre, valor] = key.split('::');
    const actual = mejorPorNombre.get(nombre);
    if (!actual || unidades > actual.unidades) mejorPorNombre.set(nombre, { valor, unidades });
  }
  const atributosPreferidos = [...mejorPorNombre.entries()].map(([nombre, { valor }]) => ({ nombre, valor }));

  const [vendedorPreferidoId] = [...conteoVendedor.entries()].sort((a, b) => b[1] - a[1])[0] || [];

  return { subcategoriaId, atributosPreferidos, vendedorPreferidoId };
}

// Puntúa cada producto ACTIVO de la subcategoría por cuántos de los
// atributos preferidos comparte — no exige que coincidan TODOS (a
// diferencia del filtro de facetas del catálogo, que sí exige coincidencia
// exacta en todo lo pedido): con un catálogo chico, exigir todo a la vez
// devuelve fácilmente cero resultados. Cualquier vendedor entra, incluido el
// preferido — el punto es mostrar el panorama completo, no excluir al
// vendedor de siempre.
async function buscarCoincidencias(subcategoriaId, atributosPreferidos) {
  const candidatos = await Producto.find({ subcategoria_id: subcategoriaId, estado: 'activo' }).lean();
  const clavesPreferidas = new Set(atributosPreferidos.map(({ nombre, valor }) => `${nombre}::${valor}`));

  return candidatos
    .map((doc) => {
      const score = (doc.atributos || []).reduce(
        (acc, { nombre, valor }) => acc + (clavesPreferidas.has(`${nombre}::${valor}`) ? 1 : 0),
        0
      );
      return { doc, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);
}

async function calcularRecomendaciones(usuarioId) {
  const tendencia = await analizarTendencia(usuarioId);
  if (!tendencia) return { tendencia: null, productos: [] };

  const puntuados = await buscarCoincidencias(tendencia.subcategoriaId, tendencia.atributosPreferidos);
  const productos = puntuados.slice(0, CANTIDAD_RECOMENDACIONES).map(({ doc, score }) => {
    const precioNormal = doc.inventario.precio;
    const precioRecomendado = calcularPrecioRecomendado(precioNormal);
    const principal = doc.imagenes?.find((img) => img.principal) || doc.imagenes?.[0];
    return {
      id: doc.producto_id,
      descripcion: doc.descripcion,
      imagen_url: principal?.url || '',
      vendedor_id: doc.vendedor_id,
      vendedor_nombre: doc.vendedor_nombre,
      atributos: doc.atributos || [],
      precio_normal: precioNormal,
      precio_recomendado: precioRecomendado,
      coincidencias: score,
    };
  });

  return { tendencia, productos };
}

// Cachea el resultado por usuario — el análisis + la búsqueda cruzan dos
// bases y no hace falta recalcularlo en cada vista del catálogo. Mismo TTL
// que rige el cupo personal de compra (ver comprar()), a propósito.
async function recomendar(usuarioId) {
  const redis = conectarRedis();
  const cacheado = await redis.get(claveCache(usuarioId));
  if (cacheado) return JSON.parse(cacheado);

  const resultado = await calcularRecomendaciones(usuarioId);
  await redis.set(claveCache(usuarioId), JSON.stringify(resultado), 'EX', CACHE_TTL_SEGUNDOS);
  return resultado;
}

// Guardia 1 (Redis, cupo PERSONAL — no un pool compartido) + guardia 2
// (MySQL, checkoutOferta, autoridad final) — mismo patrón de dos guardas que
// la oferta flash manual, mismo reembolso de mejor esfuerzo si la 2 rechaza
// después de que la 1 ya admitió (ver ofertaFlashService.comprar()). No
// confía en que el cliente mande el precio: vuelve a validar que este
// producto sea de verdad una recomendación vigente para este usuario antes
// de nada — sin esto, cualquiera podría pedir el descuento en un producto al
// que no le corresponde con solo adivinar la URL.
async function comprar(usuarioId, productoId, { cantidad, direccionId, metodoPagoId } = {}) {
  if (!Number.isInteger(cantidad) || cantidad <= 0) throw new Error('cantidad debe ser un entero positivo');

  const { productos } = await recomendar(usuarioId);
  const match = productos.find((p) => p.id === productoId);
  if (!match) {
    const err = new Error('Este producto no es una recomendación vigente para tu usuario');
    err.status = 403;
    throw err;
  }

  // match.precio_recomendado puede venir del caché de Redis (hasta
  // CACHE_TTL_SEGUNDOS de antigüedad, ver recomendar()) — sirve para decidir
  // SI este producto sigue siendo una recomendación vigente (match de arriba),
  // pero no para cobrar: el precio base pudo cambiar desde que se calculó. Se
  // vuelve a leer el precio ACTUAL del catálogo (Mongo, vía productoService,
  // mismo camino que ofertaFlashService.intentarComprar() relee el producto
  // fresco en cada intento) y se recalcula el descuento sobre ESE valor —
  // checkoutOferta() confía en el precioUnitario que se le pasa sin volver a
  // validarlo contra inventario.precio, así que esta relectura es la única
  // guarda real del precio.
  const productoActual = await productoService.obtener(productoId);
  const precioActual = Number(productoActual.inventario?.precio ?? 0);
  const precioRecomendadoActual = calcularPrecioRecomendado(precioActual);

  const redis = conectarRedis();
  const clave = claveCupo(productoId, usuarioId);
  const restante = await redis.decrementarOferta(clave, CUPO_PERSONAL, CACHE_TTL_SEGUNDOS, cantidad);
  if (Number(restante) === RECHAZADO) {
    const err = new Error('Ya alcanzaste tu cupo personal para esta recomendación');
    err.status = 409;
    throw err;
  }

  try {
    return await checkoutService.checkoutOferta({
      usuarioId,
      productoId,
      cantidad,
      precioUnitario: precioRecomendadoActual,
      direccionId,
      metodoPagoId,
    });
  } catch (err) {
    try {
      await redis.incrby(clave, cantidad);
    } catch (refundErr) {
      console.error('No se pudo revertir el cupo personal en Redis tras un fallo en MySQL:', refundErr.message);
    }
    throw err;
  }
}

module.exports = { analizarTendencia, recomendar, comprar, CUPO_PERSONAL, CACHE_TTL_SEGUNDOS };
