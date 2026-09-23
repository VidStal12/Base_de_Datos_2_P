const { conectar, indice } = require('../config/elasticsearch');

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
// resultados de búsqueda.
function aProducto(hit) {
  const s = hit._source;
  return {
    id: Number(hit._id),
    descripcion: s.descripcion,
    imagen_url: s.imagen_url || '',
    vendedor_nombre: s.vendedor_nombre,
    atributos: s.atributos || [],
    inventario: { precio: s.precio, cantidad: s.cantidad },
    subcategoria: { subcategoria: s.subcategoria, categoria: s.categoria },
    estado: s.estado,
    _score: hit._score,
  };
}

// Búsqueda de productos (Entrega 3, ver IA/PLAN-ELASTICSEARCH-BUSQUEDA.md).
// Pública, siempre filtrada a estado:activo — a diferencia de
// productoService.listar(), esta es una vista pública de vitrina, no repite
// la lógica de "vendedor ve sus propios inactivos" de GET /api/productos.
async function buscar({ q, categoriaId, subcategoriaId, atributos, precioMin, precioMax, ordenarPor } = {}) {
  const cliente = await conectar();

  // fuzziness:'AUTO' — tolerancia a errores de tipeo (requerimiento técnico
  // de Entrega 3, ver PLAN-ELASTICSEARCH-BUSQUEDA.md §4). descripcion^2:
  // más peso que el nombre del vendedor, que solo debería desempatar.
  const must = q
    ? [{ multi_match: { query: q, fields: ['descripcion^2', 'vendedor_nombre'], fuzziness: 'AUTO' } }]
    : [{ match_all: {} }];

  const filter = [{ term: { estado: 'activo' } }];
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

  const respuesta = await cliente.search({
    index: indice(),
    query: { bool: { must, filter } },
    sort: ordenarPor === 'masVendidos' ? [{ total_vendido: 'desc' }] : undefined,
    size: 60,
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
  });

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

// Autocompletado (ver IA/PLAN-ELASTICSEARCH-BUSQUEDA.md §4) — usa el
// suggester `completion` del mapping, no reusa buscar(): es una consulta
// distinta (prefijo + fuzzy sobre un campo dedicado, sin relevancia de texto
// libre ni agregaciones) pensada para responder mientras el usuario todavía
// está escribiendo, no una vez que ya confirmó la búsqueda.
async function sugerir(q) {
  if (!q || !q.trim()) return [];
  const cliente = await conectar();
  const respuesta = await cliente.search({
    index: indice(),
    suggest: {
      sugerencias: {
        prefix: q,
        completion: {
          field: 'sugerencia',
          size: 8,
          skip_duplicates: true,
          fuzzy: { fuzziness: 'AUTO' },
          contexts: { estado: ['activo'] },
        },
      },
    },
  });
  const opciones = respuesta.suggest?.sugerencias?.[0]?.options ?? [];
  return opciones.map((o) => o.text);
}

module.exports = { buscar, sugerir };
