// Reglas de negocio de «productos relacionados» (ver IA/ADR-006-recomendacion-semantica-vectorial.md), en un módulo
// puro —sin Elasticsearch, Mongo ni Redis— para que las apliquen igual el camino por significado (vectores) y el
// respaldo por subcategoría que se usa cuando el buscador está apagado o el producto aún no tiene vector.

// Cuántos se muestran en la ficha del producto.
const MOSTRAR = 6;
// Con menos que esto la sección se oculta: mejor nada que algo sin relación.
const MINIMO = 2;
// Cuántos vecinos se le piden al motor: de sobra para quitar repetidos y agotados y aun así llenar la lista.
const CANDIDATOS = 24;
// Coseno mínimo para considerar «parecido». Los vectores de multilingual-e5-small se agrupan en una franja angosta
// (en este catálogo, productos de categorías distintas tienen una mediana de 0,84 y los de la misma subcategoría de
// 0,93): un coseno de 0,8 todavía no significa «se parecen». 0,90 es el punto en que un vecino pasa a ser más
// probablemente de la misma subcategoría que de otra (51 %; con 0,88 es 27 %); los productos que así quedan con
// menos de MINIMO vecinos se resuelven por subcategoría. Medido por scripts/verificarSimilares.js (§7): si el
// catálogo cambia mucho, se vuelve a correr y se revisa este valor (ADR-006).
const UMBRAL_COSENO = 0.9;

const comoTitulo = (texto) => String(texto ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const hayStock = (producto) => (producto.inventario?.cantidad ?? 0) > 0;

// De los candidatos, ya en orden de relevancia, los que se muestran:
//  - sin repetidos: un producto con el mismo título que otro ya elegido, o que el producto que se está mirando
//    (`titulo`), no aporta nada a quien compara;
//  - lo agotado, al final: conserva el orden de relevancia dentro de cada grupo;
//  - un mismo vendedor ocupa a lo sumo la mitad de la lista, para que un solo vendedor no se quede con todos los lugares.
function elegir(candidatos, { titulo, limite = MOSTRAR } = {}) {
  const vistos = new Set(titulo ? [comoTitulo(titulo)] : []);
  const unicos = candidatos.filter((producto) => {
    const clave = comoTitulo(producto.descripcion);
    if (vistos.has(clave)) return false;
    vistos.add(clave);
    return true;
  });
  const ordenados = [...unicos.filter(hayStock), ...unicos.filter((producto) => !hayStock(producto))];
  const porVendedor = new Map();
  const maximoPorVendedor = Math.ceil(limite / 2);
  const elegidos = [];
  for (const producto of ordenados) {
    if (elegidos.length === limite) break;
    const ocupados = porVendedor.get(producto.vendedor_id) ?? 0;
    if (ocupados >= maximoPorVendedor) continue;
    porVendedor.set(producto.vendedor_id, ocupados + 1);
    elegidos.push(producto);
  }
  return elegidos;
}

module.exports = { MOSTRAR, MINIMO, CANDIDATOS, UMBRAL_COSENO, elegir };
