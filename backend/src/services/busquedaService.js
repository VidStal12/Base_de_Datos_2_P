const { conCircuito, indice } = require('../config/elasticsearch');
const { vendedoresSuspendidos } = require('./suspensionService');

// Mismo formato que ya manda el frontend a productoService.listar() — JSON
// de {nombre: valor}, ver condicionesAtributos() ahí — un valor exacto por
// atributo, todos exigidos a la vez. `nested` con dos `term` en el mismo
// `must` mantiene nombre/valor pegados al MISMO elemento del array, igual
// que ya hace $elemMatch en Mongo (ver config/elasticsearch.js, mapping).
function filtrosAtributos(atributos) {
  if (!atributos) return [];
  let pares;
  try {
    pares = typeof atributos === 'string' ? JSON.parse(atributos) : atributos;
  } catch {
    return []; // JSON inválido en un endpoint público de solo lectura: se ignora, no se rompe la búsqueda
  }
  if (!pares || typeof pares !== 'object') return [];
  return Object.entries(pares)
    .filter(([nombre, valor]) => nombre && valor)
    .map(([nombre, valor]) => ({
      nested: {
        path: 'atributos',
        query: {
          bool: {
            must: [{ term: { 'atributos.nombre': nombre } }, { term: { 'atributos.valor': valor } }],
          },
        },
      },
    }));
}

// Reacomoda el _source del índice a la MISMA forma que ya devuelve
// productoService.obtener()/formatear() para lo que ProductCard.jsx
// necesita — así el frontend reusa ese componente sin cambios para mostrar
// resultados de búsqueda. Los campos que el índice no guarda (reseñas, oferta
// flash, versión) salen vacíos: lo necesitan el detalle y el catálogo cuando se
// sirven DESDE el índice porque Mongo está apagado (ver catalogoLecturaService.js).
function aProducto(hit) {
  const s = hit._source;
  return {
    id: Number(hit._id),
    descripcion: s.descripcion,
    imagen_url: s.imagen_url || '',
    imagenes: s.imagen_url ? [{ url: s.imagen_url, alt: s.descripcion, orden: 1, principal: true }] : [],
    vendedor_id: s.vendedor_id,
    vendedor_nombre: s.vendedor_nombre,
    atributos: s.atributos || [],
    inventario: { precio: s.precio, cantidad: s.cantidad },
    subcategoria: {
      id: s.subcategoria_id ?? undefined,
      subcategoria: s.subcategoria,
      categoria_id: s.categoria_id ?? undefined,
      categoria: s.categoria,
    },
    estado: s.estado,
    oferta_flash: null,
    resenas_resumen: { promedio: 0, cantidad: 0 },
    total_vendido: s.total_vendido ?? 0,
    _score: hit._score,
  };
}

// Búsqueda de productos (Entrega 3, ver IA/PLAN-ELASTICSEARCH-BUSQUEDA.md).
// Pública, siempre filtrada a estado:activo — a diferencia de
// productoService.listar(), esta es una vista pública de vitrina, no repite
// la lógica de "vendedor ve sus propios inactivos" de GET /api/productos.
//
// `vendedorId`, `incluirInactivos` y `tamano` los usa el catálogo cuando se sirve
// desde el índice porque Mongo está apagado (listarDesdeIndice, más abajo): el mismo
// documento indexado tiene también los productos inactivos y el vendedor.
async function buscar({ q, categoriaId, subcategoriaId, atributos, precioMin, precioMax, ordenarPor, vendedorId, incluirInactivos, tamano = 60 } = {}) {
  // fuzziness:'AUTO' — tolerancia a errores de tipeo (requerimiento técnico
  // de Entrega 3, ver PLAN-ELASTICSEARCH-BUSQUEDA.md §4). descripcion^2:
  // más peso que el nombre del vendedor, que solo debería desempatar.
  const must = q
    ? [{ multi_match: { query: q, fields: ['descripcion^2', 'vendedor_nombre'], fuzziness: 'AUTO' } }]
    : [{ match_all: {} }];

  const filter = incluirInactivos ? [] : [{ term: { estado: 'activo' } }];
  if (vendedorId) filter.push({ term: { vendedor_id: Number(vendedorId) } });
  if (subcategoriaId) {
    filter.push({ term: { subcategoria_id: String(subcategoriaId) } });
  } else if (categoriaId) {
    filter.push({ term: { categoria_id: String(categoriaId) } });
  }
  if (precioMin !== undefined || precioMax !== undefined) {
    const rango = {};
    if (precioMin !== undefined) rango.gte = Number(precioMin);
    if (precioMax !== undefined) rango.lte = Number(precioMax);
    filter.push({ range: { precio: rango } });
  }
  filter.push(...filtrosAtributos(atributos));

  // Los productos de un vendedor suspendido no se muestran mientras dure la suspensión
  // (ver productoService.listar): el índice no sabe de suspensiones, así que se excluyen
  // al consultar — y las facetas y los conteos, que salen de esta misma consulta, los
  // dejan fuera también. Vuelven solos al levantarse.
  const suspendidos = await vendedoresSuspendidos();
  const must_not = suspendidos.size > 0 && !incluirInactivos ? [{ terms: { vendedor_id: [...suspendidos] } }] : undefined;

  const respuesta = await conCircuito((cliente) => cliente.search({
    index: indice(),
    query: { bool: { must, filter, must_not } },
    sort: ordenarPor === 'masVendidos' ? [{ total_vendido: 'desc' }] : undefined,
    size: tamano,
    // Agregaciones (requerimiento técnico de Entrega 3): categoría/
    // subcategoría son `terms` simples; atributos necesita una agregación
    // `nested` (no se puede agregar directo sobre un campo nested) con una
    // sub-agregación por nombre y otra por valor adentro — misma forma
    // {nombre: [valores]} que ya espera FacetFilters en HomePage.jsx.
    aggs: {
      categorias: { terms: { field: 'categoria', size: 20 } },
      subcategorias: { terms: { field: 'subcategoria', size: 20 } },
      atributos: {
        nested: { path: 'atributos' },
        aggs: {
          nombres: {
            terms: { field: 'atributos.nombre', size: 20 },
            aggs: { valores: { terms: { field: 'atributos.valor', size: 30 } } },
          },
        },
      },
    },
  }));

  const facetas = {};
  for (const cubetaNombre of respuesta.aggregations?.atributos?.nombres?.buckets ?? []) {
    facetas[cubetaNombre.key] = cubetaNombre.valores.buckets.map((v) => v.key);
  }

  const total = typeof respuesta.hits.total === 'object' ? respuesta.hits.total.value : respuesta.hits.total;

  return {
    resultados: respuesta.hits.hits.map(aProducto),
    total,
    facetas,
    categorias: (respuesta.aggregations?.categorias?.buckets ?? []).map((b) => ({ nombre: b.key, cantidad: b.doc_count })),
    subcategorias: (respuesta.aggregations?.subcategorias?.buckets ?? []).map((b) => ({ nombre: b.key, cantidad: b.doc_count })),
  };
}

// Autocompletado (ver IA/PLAN-ELASTICSEARCH-BUSQUEDA.md §4 y §12) — usa el
// suggester `completion` del mapping, no reusa buscar(): es una consulta
// distinta (prefijo sobre un campo dedicado, sin relevancia de texto libre ni
// agregaciones) pensada para responder mientras el usuario todavía está
// escribiendo, no una vez que ya confirmó la búsqueda.
//
// Dos suggesters en UNA misma petición: uno por prefijo exacto y otro con
// `fuzzy` (tolerancia a errores de tipeo). Se usa el exacto si trae algo y el
// aproximado solo cuando no hay ninguna coincidencia exacta. Con `fuzzy` solo,
// "smartphone x" (12 letras: hasta 2 ediciones) traía también todos los demás
// "smartphone ?", que difieren en UNA letra, y todos puntúan igual, así que la
// coincidencia exacta no quedaba por encima de las aproximadas.
async function sugerir(q) {
  if (!q || !q.trim()) return [];
  // El suggester no filtra por vendedor: si hay vendedores suspendidos se piden más
  // opciones (con su vendedor_id) y se descartan las suyas, para no sugerir un título
  // que la búsqueda ya no va a mostrar.
  const suspendidos = await vendedoresSuspendidos();
  const exacto = {
    field: 'sugerencia',
    size: suspendidos.size > 0 ? 24 : 8,
    skip_duplicates: true,
    contexts: { estado: ['activo'] },
  };
  const respuesta = await conCircuito((cliente) => cliente.search({
    index: indice(),
    _source: ['vendedor_id'],
    suggest: {
      exactas: { prefix: q, completion: exacto },
      aproximadas: { prefix: q, completion: { ...exacto, fuzzy: { fuzziness: 'AUTO' } } },
    },
  }));
  const visibles = (nombre) => (respuesta.suggest?.[nombre]?.[0]?.options ?? [])
    .filter((o) => !suspendidos.has(o._source?.vendedor_id))
    .slice(0, 8)
    .map((o) => o.text);
  // El descarte por vendedor suspendido va ANTES de decidir: si todas las exactas
  // eran de vendedores ocultos, no hay nada exacto que mostrar y se usan las aproximadas.
  const exactas = visibles('exactas');
  return exactas.length > 0 ? exactas : visibles('aproximadas');
}

// ---------- El índice como copia de lectura del catálogo ----------
//
// El documento indexado de cada producto lleva casi todo lo que el catálogo muestra
// (descripción, imagen, vendedor, categoría, atributos, precio, stock, estado). Eso lo
// hace el respaldo natural de Mongo: si el contenedor de Mongo está apagado, el catálogo,
// el detalle y el menú de categorías se siguen sirviendo desde acá — sin reseñas, ofertas
// flash ni historial, que solo existen en Mongo. Ver catalogoLecturaService.js.

// Hasta 500 productos: un catálogo completo en una sola página, como hace la lista normal.
const TAMANO_CATALOGO = 500;

async function listarDesdeIndice({ categoriaId, subcategoriaId, q, vendedorId, atributos, precioMin, precioMax, ordenarPor, mostrarInactivos } = {}) {
  const { resultados } = await buscar({
    q, categoriaId, subcategoriaId, atributos, precioMin, precioMax, ordenarPor, vendedorId,
    incluirInactivos: Boolean(mostrarInactivos), tamano: TAMANO_CATALOGO,
  });
  return resultados;
}

async function obtenerDelIndice(id) {
  try {
    const hit = await conCircuito((cliente) => cliente.get({ index: indice(), id: String(id) }));
    return aProducto(hit);
  } catch (err) {
    if (err?.meta?.statusCode === 404 || err?.statusCode === 404) throw Object.assign(new Error('Producto no encontrado'), { status: 404 });
    throw err;
  }
}

// Mismo formato que categoriaService.listar(): [{ id, categoria, subcategorias: [...] }].
// Solo aparecen las categorías que tienen al menos un producto indexado.
async function categoriasDelIndice() {
  const respuesta = await conCircuito((cliente) => cliente.search({
    index: indice(),
    size: 0,
    aggs: {
      categorias: {
        terms: { field: 'categoria_id', size: 100 },
        aggs: {
          nombre: { terms: { field: 'categoria', size: 1 } },
          subcategorias: {
            terms: { field: 'subcategoria_id', size: 200 },
            aggs: { nombre: { terms: { field: 'subcategoria', size: 1 } } },
          },
        },
      },
    },
  }));
  return (respuesta.aggregations?.categorias?.buckets ?? []).map((cat) => ({
    id: String(cat.key),
    categoria: cat.nombre.buckets[0]?.key ?? 'Sin nombre',
    subcategorias: cat.subcategorias.buckets.map((sub) => ({
      id: String(sub.key),
      id_categoria: String(cat.key),
      subcategoria: sub.nombre.buckets[0]?.key ?? 'Sin nombre',
      atributos_categoria: [],
    })),
  }));
}

// { productoId → { estado, vendedor_id, descripcion, imagen_url } } de los que el índice
// conoce. Lo usan el carrito y el checkout para saber si un producto está publicado cuando
// no pueden preguntárselo a Mongo (productoService.estadoPublicacion).
async function publicacionDelIndice(productoIds) {
  if (productoIds.length === 0) return new Map();
  const respuesta = await conCircuito((cliente) => cliente.mget({
    index: indice(),
    ids: productoIds.map(String),
    _source: ['estado', 'vendedor_id', 'descripcion', 'imagen_url'],
  }));
  return new Map(
    (respuesta.docs ?? [])
      .filter((doc) => doc.found)
      .map((doc) => [Number(doc._id), {
        estado: doc._source.estado,
        vendedor_id: doc._source.vendedor_id,
        descripcion: doc._source.descripcion,
        imagen_url: doc._source.imagen_url || '',
      }])
  );
}

module.exports = { buscar, sugerir, listarDesdeIndice, obtenerDelIndice, categoriasDelIndice, publicacionDelIndice };
