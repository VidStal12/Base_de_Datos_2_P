const { conCircuito, indice } = require('../config/elasticsearch');
const { vendedoresSuspendidos } = require('./suspensionService');
const facetas = require('./facetasBusqueda');

// Un atributo elegido, como filtro: `nested` mantiene nombre/valor pegados al MISMO elemento del
// array (igual que $elemMatch en Mongo, ver config/elasticsearch.js) y `terms` deja elegir varios
// valores del mismo atributo (O entre ellos). Con `term` y un arreglo el motor responde 400.
const clausulaAtributo = (nombre, valores) => ({
  nested: {
    path: 'atributos',
    query: { bool: { filter: [{ term: { 'atributos.nombre': nombre } }, { terms: { 'atributos.valor': valores } }] } },
  },
});

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
// UNA sola consulta sirve para escribir un texto Y para navegar por categorías (sin texto es un
// match_all): lo que se elige en la barra lateral (categoría, precio, atributos) va en `post_filter`,
// que recorta los resultados pero NO las agregaciones. Cada agregación aplica entonces "todos los
// filtros menos el suyo" (facetas disyuntivas): marcar Talla=M deja a Talla=L visible con su conteo.
// En `query` queda solo lo que no es una faceta (texto, estado, vendedor y vendedores suspendidos)
// porque eso sí tiene que alcanzar a TODAS las agregaciones: el total y los conteos nunca incluyen
// productos ocultos (por eso las suspensiones NO van en post_filter ni se usa una agregación `global`).
//
// `vendedorId`, `incluirInactivos`, `conFacetas` y el tope de `tamano` los usa el catálogo cuando se
// sirve desde el índice porque Mongo está apagado (listarDesdeIndice, más abajo): ahí no hacen falta
// facetas y todos los filtros van directo a `query`.
function construirPedido(filtros, { suspendidos = [], vendedorId, incluirInactivos = false, conFacetas = true } = {}) {
  const { q, categoriaId, subcategoriaId, precioMin, precioMax, ordenarPor, pagina, tamano } = filtros;
  const atributos = filtros.atributos || {};
  const nombres = Object.keys(atributos);

  // fuzziness:'AUTO': tolerancia a errores de tipeo (requerimiento técnico
  // de Entrega 3, ver PLAN-ELASTICSEARCH-BUSQUEDA.md §4). descripcion^2:
  // más peso que el nombre del vendedor, que solo debería desempatar.
  const must = q
    ? [{ multi_match: { query: q, fields: ['descripcion^2', 'vendedor_nombre'], fuzziness: 'AUTO' } }]
    : [{ match_all: {} }];
  const filter = incluirInactivos ? [] : [{ term: { estado: 'activo' } }];
  if (vendedorId) filter.push({ term: { vendedor_id: Number(vendedorId) } });
  // Los productos de un vendedor suspendido no se muestran mientras dure la suspensión
  // (ver productoService.listar): el índice no sabe de suspensiones, así que se excluyen
  // al consultar, y las facetas y los conteos, que salen de esta misma consulta, los
  // dejan fuera también. Vuelven solos al levantarse.
  const must_not = suspendidos.length > 0 && !incluirInactivos ? [{ terms: { vendedor_id: suspendidos } }] : undefined;

  // Las tres familias de filtro de faceta. La subcategoría manda sobre la categoría (como siempre).
  const deCategoria = subcategoriaId
    ? { term: { subcategoria_id: subcategoriaId } }
    : categoriaId ? { term: { categoria_id: categoriaId } } : null;
  const rango = {};
  if (precioMin !== undefined) rango.gte = precioMin;
  if (precioMax !== undefined) rango.lte = precioMax;
  const dePrecio = Object.keys(rango).length > 0 ? { range: { precio: rango } } : null;
  const deAtributo = Object.fromEntries(nombres.map((nombre) => [nombre, clausulaAtributo(nombre, atributos[nombre])]));

  // Todos los filtros de faceta MENOS los que se indican: la base de cada agregación.
  const menos = ({ categoria = false, precio = false, atributo = null } = {}) => [
    !categoria && deCategoria,
    !precio && dePrecio,
    ...nombres.filter((n) => n !== atributo).map((n) => deAtributo[n]),
  ].filter(Boolean);
  const comoFiltro = (clausulas) => (clausulas.length > 0 ? { bool: { filter: clausulas } } : { match_all: {} });
  const todos = menos();

  // Desempate fijo por producto_id: paginar no repite ni salta productos.
  const sort = {
    masVendidos: [{ total_vendido: 'desc' }, { producto_id: 'asc' }],
    precioAsc: [{ precio: 'asc' }, { producto_id: 'asc' }],
    precioDesc: [{ precio: 'desc' }, { producto_id: 'asc' }],
  }[ordenarPor] ?? (q ? [{ _score: 'desc' }, { producto_id: 'asc' }] : [{ producto_id: 'asc' }]);
  const base = { index: indice(), sort, from: (pagina - 1) * tamano, size: tamano, track_total_hits: true };

  if (!conFacetas) return { ...base, query: { bool: { must, filter: [...filter, ...todos], must_not } } };

  return {
    ...base,
    query: { bool: { must, filter, must_not } },
    post_filter: todos.length > 0 ? { bool: { filter: todos } } : undefined,
    aggs: {
      // Árbol categoría → subcategoría sobre los campos keyword que ya existen. Sin la categoría
      // elegida (las hermanas no desaparecen) ni atributos (son de cada subcategoría). El precio
      // se cuenta aparte dentro de cada nodo, así un nodo elegido sin resultados sigue en el árbol.
      arbol: {
        terms: { field: 'categoria_id', size: 100 },
        aggs: {
          nombre: { terms: { field: 'categoria', size: 1 } },
          ...(dePrecio && { con_precio: { filter: dePrecio } }),
          subcategorias: {
            terms: { field: 'subcategoria_id', size: 200 },
            aggs: {
              nombre: { terms: { field: 'subcategoria', size: 1 } },
              ...(dePrecio && { con_precio: { filter: dePrecio } }),
            },
          },
        },
      },
      // Precio: categoría + atributos elegidos, SIN el rango de precio (para poder ampliarlo).
      precio: {
        filter: comoFiltro(menos({ precio: true })),
        aggs: {
          stats: { stats: { field: 'precio' } },
          rangos: { range: { field: 'precio', ranges: facetas.RANGOS_PRECIO } },
        },
      },
      // Atributos todavía sin elegir: con todos los filtros. Requiere una agregación `nested` (no se
      // puede agregar directo sobre un campo nested); `exclude` deja afuera los que tienen bloque propio.
      atributos: {
        filter: comoFiltro(todos),
        aggs: {
          n: {
            nested: { path: 'atributos' },
            aggs: {
              nombres: {
                terms: { field: 'atributos.nombre', size: 20, ...(nombres.length > 0 && { exclude: nombres }) },
                aggs: { valores: { terms: { field: 'atributos.valor', size: 30 } } },
              },
            },
          },
        },
      },
      // Un bloque por atributo elegido, con todos los filtros MENOS el suyo: así no colapsa a lo marcado.
      // El nombre de la agregación es un índice (attr_0...): un nombre de atributo con "[", "]" o ">" la rompería.
      ...Object.fromEntries(nombres.map((nombre, i) => [`attr_${i}`, {
        filter: comoFiltro(menos({ atributo: nombre })),
        aggs: {
          n: {
            nested: { path: 'atributos' },
            aggs: { solo: { filter: { term: { 'atributos.nombre': nombre } }, aggs: { valores: { terms: { field: 'atributos.valor', size: 30 } } } } },
          },
        },
      }])),
    },
  };
}

// De la respuesta cruda del motor a las piezas neutrales de facetasBusqueda.armarRespuesta().
function desdeElastic(respuesta, filtros) {
  const ag = respuesta.aggregations ?? {};
  const nombres = Object.keys(filtros.atributos || {});
  const conPrecio = filtros.precioMin !== undefined || filtros.precioMax !== undefined;
  const cantidad = (cubeta) => (conPrecio ? cubeta.con_precio?.doc_count ?? 0 : cubeta.doc_count);
  const nombreDe = (cubeta) => cubeta.nombre?.buckets?.[0]?.key ?? 'Sin nombre';

  const arbolCrudo = (ag.arbol?.buckets ?? []).map((c) => ({
    id: String(c.key), nombre: nombreDe(c), texto: c.doc_count, cantidad: cantidad(c),
    subcategorias: (c.subcategorias?.buckets ?? []).map((s) => ({ id: String(s.key), nombre: nombreDe(s), texto: s.doc_count, cantidad: cantidad(s) })),
  }));

  const valoresPorAtributo = {};
  nombres.forEach((nombre, i) => {
    valoresPorAtributo[nombre] = (ag[`attr_${i}`]?.n?.solo?.valores?.buckets ?? []).map((v) => ({ valor: v.key, cantidad: v.doc_count }));
  });
  for (const cubeta of ag.atributos?.n?.nombres?.buckets ?? []) {
    valoresPorAtributo[cubeta.key] = cubeta.valores.buckets.map((v) => ({ valor: v.key, cantidad: v.doc_count }));
  }

  // `stats` devuelve el precio como float de 32 bits (44.17 llega como 44.16999816894531): se redondea a centavos.
  const precio = {
    min: facetas.redondear(ag.precio?.stats?.min),
    max: facetas.redondear(ag.precio?.stats?.max),
    rangos: (ag.precio?.rangos?.buckets ?? [])
      .filter((r) => r.doc_count > 0)
      .map((r) => ({ desde: r.from ?? 0, hasta: r.to ?? null, cantidad: r.doc_count })),
  };

  const total = typeof respuesta.hits.total === 'object' ? respuesta.hits.total.value : respuesta.hits.total;
  return facetas.armarRespuesta({
    total, pagina: filtros.pagina, tamano: filtros.tamano, resultados: respuesta.hits.hits.map(aProducto),
    arbolCrudo, valoresPorAtributo, precio, filtros,
  });
}

// `opciones` es lo que escribe quien llama a la URL pública: solo se leen los campos que normalizarConsulta()
// conoce. Lo que cambia las reglas de visibilidad (`incluirInactivos`, `vendedorId`) o el costo (`conFacetas`)
// va en el SEGUNDO argumento, que solo arman los llamadores internos: antes todo viajaba en el mismo objeto y
// GET /api/busqueda?incluirInactivos=1 devolvía productos inactivos (y de vendedores suspendidos) a cualquiera.
async function buscar(opciones = {}, { tamanoMaximo, vendedorId, incluirInactivos = false, conFacetas = true } = {}) {
  const filtros = facetas.normalizarConsulta(opciones, { tamanoMaximo });
  const suspendidos = await vendedoresSuspendidos();
  const pedido = construirPedido(filtros, { suspendidos: [...suspendidos], vendedorId, incluirInactivos, conFacetas });
  const respuesta = await conCircuito((cliente) => cliente.search(pedido));
  return desdeElastic(respuesta, filtros);
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
  const { resultados } = await buscar(
    { q, categoriaId, subcategoriaId, atributos, precioMin, precioMax, ordenarPor, tamano: TAMANO_CATALOGO },
    { vendedorId, incluirInactivos: Boolean(mostrarInactivos), conFacetas: false, tamanoMaximo: TAMANO_CATALOGO },
  );
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
// Solo aparecen las categorías que tienen al menos un producto ACTIVO indexado: el índice también guarda
// los inactivos (para el panel del vendedor), y sin este filtro una categoría que solo tiene productos
// pausados salía en el menú del respaldo.
async function categoriasDelIndice() {
  const respuesta = await conCircuito((cliente) => cliente.search({
    index: indice(),
    size: 0,
    query: { bool: { filter: [{ term: { estado: 'activo' } }] } },
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

module.exports = { buscar, construirPedido, sugerir, listarDesdeIndice, obtenerDelIndice, categoriasDelIndice, publicacionDelIndice };
