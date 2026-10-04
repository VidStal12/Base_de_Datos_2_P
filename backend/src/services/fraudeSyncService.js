const crypto = require('node:crypto');
const neo4j = require('../config/neo4j');
const prisma = require('../config/prisma');
const { conectar: conectarMongo } = require('../config/mongo');
const Subcategoria = require('../models/mongo/Subcategoria');

// Reenvío de mejor esfuerzo hacia Neo4j (Entrega 2, ver
// IA/PLAN-NEO4J-DETECCION-FRAUDE.md §6 y §16-§17) — copia derivada de
// compras/reseñas ya confirmadas en MySQL/Mongo, nunca al revés. A diferencia
// del outbox de ventas (ADR-004 §5), esto no tiene reintento durable: si falla,
// el próximo backfill (`scripts/backfillNeo4j.js`) lo recupera. Aceptado a
// propósito — una señal de fraude tarde unos segundos o minutos de más no tiene
// el mismo costo que una venta perdida del panel (ver ENTREGA-3-CONSISTENCIA.md
// §3).
//
// Mismas funciones para el camino en vivo (llamadas desde checkoutService.js/
// resenaService.js) y para el backfill de datos históricos — una sola
// implementación, no dos que se puedan desalinear.
//
// Modelo (ver PLAN §17-§18): el grafo guarda cuánto gasta una cuenta (monto + id
// de la compra), en qué categoría compra, cómo se llama y qué buzón de correo
// usa (para encontrar cuentas de una misma persona) y quién vende cada producto
// (para encontrar quien se compra a sí mismo).

// `usuarios.correo` es UNIQUE en MySQL y los nombres no: dos cuentas de una
// misma persona suelen repetir "nombres + apellidos" tal cual. Se compara
// EXACTO después de normalizar el formato — mayúsculas, tildes de las vocales,
// puntuación y espacios repetidos — nunca de forma aproximada: una coincidencia
// aproximada cambiaría falsos negativos de hoy por falsos positivos nuevos
// (mismo criterio que tenía el normalizador de direcciones). La "ñ" se deja
// intacta a propósito: "Peña" y "Pena" son apellidos distintos, no una variante
// de escritura. El nombre ya vive en el grafo en claro (`Usuario.nombre`), así
// que esta clave no agrega ningún dato personal nuevo.
const MAPA_ACENTOS = { á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u', ü: 'u' };

function normalizarNombre(nombreCompleto) {
  return String(nombreCompleto || '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[áéíóúü]/g, (c) => MAPA_ACENTOS[c])
    .replace(/[.,;:'"-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// `usuarios.correo` es UNIQUE en MySQL: dos cuentas nunca pueden registrar el
// correo EXACTO, así que comparar el texto crudo jamás encontraría nada. Lo que
// sí comparten dos cuentas de una misma persona es el BUZÓN: `ana+2@x.com` y
// `ana@x.com` llegan al mismo lugar, Gmail además ignora los puntos
// (`a.na@gmail.com` == `ana@gmail.com`) y trata `googlemail.com` como
// `gmail.com`. Se normaliza solo lo que sabemos que es el mismo buzón, nunca
// variaciones de contenido (fuera de Gmail, `ana.gomez` y `anagomez` SON
// buzones distintos).
function normalizarCorreo(correo) {
  const texto = String(correo || '').trim().toLowerCase();
  const arroba = texto.lastIndexOf('@');
  if (arroba < 1) return texto;
  let local = texto.slice(0, arroba);
  let dominio = texto.slice(arroba + 1);
  if (dominio === 'googlemail.com') dominio = 'gmail.com';
  local = local.split('+')[0] || local;
  if (dominio === 'gmail.com') local = local.replace(/\./g, '') || local;
  return `${local}@${dominio}`;
}

// Neo4j guarda únicamente el SHA-256 del buzón normalizado, no el correo: sirve
// para saber si dos cuentas comparten buzón sin copiar un dato personal a una
// base que todavía no tiene control de acceso real (ver PLAN §5, "no se copian
// datos personales al grafo"). Es seudonimización, no cifrado. El correo
// legible se resuelve en vivo desde MySQL al armar la ficha del administrador.
function hashCorreo(correo) {
  return crypto.createHash('sha256').update(normalizarCorreo(correo)).digest('hex');
}

// El correo sale de MySQL, no del llamador: el vendedor de un producto (que
// puede no haber comprado nunca) solo llega acá con su id, y así los puntos de
// llamada de checkout/reseñas no cambian. No hay edición de perfil, el correo
// de una cuenta no cambia: se recuerda por proceso.
const correoPorUsuario = new Map();

async function hashCorreoDe(usuarioId) {
  if (!correoPorUsuario.has(usuarioId)) {
    const usuario = await prisma.usuarios.findUnique({ where: { id_usuario: usuarioId }, select: { correo: true } });
    correoPorUsuario.set(usuarioId, usuario?.correo ?? null);
  }
  const correo = correoPorUsuario.get(usuarioId);
  return correo ? hashCorreo(correo) : null;
}

// El catálogo documental no permite editar ni borrar categorías/subcategorías
// una vez creadas (ver ESTADO-PROYECTO.md §5), así que subcategoría ->
// categoría nunca cambia y se puede recordar en memoria sin invalidarla.
const categoriaPorSubcategoria = new Map();

async function resolverCategoriaId(subcategoriaId) {
  const clave = String(subcategoriaId);
  if (!categoriaPorSubcategoria.has(clave)) {
    await conectarMongo();
    const subcategoria = await Subcategoria.findById(subcategoriaId).select('categoria_id').lean();
    if (!subcategoria) throw new Error(`No se encontró la subcategoría ${clave} para resolver su categoría`);
    categoriaPorSubcategoria.set(clave, String(subcategoria.categoria_id));
  }
  return categoriaPorSubcategoria.get(clave);
}

const MERGE_USUARIO = `
MERGE (u:Usuario {id_usuario: $usuarioId})
  SET u.nombre = $usuarioNombre, u.rol = $usuarioRol
MERGE (n:Nombre {clave: $nombreClave})
MERGE (u)-[:SE_LLAMA]->(n)
FOREACH (ignorar IN CASE WHEN $correoHash IS NULL THEN [] ELSE [1] END |
  MERGE (e:Correo {hash: $correoHash})
  MERGE (u)-[:USA_CORREO]->(e))
`;

// El vendedor se crea como Usuario aunque nunca haya comprado ni reseñado — un
// vendedor que solo vende también puede ser parte de una autocompra. Su `rol`
// no se conoce acá (no se consulta MySQL por cada línea); queda sin setear
// hasta que esa misma cuenta compre o reseñe. `coalesce` para no pisar un
// nombre ya sincronizado con el cacheado en el producto (vendedor_nombre).
const MERGE_PRODUCTO_Y_VENDEDOR = `
MERGE (p:Producto {producto_id: $productoId})
  SET p.descripcion = $productoDescripcion, p.subcategoria = $subcategoriaId, p.categoria = $categoriaId
MERGE (v:Usuario {id_usuario: $vendedorId})
  SET v.nombre = coalesce(v.nombre, $vendedorNombre)
MERGE (nv:Nombre {clave: $vendedorNombreClave})
MERGE (v)-[:SE_LLAMA]->(nv)
FOREACH (ignorar IN CASE WHEN $vendedorCorreoHash IS NULL THEN [] ELSE [1] END |
  MERGE (ev:Correo {hash: $vendedorCorreoHash})
  MERGE (v)-[:USA_CORREO]->(ev))
MERGE (v)-[:VENDE]->(p)
`;

const MERGE_COMPRA = `
${MERGE_USUARIO}
${MERGE_PRODUCTO_Y_VENDEDOR}
MERGE (u)-[c:COMPRÓ {detalle_id: $detalleId}]->(p)
  SET c.compra_id = $compraId, c.fecha = datetime($fecha), c.monto = $monto,
      c.subcategoria = $subcategoriaId, c.categoria = $categoriaId
`;

// detalleId: compra_detalle.id (mismo identificador natural que ya usa el
// outbox de ventas) — sin esto en la clave del MERGE, dos compras distintas
// del mismo producto por el mismo usuario colapsarían en una sola arista.
// compraId: varias líneas son UNA compra para el banco (el gasto se mide por
// pedido, no por línea), así que cada arista recuerda a qué pedido pertenece.
// categoria queda en la arista y no solo en el producto: es "en qué categoría
// compró ESA vez". vendedorId/vendedorNombre salen del documento del producto
// en Mongo (vendedor_id/vendedor_nombre, cacheados al crearlo).
async function registrarCompra({
  detalleId,
  compraId,
  usuarioId,
  usuarioNombre,
  usuarioRol,
  vendedorId,
  vendedorNombre,
  productoId,
  productoDescripcion,
  subcategoriaId,
  fecha,
  monto,
}) {
  const [categoriaId, correoHash, vendedorCorreoHash] = await Promise.all([
    resolverCategoriaId(subcategoriaId),
    hashCorreoDe(usuarioId),
    hashCorreoDe(vendedorId),
  ]);
  await neo4j.escribir(MERGE_COMPRA, {
    detalleId,
    compraId,
    usuarioId,
    usuarioNombre,
    usuarioRol,
    nombreClave: normalizarNombre(usuarioNombre),
    correoHash,
    vendedorId,
    vendedorNombre,
    vendedorNombreClave: normalizarNombre(vendedorNombre),
    vendedorCorreoHash,
    productoId,
    productoDescripcion,
    subcategoriaId: String(subcategoriaId),
    categoriaId,
    fecha: new Date(fecha).toISOString(),
    monto: Number(monto),
  });
}

const MERGE_RESENA = `
${MERGE_USUARIO}
${MERGE_PRODUCTO_Y_VENDEDOR}
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
  vendedorId,
  vendedorNombre,
  productoId,
  productoDescripcion,
  subcategoriaId,
  calificacion,
  fecha,
}) {
  const [categoriaId, correoHash, vendedorCorreoHash] = await Promise.all([
    resolverCategoriaId(subcategoriaId),
    hashCorreoDe(usuarioId),
    hashCorreoDe(vendedorId),
  ]);
  await neo4j.escribir(MERGE_RESENA, {
    usuarioId,
    usuarioNombre,
    usuarioRol,
    nombreClave: normalizarNombre(usuarioNombre),
    correoHash,
    vendedorId,
    vendedorNombre,
    vendedorNombreClave: normalizarNombre(vendedorNombre),
    vendedorCorreoHash,
    productoId,
    productoDescripcion,
    subcategoriaId: String(subcategoriaId),
    categoriaId,
    calificacion,
    fecha: new Date(fecha).toISOString(),
  });
}

module.exports = { registrarCompra, registrarResena, normalizarNombre, normalizarCorreo, hashCorreo };
