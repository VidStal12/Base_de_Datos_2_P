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
    // input: la descripción tal cual — es lo que el usuario reconoce y lo
    // que termina en la caja de búsqueda al elegir una sugerencia (ver
    // busquedaService.sugerir()). contexts.estado: para que sugerir() pueda
    // excluir inactivos en la propia consulta (ver config/elasticsearch.js).
    sugerencia: { input: [producto.descripcion], contexts: { estado: [producto.estado] } },
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
// El vector se recalcula del texto del producto en CADA alta o edición. Si el modelo
// no está (o no arranca), el producto se indexa igual pero con un `update` parcial:
// cambia todos los campos MENOS el vector, que se conserva (quedará con el texto
// anterior hasta el próximo backfill). Con un `index` completo se perdería.
// Devuelve true si el documento quedó indexado CON el vector recién calculado (lo que cuenta el backfill).
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
      console.error(`No se pudo calcular el vector del producto #${producto.id}; se indexa sin tocar el que ya tenía:`, err.message);
    }
    return undefined;
  }
}

async function indexarProducto(producto) {
  const embedding = await vectorDe(producto);
  const id = String(producto.id);
  try {
    await conCircuito((cliente) => (embedding
      ? cliente.index({ index: indice(), id, document: aDocumento(producto, embedding) })
      : cliente.update({ index: indice(), id, doc: aDocumento(producto), doc_as_upsert: true, retry_on_conflict: 3 })));
    return Boolean(embedding);
  } catch (err) {
    // Con Elasticsearch apagado esto falla al instante (cortacircuitos) y el producto queda
    // sin reindexar: la ventana de consistencia eventual que se acepta, cerrada con
    // `npm run busqueda:backfill` cuando el motor vuelve.
    console.error(`No se pudo indexar el producto #${producto.id} en Elasticsearch:`, err.message);
    return false;
  }
}

module.exports = { indexarProducto, aDocumento };
