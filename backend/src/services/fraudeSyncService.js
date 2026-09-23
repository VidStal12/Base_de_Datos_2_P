const neo4j = require('../config/neo4j');

// Reenvío de mejor esfuerzo hacia Neo4j (Entrega 2, ver
// IA/PLAN-NEO4J-DETECCION-FRAUDE.md §6) — copia derivada de compras/reseñas
// ya confirmadas en MySQL/Mongo, nunca al revés. A diferencia del outbox de
// ventas (ADR-004 §5), esto no tiene reintento durable: si falla, el próximo
// backfill (`scripts/backfillNeo4j.js`) lo recupera. Aceptado a propósito —
// una señal de fraude tarde unos segundos o minutos de más no tiene el mismo
// costo que una venta perdida del panel (ver ENTREGA-3-CONSISTENCIA.md §3).
//
// Mismas funciones para el camino en vivo (llamadas desde checkoutService.js/
// resenaService.js) y para el backfill de datos históricos — una sola
// implementación, no dos que se puedan desalinear.

// Direccion/MetodoPago NO se clavan por id_direccion/id_metodo_pago — cada
// fila de esas tablas pertenece a un solo usuario (FK id_usuario), así que
// dos cuentas nunca podrían compartir el mismo id por construcción, y la
// Señal B (¿dos cuentas apuntan al mismo domicilio/instrumento de pago?)
// jamás encontraría nada, sin importar qué datos existan. La clave real es
// el CONTENIDO: misma dirección física (normalizada) o mismo token de la
// pasarela de pago — dos cuentas "independientes" que en realidad cargaron
// el mismo domicilio o la misma tarjeta sí son la señal que se busca.
//
// A propósito sigue siendo comparación EXACTA después de normalizar, nunca
// aproximada (tipo Elasticsearch/fuzzy) — para una señal de fraude, una
// coincidencia aproximada cambia qué tan seguro hay que estar de que es la
// MISMA dirección física, y una dirección con estructura (calle/número/
// apartamento) puede diferir en un solo carácter y ser un lugar
// completamente distinto. Tolerancia a variaciones de ESCRITURA pertenece al
// buscador de productos (Entrega 3), no a esto — acá solo se colapsan
// variaciones de FORMATO que sabemos que son la misma dirección (espacios,
// tildes, un puñado de abreviaturas comunes en Guatemala), nunca variaciones
// de contenido. Encontrado en datos reales de esta sesión: una dirección
// sembrada quedó como "...El Salvador , " (coma y espacio colgando) — antes
// de esto, esa fila nunca iba a calzar con la misma dirección escrita sin
// esa coma.
const ABREVIATURAS_DIRECCION = [
  [/\bav\.?\b/g, 'avenida'],
  [/\bcalz\.?\b/g, 'calzada'],
  [/\bcol\.?\b/g, 'colonia'],
  [/\bzn\.?\b/g, 'zona'],
];

const MAPA_ACENTOS = { á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u', ü: 'u' };

// Solo vocales acentuadas — "ñ" se deja intacta a propósito, no es una
// variante de escritura de "n" (son letras distintas en español), a
// diferencia de "á"/"a" donde la tilde sí se omite todo el tiempo al
// escribir rápido o desde un teclado sin acentos.
function quitarAcentos(texto) {
  return texto.replace(/[áéíóúü]/g, (c) => MAPA_ACENTOS[c]);
}

function limpiarCampo(valor) {
  let texto = quitarAcentos(String(valor || '').toLowerCase());
  for (const [patron, reemplazo] of ABREVIATURAS_DIRECCION) {
    texto = texto.replace(patron, reemplazo);
  }
  return texto
    .replace(/[.,;:]+/g, ' ') // puntuación de formato → espacio, no se borra sin dejar rastro
    .replace(/\s+/g, ' ') // espacios repetidos (incluido el caso de arriba) → uno solo
    .trim();
}

function normalizarDireccion({ pais, direccion, codigo_postal }) {
  return [pais, direccion, codigo_postal].map(limpiarCampo).join('|');
}

const MERGE_COMPRA = `
MERGE (u:Usuario {id_usuario: $usuarioId})
  SET u.nombre = $usuarioNombre, u.rol = $usuarioRol
MERGE (p:Producto {producto_id: $productoId})
  SET p.descripcion = $productoDescripcion, p.subcategoria = $subcategoriaId
MERGE (d:Direccion {direccion_texto: $direccionTexto})
MERGE (m:MetodoPago {token_pasarela: $metodoPagoToken})
MERGE (u)-[c:COMPRÓ {detalle_id: $detalleId}]->(p)
  SET c.fecha = datetime($fecha), c.monto = $monto,
      c.direccion_texto = $direccionTexto, c.metodo_pago_token = $metodoPagoToken
MERGE (u)-[:ENVIÓ_A]->(d)
MERGE (u)-[:PAGÓ_CON]->(m)
`;

// detalleId: compra_detalle.id (mismo identificador natural que ya usa el
// outbox de ventas) — sin esto en la clave del MERGE, dos compras distintas
// del mismo producto por el mismo usuario colapsarían en una sola arista, y
// la Señal B (ver fraudeService.js) necesita poder mirar cada compra por
// separado. direccion/metodoPago: los objetos completos ({pais, direccion,
// codigo_postal} / {token_pasarela}), no solo el id — hace falta el
// contenido para la clave real (ver arriba).
async function registrarCompra({
  detalleId,
  usuarioId,
  usuarioNombre,
  usuarioRol,
  productoId,
  productoDescripcion,
  subcategoriaId,
  direccion,
  metodoPago,
  fecha,
  monto,
}) {
  await neo4j.escribir(MERGE_COMPRA, {
    detalleId,
    usuarioId,
    usuarioNombre,
    usuarioRol,
    productoId,
    productoDescripcion,
    subcategoriaId: String(subcategoriaId),
    direccionTexto: normalizarDireccion(direccion),
    metodoPagoToken: metodoPago.token_pasarela,
    fecha: new Date(fecha).toISOString(),
    monto: Number(monto),
  });
}

const MERGE_RESENA = `
MERGE (u:Usuario {id_usuario: $usuarioId})
  SET u.nombre = $usuarioNombre, u.rol = $usuarioRol
MERGE (p:Producto {producto_id: $productoId})
  SET p.descripcion = $productoDescripcion, p.subcategoria = $subcategoriaId
MERGE (u)-[r:RESEÑÓ]->(p)
  SET r.calificacion = $calificacion, r.fecha = datetime($fecha)
`;

// Sin clave extra en el MERGE de la relación — a diferencia de COMPRÓ, acá
// el índice único de Resena.js (producto_id, usuario_id) ya garantiza una
// sola reseña por par, así que una sola arista es lo correcto, no pérdida de
// datos.
async function registrarResena({
  usuarioId,
  usuarioNombre,
  usuarioRol,
  productoId,
  productoDescripcion,
  subcategoriaId,
  calificacion,
  fecha,
}) {
  await neo4j.escribir(MERGE_RESENA, {
    usuarioId,
    usuarioNombre,
    usuarioRol,
    productoId,
    productoDescripcion,
    subcategoriaId: String(subcategoriaId),
    calificacion,
    fecha: new Date(fecha).toISOString(),
  });
}

module.exports = { registrarCompra, registrarResena };
