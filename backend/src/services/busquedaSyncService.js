const { conectar, indice } = require('../config/elasticsearch');

// Documento de búsqueda a partir del MISMO objeto que ya arma
// productoService.obtener()/formatear() — no vuelve a resolver
// subcategoría/categoría por su cuenta, evita una segunda fuente de verdad
// para lo mismo dato. imagen_url se guarda (index:false en el mapping) para
// que los resultados de búsqueda se puedan mostrar sin un segundo viaje a
// Mongo — mismo criterio que vendedor_nombre cacheado en Producto.js.
function aDocumento(producto) {
  return {
    producto_id: producto.id,
    descripcion: producto.descripcion,
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
async function indexarProducto(producto) {
  try {
    const cliente = await conectar();
    await cliente.index({
      index: indice(),
      id: String(producto.id),
      document: aDocumento(producto),
    });
  } catch (err) {
    console.error('No se pudo indexar el producto en Elasticsearch:', err.message);
  }
}

module.exports = { indexarProducto, aDocumento };
