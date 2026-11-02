const { conCircuito, indice } = require('../config/elasticsearch');
const { incrustar, textoDeProducto } = require('./embeddingService');

// Documento de búsqueda a partir del MISMO objeto que ya arma
// productoService.obtener()/formatear() — no vuelve a resolver
// subcategoría/categoría por su cuenta, evita una segunda fuente de verdad
// para lo mismo dato. imagen_url se guarda (index:false en el mapping) para
// que los resultados de búsqueda se puedan mostrar sin un segundo viaje a
// Mongo — mismo criterio que vendedor_nombre cacheado en Producto.js.
//
// `embedding` (el vector del producto, ver embeddingService) se agrega solo si se
// calculó. Sin él el documento NO lleva el campo, y entonces no se puede indexar
// con un `index` completo: borraría el vector que el documento ya tiene
// (ver indexarProducto).
function aDocumento(producto, embedding) {
  return {
    producto_id: producto.id,
    nombre: producto.nombre,
    descripcion: producto.descripcion,
    vendedor_id: producto.vendedor_id,
    vendedor_nombre: producto.vendedor_nombre,
    imagen_url: producto.imagen_url || '',
    categoria: producto.subcategoria?.categoria ?? null,
    subcategoria: producto.subcategoria?.subcategoria ?? null,
    categoria_id: producto.subcategoria?.categoria_id ?? null,
    subcategoria_id: producto.subcategoria?.id ?? null,
    atributos: (producto.atributos || []).map(({ nombre, valor }) => ({ nombre, valor })),
    precio: producto.inventario?.precio ?? null,
    cantidad: producto.inventario?.cantidad ?? 0,
    estado: producto.estado,
    total_vendido: producto.total_vendido ?? 0,
    // input: el nombre tal cual — es lo que el usuario reconoce y lo
    // que termina en la caja de búsqueda al elegir una sugerencia (ver
    // busquedaService.sugerir()). contexts.estado: para que sugerir() pueda
    // excluir inactivos en la propia consulta (ver config/elasticsearch.js).
    sugerencia: { input: [producto.nombre], contexts: { estado: [producto.estado] } },
    ...(embedding && { embedding }),
  };
}

// Mejor esfuerzo (ver IA/PLAN-ELASTICSEARCH-BUSQUEDA.md §3/§7) — no un
// outbox durable como Cassandra: un resultado de búsqueda desactualizado
// por unos segundos no tiene el mismo costo que una venta perdida, y
// precio/stock reales siempre se vuelven a leer de Mongo en el detalle y el
// carrito, nunca se confía en lo indexado para eso. id = producto_id, así
// una reindexación es un overwrite natural — mismo principio de
// idempotencia por clave natural que ya rige Cassandra (detalle_id) y
// Neo4j (MERGE por contenido). Que esto falle no debe romper crear()/
// actualizar(); recuperable con scripts/backfillBusqueda.js.
//
// Un producto sin descripción queda sin vector y usa el respaldo por subcategoría.
// Si falta el modelo, el índice léxico sigue disponible; se conserva el vector
// anterior únicamente si el texto que lo produjo sigue vigente.
let sinModeloAvisado = false;

async function vectorDe(producto) {
  try {
    const [vector] = await incrustar([textoDeProducto(producto)]);
    sinModeloAvisado = false;
    return vector;
  } catch (err) {
    // Una línea por caída del modelo, no una por cada producto que se edite mientras dure.
    if (!sinModeloAvisado) {
      sinModeloAvisado = true;
      console.error(`No se pudo calcular el vector del producto #${producto.id}; se actualiza el índice de texto:`, err.message);
    }
    return undefined;
  }
}

// Al reindexar sin modelo, conservar un vector solo si se calculó con el mismo
// texto. Un vector antiguo basado en el título daría recomendaciones incorrectas.
const ACTUALIZAR_TEXTO = `
  if (!ctx._source.containsKey('nombre') || ctx._source.descripcion != params.doc.descripcion ||
      ctx._source.categoria != params.doc.categoria || ctx._source.subcategoria != params.doc.subcategoria) {
    ctx._source.remove('embedding');
  }
  ctx._source.putAll(params.doc);
`;

async function indexarProducto(producto, { soloTexto = false } = {}) {
  const necesitaVector = Boolean(producto.descripcion?.trim());
  const embedding = necesitaVector && !soloTexto ? await vectorDe(producto) : undefined;
  const document = aDocumento(producto, embedding);
  const id = String(producto.id);
  try {
    await conCircuito((cliente) => (embedding || !necesitaVector
      ? cliente.index({ index: indice(), id, document })
      : cliente.update({ index: indice(), id, script: { source: ACTUALIZAR_TEXTO, params: { doc: document } }, upsert: document, retry_on_conflict: 3 })));
    return Boolean(embedding) || soloTexto || !necesitaVector;
  } catch (err) {
    // Con Elasticsearch apagado esto falla al instante (cortacircuitos) y el producto queda
    // sin reindexar: la ventana de consistencia eventual que se acepta, cerrada con
    // `npm run busqueda:backfill` cuando el motor vuelve.
    console.error(`No se pudo indexar el producto #${producto.id} en Elasticsearch:`, err.message);
    return false;
  }
}

module.exports = { indexarProducto, aDocumento };
