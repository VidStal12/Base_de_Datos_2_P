// Ranking de la búsqueda: cuánto pesan lo que se vende, lo que se abre y lo nuevo que es un producto
// (ver IA/PLAN-ELASTICSEARCH-BUSQUEDA.md §17).
//
// Todo lo de este archivo son funciones y constantes puras (sin conexiones, sin reloj propio: la hora llega
// como argumento), y las usan los DOS caminos de GET /api/busqueda, igual que facetasBusqueda.js:
//   - busquedaService.construirPedido()  → el motor calcula el puntaje (function_score) y ordena.
//   - facetasBusqueda.desdeLista()       → con Elasticsearch apagado, Mongo ordena en JavaScript con la
//                                          MISMA fórmula (sin la relevancia de texto, que solo tiene el motor).
// Que la fórmula viva aquí, una sola vez, es lo que evita que los dos caminos se desalineen.
//
// QUÉ SE BUSCA. Con una palabra general («iphone», «camiseta») nadie pide un modelo en particular: lo
// razonable es mostrar primero lo que más se compra y se mira, y que entre dos parecidos gane el más nuevo
// (para no empujar un modelo viejo). Con un texto específico («camiseta deportiva transpirable»), en cambio,
// manda lo que mejor lo describe. Por eso el puntaje NO reemplaza a la relevancia: la MULTIPLICA.
//
//     puntaje final = relevancia del texto (BM25) × ( 1 + ventas + clics + novedad )
//
// Con un texto general los productos que lo contienen tienen una relevancia casi igual, y el multiplicador
// los reordena por popularidad; con uno específico las relevancias están muy separadas (un producto calza
// con tres palabras y los otros con una), y un multiplicador acotado no alcanza a darle la vuelta.
//
// Las ventas y los clics entran con logaritmo (log10(1 + n)): pasar de 0 a 10 unidades pesa mucho, pasar de
// 150 a 160 casi nada, así un producto que ya vendió muchísimo no tapa a todos los demás para siempre. La
// novedad es una campana gaussiana sobre la antigüedad (publicado_en): vale 1 durante `margenDias`, baja a la
// mitad pasados `escalaDias` más, y tiende a 0. Sin publicado_en (producto indexado antes de este cambio) la
// novedad vale 0, no 1: no se premia a quien no se sabe cuándo se publicó.
//
// Con los pesos de abajo el multiplicador va de 1 (sin ventas, sin clics, viejo) a unos 3,3 (160 ventas,
// 1.000 clics, publicado esta semana): una diferencia notable, nunca decisiva frente a una coincidencia de
// texto mucho mejor.

const DIA_MS = 86400000;

const PESOS = { ventas: 0.5, clics: 0.25, novedad: 0.5 };
const NOVEDAD = { margenDias: 14, escalaDias: 150, decaimiento: 0.5 };

// Los órdenes que se piden por nombre (ordenarPor), en el lenguaje del motor. Los dos desempatan por lo que el
// nombre del orden NO dice: «más vendidos» entre iguales prefiere el más reciente y después el más abierto;
// «más recientes» entre iguales, el que más vende. `missing: '_last'`: un producto sin fecha de publicación
// (aún no reindexado) va al final, no al principio.
const FECHA_DESC = { publicado_en: { order: 'desc', missing: '_last' } };
const ORDENES_MOTOR = {
  masVendidos: [{ total_vendido: 'desc' }, FECHA_DESC, { clics: 'desc' }, { producto_id: 'asc' }],
  masRecientes: [FECHA_DESC, { total_vendido: 'desc' }, { clics: 'desc' }, { producto_id: 'asc' }],
};

// Las piezas de function_score. `score_mode: 'sum'` las suma (1 + ventas + clics + novedad) y
// `boost_mode: 'multiply'` multiplica esa suma por la relevancia del texto. El `weight: 1` suelto es la base
// de la suma: sin él un producto sin ventas ni clics sumaría 0 y se llevaría el puntaje a cero.
// El filtro `exists` de la novedad es lo que deja en 0 a los que no tienen fecha (una función de decaimiento
// sin valor devolvería 1).
function funcionesDeRanking() {
  return [
    { weight: 1 },
    { field_value_factor: { field: 'total_vendido', modifier: 'log1p', factor: 1, missing: 0 }, weight: PESOS.ventas },
    { field_value_factor: { field: 'clics', modifier: 'log1p', factor: 1, missing: 0 }, weight: PESOS.clics },
    {
      filter: { exists: { field: 'publicado_en' } },
      gauss: { publicado_en: { origin: 'now', offset: `${NOVEDAD.margenDias}d`, scale: `${NOVEDAD.escalaDias}d`, decay: NOVEDAD.decaimiento } },
      weight: PESOS.novedad,
    },
  ];
}

// Envuelve la consulta de texto/filtros: la relevancia sigue siendo la del motor, multiplicada por el ranking.
function conRanking(consulta) {
  return { function_score: { query: consulta, functions: funcionesDeRanking(), score_mode: 'sum', boost_mode: 'multiply' } };
}

// ---------- La misma cuenta en JavaScript (respaldo sin Elasticsearch, y las pruebas) ----------

const numero = (valor) => (Number.isFinite(Number(valor)) && Number(valor) > 0 ? Number(valor) : 0);

// Milisegundos de publicación, o null si no se sabe (fecha ausente o ilegible).
function marcaDePublicacion(producto) {
  if (!producto.publicado_en) return null;
  const ms = new Date(producto.publicado_en).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// La campana de Elasticsearch (decay function `gauss`): exp(-max(0, |edad| - margen)² / (2σ²)) con
// σ² = -escala² / (2·ln(decaimiento)). Se mide en días.
function novedadDe(producto, ahoraMs) {
  const marca = marcaDePublicacion(producto);
  if (marca === null) return 0;
  const edadDias = Math.abs(ahoraMs - marca) / DIA_MS;
  const sigma2 = -(NOVEDAD.escalaDias ** 2) / (2 * Math.log(NOVEDAD.decaimiento));
  return Math.exp(-(Math.max(0, edadDias - NOVEDAD.margenDias) ** 2) / (2 * sigma2));
}

// El multiplicador (1 + ventas + clics + novedad) de un producto: lo que function_score suma antes de
// multiplicar por la relevancia. Sin texto, la relevancia de todos es la misma y esto ES el puntaje.
function multiplicador(producto, ahoraMs) {
  return 1
    + PESOS.ventas * Math.log10(1 + numero(producto.total_vendido))
    + PESOS.clics * Math.log10(1 + numero(producto.clics))
    + PESOS.novedad * novedadDe(producto, ahoraMs);
}

const comparar = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// Fecha más reciente primero; sin fecha, al final (igual que `missing: '_last'`).
const porFechaDesc = (a, b) => comparar(marcaDePublicacion(b) ?? -Infinity, marcaDePublicacion(a) ?? -Infinity);
const porVentasDesc = (a, b) => comparar(numero(b.total_vendido), numero(a.total_vendido));
const porClicsDesc = (a, b) => comparar(numero(b.clics), numero(a.clics));
const porId = (a, b) => comparar(a.id, b.id);

// La fecha de publicación se guarda con precisión de UN DÍA (UTC): para ordenar por novedad un segundo no significa
// nada, y con segundos el catálogo sembrado en un solo lote —cientos de productos publicados con segundos de
// diferencia— quedaba en un empate «casi» exacto (la novedad cambia ~2e-8 por segundo) que dos implementaciones
// con aritmética distinta (el motor y el respaldo) resuelven distinto: la primera página de la portada cambiaba
// según quién contestara. Con días, los de un mismo día empatan EXACTO y se desempatan por ventas, clics y id en
// los dos caminos, y entre días distintos la diferencia (~2e-3) es enorme frente al error de redondeo.
function diaDePublicacion(fecha) {
  const ms = fecha ? new Date(fecha).getTime() : NaN;
  if (!Number.isFinite(ms)) return null;
  return new Date(Math.floor(ms / DIA_MS) * DIA_MS);
}

// Elasticsearch calcula el puntaje en `float` (32 bits). Se redondea igual antes de comparar, para que dos puntajes
// que el motor no distingue tampoco los distinga el respaldo.
const comoElMotor = (valor) => Math.fround(valor);

// Los comparadores de Array.sort, uno por orden. `ahoraMs` solo lo usa el de relevancia/popularidad.
function comparadores(ahoraMs) {
  return {
    popularidad: (a, b) => comparar(comoElMotor(multiplicador(b, ahoraMs)), comoElMotor(multiplicador(a, ahoraMs))) || porId(a, b),
    masVendidos: (a, b) => porVentasDesc(a, b) || porFechaDesc(a, b) || porClicsDesc(a, b) || porId(a, b),
    masRecientes: (a, b) => porFechaDesc(a, b) || porVentasDesc(a, b) || porClicsDesc(a, b) || porId(a, b),
  };
}

module.exports = { PESOS, NOVEDAD, ORDENES_MOTOR, funcionesDeRanking, conRanking, diaDePublicacion, novedadDe, multiplicador, comparadores };
