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
// Modelo (ver PLAN §17-§19 y §22): el grafo guarda cuánto gasta una cuenta (monto + id
// de la compra), en qué categoría compra, qué buzón de correo usa y desde qué
// dispositivo entra (para encontrar cuentas de una misma persona), quién vende cada
// producto (para encontrar quien se compra a sí mismo) y qué productos son el MISMO
// artículo (para encontrar a un vendedor que revende lo que le compró a otro).
//
// El NOMBRE ya no es un vínculo entre cuentas (§22): dos personas distintas pueden
// llamarse igual, y el nombre solo bastaba para marcar con confianza «alta» una compra
// entre homónimos. Lo reemplaza el dispositivo (registrarDispositivo, más abajo). El
// nombre sigue en el grafo únicamente como dato para mostrar (`Usuario.nombre`).

// Normaliza el FORMATO de un texto — mayúsculas, tildes de las vocales, puntuación y
// espacios repetidos — para compararlo EXACTO, nunca de forma aproximada: una
// coincidencia aproximada cambiaría falsos negativos de hoy por falsos positivos
// nuevos. La "ñ" se deja intacta a propósito: "Peña" y "Pena" son palabras distintas,
// no una variante de escritura. Hoy lo usan la clave canónica de un artículo
// (claveArticulo, más abajo) y la comparación de atributos de la señal de reventa; ya
// no compara nombres de personas.
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

// Dos productos son "el mismo artículo" para la señal de reventa cuando sus
// nombres dicen lo mismo — la clave canónica de abajo. Es una coincidencia
// de TÍTULO, nunca una prueba de que sea la misma pieza física (el catálogo no
// tiene un código de producto compartido entre vendedores), así que la señal
// que la usa parte como "posible" y sube con corroboración (ver fraudeService).
//
// Se compara EXACTO después de normalizar, nunca aproximado — mismo criterio que
// el nombre de una persona: una coincidencia aproximada cambiaría falsos
// negativos de hoy por falsos positivos nuevos. Lo que se normaliza es el
// formato: mayúsculas, tildes, puntuación, y además el ORDEN de las palabras y
// los artículos/preposiciones ("Camiseta de algodón orgánico" y "Algodón
// orgánico, camiseta" dicen lo mismo). Se conservan números y unidades ("26cm",
// "x100", "128gb"): distinguen modelos. Límite honesto: quien cambie una palabra
// del título, o agregue un adjetivo, deja de coincidir.
const PALABRAS_VACIAS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'unos', 'unas', 'y', 'e', 'o', 'u', 'con', 'sin', 'para', 'por', 'en', 'al']);

function claveArticulo(nombre) {
  const palabras = normalizarNombre(nombre).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const significativas = palabras.filter((palabra) => !PALABRAS_VACIAS.has(palabra));
  // Un nombre hecho solo de palabras vacías ("de la") no puede quedar con
  // clave vacía: colisionaría con cualquier otra igual de vacía.
  return [...new Set(significativas.length > 0 ? significativas : palabras)].sort().join(' ');
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
FOREACH (ignorar IN CASE WHEN $correoHash IS NULL THEN [] ELSE [1] END |
  MERGE (e:Correo {hash: $correoHash})
  MERGE (u)-[:USA_CORREO]->(e))
`;

// El vendedor se crea como Usuario aunque nunca haya comprado ni reseñado — un
// vendedor que solo vende también puede ser parte de una autocompra. Su `rol`
// no se conoce acá (no se consulta MySQL por cada línea); queda sin setear
// hasta que esa misma cuenta compre o reseñe. `coalesce` para no pisar un
// nombre ya sincronizado con el cacheado en el producto (vendedor_nombre).
//
// El producto se enlaza a su Articulo (la clave canónica de su nombre, ver
// claveArticulo) y se DESENLAZA del anterior si el nombre cambió: un
// producto pertenece a un solo artículo — y si ese artículo se queda sin ningún
// producto, se borra, para que editar títulos no vaya dejando nodos huérfanos. Es una subconsulta "unitaria" (sin
// RETURN), así que no cambia las filas ni las variables de la consulta que la
// contiene — la misma plantilla sirve para compras, reseñas y altas/ediciones
// de producto, y el enlace queda al día sin importar por cuál camino se tocó.
const MERGE_PRODUCTO_Y_VENDEDOR = `
MERGE (p:Producto {producto_id: $productoId})
  SET p.nombre = $productoNombre, p.descripcion = $productoDescripcion, p.subcategoria = $subcategoriaId, p.categoria = $categoriaId
MERGE (v:Usuario {id_usuario: $vendedorId})
  SET v.nombre = coalesce(v.nombre, $vendedorNombre)
FOREACH (ignorar IN CASE WHEN $vendedorCorreoHash IS NULL THEN [] ELSE [1] END |
  MERGE (ev:Correo {hash: $vendedorCorreoHash})
  MERGE (v)-[:USA_CORREO]->(ev))
MERGE (v)-[:VENDE]->(p)
WITH *
CALL {
  WITH p
  OPTIONAL MATCH (p)-[viejo:ES_ARTICULO]->(anterior:Articulo)
  WHERE anterior.clave <> $articuloClave
  DELETE viejo
  WITH anterior
  WHERE anterior IS NOT NULL AND NOT (anterior)<-[:ES_ARTICULO]-()
  DELETE anterior
}
MERGE (a:Articulo {clave: $articuloClave})
MERGE (p)-[:ES_ARTICULO]->(a)
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
  productoNombre,
  productoDescripcion,
  subcategoriaId,
  fecha,
  monto,
}) {
  await neo4j.asegurarEsquema();
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
    correoHash,
    vendedorId,
    vendedorNombre,
    vendedorCorreoHash,
    productoId,
    productoNombre,
    productoDescripcion,
    articuloClave: claveArticulo(productoNombre),
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
  productoNombre,
  productoDescripcion,
  subcategoriaId,
  calificacion,
  fecha,
}) {
  await neo4j.asegurarEsquema();
  const [categoriaId, correoHash, vendedorCorreoHash] = await Promise.all([
    resolverCategoriaId(subcategoriaId),
    hashCorreoDe(usuarioId),
    hashCorreoDe(vendedorId),
  ]);
  await neo4j.escribir(MERGE_RESENA, {
    usuarioId,
    usuarioNombre,
    usuarioRol,
    correoHash,
    vendedorId,
    vendedorNombre,
    vendedorCorreoHash,
    productoId,
    productoNombre,
    productoDescripcion,
    articuloClave: claveArticulo(productoNombre),
    subcategoriaId: String(subcategoriaId),
    categoriaId,
    calificacion,
    fecha: new Date(fecha).toISOString(),
  });
}

// Un producto PUBLICADO entra al grafo aunque nadie lo haya comprado todavía:
// la reventa se ve justamente en la publicación que un vendedor hace DESPUÉS de
// comprarle a otro, y esa publicación casi nunca tiene una sola compra. Se llama
// al crear y al editar un producto (productoService) y desde el backfill — así
// el nombre nuevo se vuelve a enlazar a su Articulo. El estado (activo /
// inactivo), la fecha de publicación y los atributos NO se copian acá: cambian
// por otros caminos y se leen EN VIVO de Mongo al armar el hallazgo, para que
// "hoy lo está vendiendo" sea siempre lo que dice el catálogo y no una copia.
const MERGE_PRODUCTO = MERGE_PRODUCTO_Y_VENDEDOR;

async function registrarProducto({ productoId, productoNombre, productoDescripcion, subcategoriaId, vendedorId, vendedorNombre }) {
  await neo4j.asegurarEsquema();
  const [categoriaId, vendedorCorreoHash] = await Promise.all([resolverCategoriaId(subcategoriaId), hashCorreoDe(vendedorId)]);
  await neo4j.escribir(MERGE_PRODUCTO, {
    vendedorId,
    vendedorNombre,
    vendedorCorreoHash,
    productoId,
    productoNombre,
    productoDescripcion,
    articuloClave: claveArticulo(productoNombre),
    subcategoriaId: String(subcategoriaId),
    categoriaId,
  });
}

// Un dispositivo desde el que una cuenta entró (§22): reemplaza al nombre como vínculo entre cuentas. Los
// nodos son COMPARTIDOS, igual que `Correo` lo era para el buzón: dos cuentas que entraron desde el mismo
// dispositivo convergen en el mismo `Dispositivo`, y dos dispositivos con el mismo perfil de equipo en el mismo
// `Perfil` —
//   (:Usuario)-[:USO_DISPOSITIVO {primera_vez, ultima_vez, inicios}]->(:Dispositivo {hash, etiqueta})
//   (:Dispositivo)-[:TIENE_PERFIL]->(:Perfil {hash})
// Solo viajan hashes (ver dispositivoService.js): el identificador que genera el navegador no entra al grafo.
// `Usuario` se crea aquí si todavía no existe (alguien que se registra y entra pero aún no compró ni vendió).
// `coalesce`: si ya se conocía el nombre o el rol de la cuenta (lo escriben las compras), no se pisa con null.
const MERGE_DISPOSITIVO = `
MERGE (u:Usuario {id_usuario: $usuarioId})
  SET u.nombre = coalesce($usuarioNombre, u.nombre), u.rol = coalesce($usuarioRol, u.rol)
FOREACH (ignorar IN CASE WHEN $correoHash IS NULL THEN [] ELSE [1] END |
  MERGE (e:Correo {hash: $correoHash})
  MERGE (u)-[:USA_CORREO]->(e))
MERGE (d:Dispositivo {hash: $dispositivoHash})
  SET d.etiqueta = $etiqueta
MERGE (u)-[r:USO_DISPOSITIVO]->(d)
  ON CREATE SET r.primera_vez = datetime($primeraVez)
  SET r.ultima_vez = datetime($ultimaVez), r.inicios = $inicios
FOREACH (ignorar IN CASE WHEN $perfilHash IS NULL THEN [] ELSE [1] END |
  MERGE (p:Perfil {hash: $perfilHash})
  MERGE (d)-[:TIENE_PERFIL]->(p))
`;

// Dos inicios de sesión simultáneos desde el mismo dispositivo ejecutan este MERGE a la vez; sin una restricción
// de unicidad, Neo4j puede crear DOS nodos Dispositivo con el mismo hash y partir en dos al grupo. La
// restricción (idempotente: IF NOT EXISTS) lo impide y además crea el índice por el que se busca el hash.
async function registrarDispositivo({ usuarioId, usuarioNombre = null, usuarioRol = null, dispositivoHash, perfilHash = null, etiqueta = null, primeraVez, ultimaVez, inicios }) {
  await neo4j.asegurarEsquema();
  // El buzón también, como en toda escritura que crea un Usuario: todo Usuario del grafo lo tiene.
  const correoHash = await hashCorreoDe(usuarioId);
  await neo4j.escribir(MERGE_DISPOSITIVO, {
    usuarioId,
    usuarioNombre,
    usuarioRol,
    correoHash,
    dispositivoHash,
    etiqueta,
    perfilHash,
    primeraVez: new Date(primeraVez).toISOString(),
    ultimaVez: new Date(ultimaVez).toISOString(),
    inicios: Number(inicios),
  });
}

module.exports = { registrarCompra, registrarResena, registrarProducto, registrarDispositivo, normalizarNombre, normalizarCorreo, hashCorreo, claveArticulo };
