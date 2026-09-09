const neo4j = require('../config/neo4j');

// Señal A (ver IA/PLAN-NEO4J-DETECCION-FRAUDE.md §3): cuentas distintas que
// reseñan el mismo conjunto de productos, en una ventana de tiempo corta,
// con calificaciones altas — coordinación entre reseñas de compras YA
// verificadas (reseñar sin comprar ya no es posible, ver resenaService.js).
const CONSULTA_RESENAS_COORDINADAS = `
MATCH (u1:Usuario)-[r1:RESEÑÓ]->(p:Producto)<-[r2:RESEÑÓ]-(u2:Usuario)
WHERE u1.id_usuario < u2.id_usuario
  AND abs(duration.between(r1.fecha, r2.fecha).seconds) < $ventanaSegundos
  AND r1.calificacion >= $calificacionMinima AND r2.calificacion >= $calificacionMinima
WITH u1, u2, collect(DISTINCT p.descripcion) AS productos
WHERE size(productos) >= $minimoProductosCompartidos
RETURN u1.id_usuario AS usuario1Id, u1.nombre AS usuario1Nombre,
       u2.id_usuario AS usuario2Id, u2.nombre AS usuario2Nombre,
       size(productos) AS productosCompartidos, productos
ORDER BY productosCompartidos DESC
`;

// Señal B (ver IA/PLAN-NEO4J-DETECCION-FRAUDE.md §4): una compra en una
// subcategoría que esa cuenta nunca tocó antes, Y ESA MISMA compra usó una
// dirección que otra cuenta distinta también usó (no "la cuenta tiene AL­
// GUNA dirección compartida en algún momento" — la dirección compartida
// tiene que ser la de la compra que se está señalando, si no, dos
// condiciones ciertas por separado pero de compras distintas no dicen nada).
const CONSULTA_DESVIACION_PATRON = `
MATCH (u:Usuario)-[c:COMPRÓ]->(p:Producto)
WHERE NOT EXISTS {
  MATCH (u)-[c2:COMPRÓ]->(otro:Producto)
  WHERE otro.subcategoria = p.subcategoria AND otro <> p AND c.fecha > c2.fecha
}
MATCH (u)-[:ENVIÓ_A]->(d:Direccion {direccion_texto: c.direccion_texto})<-[:ENVIÓ_A]-(otraCuenta:Usuario)
WHERE otraCuenta.id_usuario <> u.id_usuario
RETURN u.id_usuario AS usuarioId, u.nombre AS usuarioNombre,
       p.producto_id AS productoId, p.descripcion AS productoDescripcion,
       otraCuenta.id_usuario AS otraCuentaId, otraCuenta.nombre AS otraCuentaNombre,
       c.fecha AS fecha
ORDER BY c.fecha DESC
`;

// El driver de Neo4j devuelve los enteros como objetos `Integer` propios (no
// números de JS planos, para no perder precisión con valores más grandes de
// lo que Number puede representar exacto) — renderizarlos directo en JSX
// tira "Objects are not valid as a React child". Acá los id/conteos nunca se
// acercan a ese límite, así que convertir con toNumber() es seguro sin
// perder nada.
function aNumero(valor) {
  return typeof valor?.toNumber === 'function' ? valor.toNumber() : valor;
}

// Parámetros ajustables con default (ver PLAN-NEO4J-DETECCION-FRAUDE.md §10)
// — nunca interpolados en la consulta.
async function resenasCoordinadas({ ventanaSegundos = 3600, minimoProductosCompartidos = 3, calificacionMinima = 4 } = {}) {
  const registros = await neo4j.leer(CONSULTA_RESENAS_COORDINADAS, { ventanaSegundos, minimoProductosCompartidos, calificacionMinima });
  return registros.map((r) => ({
    usuario1: { id: aNumero(r.get('usuario1Id')), nombre: r.get('usuario1Nombre') },
    usuario2: { id: aNumero(r.get('usuario2Id')), nombre: r.get('usuario2Nombre') },
    productosCompartidos: aNumero(r.get('productosCompartidos')),
    productos: r.get('productos'),
  }));
}

async function desviacionPatron() {
  const registros = await neo4j.leer(CONSULTA_DESVIACION_PATRON, {});
  return registros.map((r) => ({
    usuario: { id: aNumero(r.get('usuarioId')), nombre: r.get('usuarioNombre') },
    producto: { id: aNumero(r.get('productoId')), descripcion: r.get('productoDescripcion') },
    otraCuenta: { id: aNumero(r.get('otraCuentaId')), nombre: r.get('otraCuentaNombre') },
    fecha: r.get('fecha')?.toString?.() ?? null,
  }));
}

// Corre las dos señales juntas para el panel — cada una es independiente,
// que una falle no debe tirar abajo a la otra (mismo criterio que
// ventasService.js con `advertencias` en vez de un error total).
async function consultarFraude(parametros = {}) {
  const advertencias = [];
  const [resenas, desviaciones] = await Promise.all([
    resenasCoordinadas(parametros).catch((err) => {
      advertencias.push(`No se pudo evaluar reseñas coordinadas: ${err.message}`);
      return [];
    }),
    desviacionPatron().catch((err) => {
      advertencias.push(`No se pudo evaluar desviación de patrón: ${err.message}`);
      return [];
    }),
  ]);
  return { resenasCoordinadas: resenas, desviacionPatron: desviaciones, advertencias };
}

module.exports = { resenasCoordinadas, desviacionPatron, consultarFraude };
