const neo4jDriver = require('neo4j-driver');
const neo4j = require('../config/neo4j');
const prisma = require('../config/prisma');
const { conectar: conectarMongo } = require('../config/mongo');
const Resena = require('../models/mongo/Resena');
const Subcategoria = require('../models/mongo/Subcategoria');
const Categoria = require('../models/mongo/Categoria');
const Producto = require('../models/mongo/Producto');
const ProductoEvento = require('../models/mongo/ProductoEvento');
const { fechaGuatemala } = require('../utils/ventas');
const { normalizarNombre } = require('./fraudeSyncService');

// Siete señales independientes (ver IA/PLAN-NEO4J-DETECCION-FRAUDE.md §3, §16,
// §17, §18 y §19), cada una con su propia consulta Cypher:
//   A. Reseñas coordinadas — cuentas distintas reseñando lo mismo, en bloque.
//   B. Gasto anómalo — un pedido muy por encima de lo que esa misma cuenta
//      gastó en el pasado (la lógica con que un banco vigila a sus clientes).
//   C. Categoría inusual — la primera compra en una categoría ajena a una
//      cuenta con historial largo.
//   D. Cuentas de una misma persona — varias cuentas que se llaman igual o usan
//      el mismo buzón de correo, todas comprando (una persona con varias cuentas).
//   E. Ráfaga de gasto — mucho gasto o muchos pedidos en un solo día, aunque
//      cada pedido por separado se vea normal.
//   F. Autocompra — una cuenta que compra sus propios productos, o los de otra
//      cuenta de la misma persona (mismo nombre o buzón): mover dinero por el
//      comercio. (Desde §18 el sistema además IMPIDE esa compra; esta señal
//      detecta lo que ya existía antes de la regla, o cuentas distintas.)
//   G. Reventa — un vendedor que le compró un producto a OTRO vendedor y hoy
//      tiene publicado y activo uno equivalente (§19). Las cuentas que pueden
//      vender aceptan, al comprar, un compromiso de no reventa; esta señal ve
//      cuándo no se cumple.
// Ninguna es una acusación: son candidatos para revisión humana.
//
// Por defecto, la postura ante evidencia real es sospechar hasta que una
// persona confirme lo contrario: una señal corroborada por otra, independiente,
// SUBE el nivel a "alta"; nada de lo que se calcula acá puede bajarlo.

const PARAMETROS_POR_DEFECTO = {
  resenas: { ventanaSegundos: 3600, minimoProductosCompartidos: 3, calificacionMinima: 4 },
  // 5 compras previas: con menos no hay un patrón propio contra el cual
  // comparar. montoMinimo evita señalar saltos relativos pero triviales (de
  // Q40 a Q150 en un catálogo donde un celular cuesta Q2,600).
  gasto: { minimoOrdenesPrevias: 5, factorPromedio: 3, montoMinimo: 500 },
  // "Muchas compras y tiempo": 5 compras repartidas en al menos 30 días.
  categoria: { minimoOrdenesPrevias: 5, minimoDiasHistorial: 30 },
  relacionadas: { minimoCuentas: 2, minimoCuentasConCompras: 2 },
  // El "día" es el día calendario de Guatemala (UTC-6), el mismo que usa el
  // panel de ventas. minimoPedidos no exige un baseline: una cuenta nueva con
  // 5 pedidos el primer día es justo el patrón de prueba de tarjetas.
  rafaga: { minimoPedidos: 5, factorPedidos: 2, factorGasto: 3, montoMinimo: 500, minimoDiasPrevios: 3 },
};

function conDefectos(grupo, parametros) {
  const validos = Object.fromEntries(Object.entries(parametros || {}).filter(([, valor]) => valor !== undefined));
  return { ...(PARAMETROS_POR_DEFECTO[grupo] ?? {}), ...validos };
}

// El driver devuelve los enteros de Cypher (count, size, duraciones) como
// objetos `Integer` propios y las fechas como `DateTime` — nada de eso es
// serializable ni renderizable tal cual. Acá los ids y conteos nunca se acercan
// al límite de precisión de Number, así que convertir es seguro.
function aPlano(valor) {
  if (valor === null || valor === undefined) return valor;
  if (neo4jDriver.isInt(valor)) return valor.toNumber();
  if (neo4jDriver.isDateTime(valor)) return valor.toString();
  if (Array.isArray(valor)) return valor.map(aPlano);
  if (typeof valor === 'object') return Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, aPlano(v)]));
  return valor;
}

// ---------- Señal A: reseñas coordinadas ----------

// Cuentas distintas que reseñan el mismo conjunto de productos, en una ventana
// de tiempo corta, con calificaciones altas — coordinación entre reseñas de
// compras YA verificadas (reseñar sin comprar ya no es posible, ver
// resenaService.js). duration.inSeconds y no duration.between(...).seconds:
// este último solo devuelve el resto de segundos DESPUÉS de los días completos
// (dos reseñas con 2 días y 5 minutos de diferencia daban 300), así que la
// "ventana corta" aceptaba reseñas separadas por días.
const CONSULTA_RESENAS_COORDINADAS = `
MATCH (u1:Usuario)-[r1:RESEÑÓ]->(p:Producto)<-[r2:RESEÑÓ]-(u2:Usuario)
WHERE u1.id_usuario < u2.id_usuario
  AND abs(duration.inSeconds(r1.fecha, r2.fecha).seconds) < $ventanaSegundos
  AND r1.calificacion >= $calificacionMinima AND r2.calificacion >= $calificacionMinima
WITH u1, u2, collect(DISTINCT p.descripcion) AS productos,
     avg(r1.calificacion) AS promedio1, avg(r2.calificacion) AS promedio2,
     max(r1.fecha) AS ultima1, max(r2.fecha) AS ultima2
WHERE size(productos) >= $minimoProductosCompartidos
RETURN u1.id_usuario AS usuario1Id, u1.nombre AS usuario1Nombre,
       u2.id_usuario AS usuario2Id, u2.nombre AS usuario2Nombre,
       size(productos) AS productosCompartidos, productos,
       promedio1, promedio2,
       (CASE WHEN ultima1 > ultima2 THEN ultima1 ELSE ultima2 END) AS ultimaActividad
ORDER BY productosCompartidos DESC
`;

async function buscarResenasCoordinadas(parametros) {
  const registros = await neo4j.leer(CONSULTA_RESENAS_COORDINADAS, conDefectos('resenas', parametros));
  return registros.map((r) => {
    const f = aPlano(r.toObject());
    return {
      usuario1: { id: f.usuario1Id, nombre: f.usuario1Nombre },
      usuario2: { id: f.usuario2Id, nombre: f.usuario2Nombre },
      productosCompartidos: f.productosCompartidos,
      productos: f.productos,
      promedio1: f.promedio1,
      promedio2: f.promedio2,
      ultimaActividad: f.ultimaActividad ?? null,
    };
  });
}

// ---------- Señal B: gasto anómalo ----------

// El gasto se mide por PEDIDO (suma de sus líneas), no por línea: lo que un
// banco compara es el movimiento completo contra los movimientos anteriores de
// ese mismo cliente. Cada pedido se evalúa solo contra los que lo precedieron
// en el tiempo (`ordenes[0..i]` excluye al propio i), y exige un baseline mínimo
// — sin historial no hay "lo normal para esta cuenta" contra qué comparar.
// Se señala si el pedido supera el factor × el promedio previo Y además es el
// más alto que esa cuenta había hecho (un pedido grande que repite uno anterior
// no es una ruptura de patrón).
const CONSULTA_GASTO_ANOMALO = `
MATCH (u:Usuario)-[c:COMPRÓ]->(p:Producto)
WITH u, c.compra_id AS compraId, min(c.fecha) AS fecha, sum(c.monto) AS total,
     collect({productoId: p.producto_id, descripcion: p.descripcion, categoria: c.categoria, monto: c.monto}) AS lineas
ORDER BY fecha
WITH u, collect({compraId: compraId, fecha: fecha, total: total, lineas: lineas}) AS ordenes
UNWIND range(0, size(ordenes) - 1) AS i
WITH u, ordenes[i] AS orden, [o IN ordenes[0..i] | o.total] AS previos
WHERE size(previos) >= $minimoOrdenesPrevias
WITH u, orden, size(previos) AS ordenesPrevias,
     reduce(s = 0.0, x IN previos | s + x) / size(previos) AS promedio,
     reduce(m = 0.0, x IN previos | CASE WHEN x > m THEN x ELSE m END) AS maximo
WHERE orden.total >= $montoMinimo AND orden.total >= $factorPromedio * promedio AND orden.total > maximo
RETURN u.id_usuario AS usuarioId, u.nombre AS usuarioNombre,
       orden.compraId AS compraId, orden.fecha AS fecha, orden.total AS total, orden.lineas AS lineas,
       ordenesPrevias, promedio, maximo
ORDER BY fecha DESC
`;

async function buscarGastoAnomalo(parametros) {
  const registros = await neo4j.leer(CONSULTA_GASTO_ANOMALO, conDefectos('gasto', parametros));
  return registros.map((r) => {
    const f = aPlano(r.toObject());
    return {
      usuario: { id: f.usuarioId, nombre: f.usuarioNombre },
      compraId: f.compraId,
      fecha: f.fecha,
      total: f.total,
      lineas: f.lineas,
      ordenesPrevias: f.ordenesPrevias,
      promedio: f.promedio,
      maximo: f.maximo,
      vecesPromedio: f.promedio > 0 ? f.total / f.promedio : null,
    };
  });
}

// ---------- Señal C: categoría inusual ----------

// Una fila por (cuenta, categoría) con la PRIMERA compra de esa cuenta en esa
// categoría. Se señala si, hasta ese momento, la cuenta ya tenía un historial
// establecido (muchas compras y tiempo) — comprar en una categoría nueva
// siendo cliente nuevo es lo normal; hacerlo después de meses comprando siempre
// lo mismo es lo que se sale del patrón. `habituales` es en qué categorías
// compraba hasta entonces, para poder explicar contra qué se compara.
const CONSULTA_CATEGORIA_INUSUAL = `
MATCH (u:Usuario)-[c:COMPRÓ]->(:Producto)
WITH u, c.categoria AS categoria, min(c.fecha) AS primeraFecha
CALL {
  WITH u, primeraFecha
  MATCH (u)-[h:COMPRÓ]->(:Producto)
  WHERE h.fecha < primeraFecha
  RETURN count(DISTINCT h.compra_id) AS ordenesPrevias, min(h.fecha) AS inicioHistorial
}
WITH u, categoria, primeraFecha, ordenesPrevias, inicioHistorial
WHERE ordenesPrevias >= $minimoOrdenesPrevias
  AND duration.inDays(inicioHistorial, primeraFecha).days >= $minimoDiasHistorial
CALL {
  WITH u, primeraFecha
  MATCH (u)-[h:COMPRÓ]->(:Producto)
  WHERE h.fecha < primeraFecha
  WITH h.categoria AS cat, count(DISTINCT h.compra_id) AS ordenes
  RETURN collect({categoria: cat, ordenes: ordenes}) AS habituales
}
MATCH (u)-[c1:COMPRÓ]->(p1:Producto)
WHERE c1.categoria = categoria AND c1.fecha = primeraFecha
WITH u, categoria, primeraFecha, ordenesPrevias, inicioHistorial, habituales, c1.compra_id AS compraId,
     collect({productoId: p1.producto_id, descripcion: p1.descripcion, subcategoria: c1.subcategoria, monto: c1.monto}) AS productos
RETURN u.id_usuario AS usuarioId, u.nombre AS usuarioNombre, categoria, primeraFecha AS fecha,
       compraId, productos, ordenesPrevias,
       duration.inDays(inicioHistorial, primeraFecha).days AS diasHistorial, habituales
ORDER BY fecha DESC
`;

async function buscarCategoriaInusual(parametros) {
  const registros = await neo4j.leer(CONSULTA_CATEGORIA_INUSUAL, conDefectos('categoria', parametros));
  return registros.map((r) => {
    const f = aPlano(r.toObject());
    return {
      usuario: { id: f.usuarioId, nombre: f.usuarioNombre },
      categoriaId: f.categoria,
      compraId: f.compraId,
      fecha: f.fecha,
      productos: f.productos,
      ordenesPrevias: f.ordenesPrevias,
      diasHistorial: f.diasHistorial,
      habituales: f.habituales.sort((a, b) => b.ordenes - a.ordenes),
    };
  });
}

// ---------- Señal D: cuentas de una misma persona (mismo nombre o mismo buzón) ----------

// Dos formas de que varias cuentas sean la misma persona, ambas un nodo
// COMPARTIDO en el grafo:
//   - el mismo NOMBRE completo normalizado (fraudeSyncService.normalizarNombre):
//     lo más simple y frecuente — registrarse otra vez con el mismo nombre. Pero
//     dos personas distintas pueden llamarse igual, así que solo es una
//     coincidencia débil.
//   - el mismo BUZÓN de correo normalizado (normalizarCorreo): como
//     `usuarios.correo` es único, dos cuentas nunca registran el correo exacto,
//     así que compartir buzón (alias "+", puntos de Gmail) es una decisión
//     deliberada — evidencia fuerte, y la única que atrapa a quien cambia el
//     nombre pero reusa su bandeja.
// Se consultan por separado (la etiqueta y la relación no se pueden pasar como
// parámetro de Cypher; son constantes internas, nunca texto de un usuario) y
// después se UNEN los grupos que comparten alguna cuenta: "A y B se llaman igual,
// B y C comparten buzón" es una sola persona con tres cuentas. El mínimo de
// cuentas que hayan comprado por su lado (`minimoCuentasConCompras`) se exige
// sobre la persona ya unida, no sobre cada grupo suelto — así A (compró) y C
// (compró) quedan juntas aunque B, el puente entre ambas, solo venda. Una cuenta
// duplicada que nunca compró no es una señal; varias COMPRANDO sí. Los
// vendedores que nunca compraron entran al grafo igual (por VENDE), así que
// pueden figurar como miembros con 0 compras.
function consultaGrupos(etiqueta, relacion, campoClave) {
  return `
MATCH (g:${etiqueta})<-[:${relacion}]-(u:Usuario)
WITH g, collect(u) AS cuentas
WHERE size(cuentas) >= $minimoCuentas
UNWIND cuentas AS u
CALL {
  WITH u
  OPTIONAL MATCH (u)-[c:COMPRÓ]->(p:Producto)
  RETURN count(DISTINCT c.compra_id) AS ordenes,
         coalesce(sum(c.monto), 0.0) AS gastado,
         min(c.fecha) AS primeraCompra,
         max(c.fecha) AS ultimaCompra,
         collect(DISTINCT c.categoria) AS categorias,
         collect(DISTINCT p.descripcion)[0..5] AS productos
}
WITH g, collect({id: u.id_usuario, nombre: u.nombre, rol: u.rol, ordenes: ordenes, gastado: gastado,
                 primeraCompra: primeraCompra, ultimaCompra: ultimaCompra, categorias: categorias, productos: productos}) AS miembros
RETURN g.${campoClave} AS clave, miembros
`;
}

const CONSULTA_GRUPOS_NOMBRE = consultaGrupos('Nombre', 'SE_LLAMA', 'clave');
const CONSULTA_GRUPOS_CORREO = consultaGrupos('Correo', 'USA_CORREO', 'hash');

async function buscarGrupos(consulta, tipo, parametros) {
  const registros = await neo4j.leer(consulta, parametros);
  return registros.map((r) => {
    const f = aPlano(r.toObject());
    return { tipo, miembros: f.miembros };
  });
}

// Une (union-find sobre el id de cuenta) los grupos que comparten alguna
// cuenta. Cada resultado conserva TODOS los vínculos que lo forman — qué
// cuentas comparten nombre y cuáles buzón — para poder explicarlos y dibujarlos.
// De un vínculo por buzón NO se devuelve el hash: al panel le basta con saber
// qué cuentas lo comparten (los correos legibles salen de la ficha, desde MySQL).
function unirGrupos(grupos) {
  const padre = new Map();
  const raiz = (id) => {
    let actual = id;
    while (padre.get(actual) !== actual) {
      padre.set(actual, padre.get(padre.get(actual)));
      actual = padre.get(actual);
    }
    return actual;
  };
  for (const g of grupos) for (const m of g.miembros) if (!padre.has(m.id)) padre.set(m.id, m.id);
  for (const g of grupos) {
    const [primero, ...resto] = g.miembros;
    for (const m of resto) padre.set(raiz(m.id), raiz(primero.id));
  }

  const componentes = new Map();
  for (const g of grupos) {
    const r = raiz(g.miembros[0].id);
    if (!componentes.has(r)) componentes.set(r, { vinculos: [], miembros: new Map() });
    const c = componentes.get(r);
    const vinculo = { tipo: g.tipo, ids: g.miembros.map((m) => m.id).sort((x, y) => x - y) };
    if (g.tipo === 'nombre') vinculo.nombre = g.miembros[0].nombre;
    c.vinculos.push(vinculo);
    for (const m of g.miembros) c.miembros.set(m.id, m);
  }

  return [...componentes.values()].map((c) => {
    const miembros = [...c.miembros.values()].sort((a, b) => b.gastado - a.gastado);
    const porNombre = c.vinculos.find((v) => v.tipo === 'nombre');
    return {
      // Clave estable para la UI (un componente = un conjunto fijo de cuentas).
      clave: miembros.map((m) => m.id).sort((a, b) => a - b).join('-'),
      nombre: porNombre ? porNombre.nombre : miembros[0].nombre,
      vinculos: c.vinculos,
      miembros,
      totalOrdenes: miembros.reduce((acc, m) => acc + m.ordenes, 0),
      totalGastado: miembros.reduce((acc, m) => acc + m.gastado, 0),
    };
  });
}

async function buscarCuentasRelacionadas(parametros) {
  const p = conDefectos('relacionadas', parametros);
  const [porNombre, porCorreo] = await Promise.all([
    buscarGrupos(CONSULTA_GRUPOS_NOMBRE, 'nombre', p),
    buscarGrupos(CONSULTA_GRUPOS_CORREO, 'correo', p),
  ]);
  return unirGrupos([...porNombre, ...porCorreo])
    .filter((a) => a.miembros.filter((m) => m.ordenes >= 1).length >= p.minimoCuentasConCompras)
    .sort((a, b) => b.totalGastado - a.totalGastado);
}

// ---------- Señal E: ráfaga de gasto ----------

// Agrupa los pedidos de cada cuenta por día de Guatemala (UTC-6; Guatemala no
// tiene horario de verano, así que restar 6 horas fijas alcanza) y compara cada
// día solo contra los días CON COMPRAS que lo precedieron. Dos reglas, cada una
// relativa al pasado de ESA cuenta para no señalar a quien siempre compra mucho:
//   - muchosPedidos: llega a `minimoPedidos` Y al menos `factorPedidos` × el día
//     con más pedidos que la cuenta había tenido (con historial vacío, basta
//     con llegar). "Cualquier récord" no alcanza: una cuenta que sube de a poco
//     su propio récord (5, 12, 13, 18) quedaría señalada en cada escalón.
//   - muchoGasto: el total del día supera el factor × el gasto diario promedio
//     previo, el máximo diario previo y un monto mínimo, con al menos
//     `minimoDiasPrevios` días de historial y al menos 2 pedidos ese día — un
//     solo pedido grande ya es la señal de gasto anómalo (B), no se cuenta dos
//     veces como si fueran dos evidencias.
// Captura lo que el gasto anómalo (por pedido) no ve: varios pedidos que, uno
// por uno, parecen normales y juntos no lo son. Limitación aceptada: una ráfaga
// que cruza la medianoche se reparte en dos días.
const CONSULTA_RAFAGA_GASTO = `
MATCH (u:Usuario)-[c:COMPRÓ]->(:Producto)
WITH u, c.compra_id AS compraId, min(c.fecha) AS fecha, sum(c.monto) AS total
WITH u, toString(date(fecha - duration({hours: 6}))) AS dia,
     collect({compraId: compraId, fecha: fecha, total: total}) AS ordenes
WITH u, dia, ordenes, size(ordenes) AS pedidos, reduce(s = 0.0, o IN ordenes | s + o.total) AS gastado
ORDER BY dia
WITH u, collect({dia: dia, pedidos: pedidos, gastado: gastado, ordenes: ordenes}) AS dias
UNWIND range(0, size(dias) - 1) AS i
WITH u, dias[i] AS actual, dias[0..i] AS previos
WITH u, actual, size(previos) AS diasPrevios,
     CASE WHEN size(previos) > 0 THEN reduce(s = 0.0, d IN previos | s + d.gastado) / size(previos) ELSE 0.0 END AS promedioGasto,
     reduce(m = 0.0, d IN previos | CASE WHEN d.gastado > m THEN d.gastado ELSE m END) AS maxGasto,
     reduce(m = 0, d IN previos | CASE WHEN d.pedidos > m THEN d.pedidos ELSE m END) AS maxPedidos
WITH u, actual, diasPrevios, promedioGasto, maxGasto, maxPedidos,
     (actual.pedidos >= $minimoPedidos AND actual.pedidos >= $factorPedidos * maxPedidos) AS muchosPedidos,
     (diasPrevios >= $minimoDiasPrevios AND actual.pedidos >= 2 AND actual.gastado >= $montoMinimo
        AND actual.gastado >= $factorGasto * promedioGasto AND actual.gastado > maxGasto) AS muchoGasto
WHERE muchosPedidos OR muchoGasto
RETURN u.id_usuario AS usuarioId, u.nombre AS usuarioNombre, actual.dia AS dia,
       actual.pedidos AS pedidos, actual.gastado AS gastado, actual.ordenes AS ordenes,
       diasPrevios, promedioGasto, maxGasto, maxPedidos, muchosPedidos, muchoGasto
ORDER BY dia DESC
`;

async function buscarRafagaGasto(parametros) {
  const registros = await neo4j.leer(CONSULTA_RAFAGA_GASTO, conDefectos('rafaga', parametros));
  return registros.map((r) => {
    const f = aPlano(r.toObject());
    return {
      usuario: { id: f.usuarioId, nombre: f.usuarioNombre },
      dia: f.dia,
      pedidos: f.pedidos,
      gastado: f.gastado,
      ordenes: f.ordenes.sort((a, b) => (a.fecha < b.fecha ? -1 : 1)),
      diasPrevios: f.diasPrevios,
      promedioGasto: f.promedioGasto,
      maxGasto: f.maxGasto,
      maxPedidos: f.maxPedidos,
      reglas: { muchosPedidos: f.muchosPedidos, muchoGasto: f.muchoGasto },
    };
  });
}

// ---------- Señal F: autocompra ----------

// (comprador)-[:COMPRÓ]->(producto)<-[:VENDE]-(vendedor) donde comprador y
// vendedor son la MISMA cuenta, o dos cuentas de una misma persona (mismo
// nombre completo o mismo buzón de correo) — el patrón de multi-salto más
// directo de mover dinero por el comercio: el "comprador" paga, el "vendedor"
// cobra (menos la comisión de la plataforma) y el dinero queda con apariencia de
// venta legítima. Una fila por par. `mismoNombre`/`mismoBuzon` se calculan solo
// para cuentas DISTINTAS: sobre la misma cuenta la comparación daría falso (un
// patrón no reutiliza la misma relación dos veces) y de todos modos no aporta.
const CONSULTA_AUTOCOMPRA = `
MATCH (comprador:Usuario)-[c:COMPRÓ]->(p:Producto)<-[:VENDE]-(vendedor:Usuario)
WITH comprador, vendedor, c, p,
     comprador.id_usuario = vendedor.id_usuario AS mismaCuenta,
     comprador.id_usuario <> vendedor.id_usuario
       AND EXISTS { (comprador)-[:SE_LLAMA]->(:Nombre)<-[:SE_LLAMA]-(vendedor) } AS mismoNombre,
     comprador.id_usuario <> vendedor.id_usuario
       AND EXISTS { (comprador)-[:USA_CORREO]->(:Correo)<-[:USA_CORREO]-(vendedor) } AS mismoBuzon
WHERE mismaCuenta OR mismoNombre OR mismoBuzon
WITH comprador, vendedor, mismaCuenta, mismoNombre, mismoBuzon,
     count(DISTINCT c.compra_id) AS pedidos, sum(c.monto) AS total,
     min(c.fecha) AS primera, max(c.fecha) AS ultima,
     collect(DISTINCT p.descripcion)[0..5] AS productos
RETURN comprador.id_usuario AS compradorId, comprador.nombre AS compradorNombre,
       vendedor.id_usuario AS vendedorId, vendedor.nombre AS vendedorNombre,
       mismaCuenta, mismoNombre, mismoBuzon, pedidos, total, primera, ultima, productos
ORDER BY total DESC
`;

async function buscarAutocompra() {
  const registros = await neo4j.leer(CONSULTA_AUTOCOMPRA, {});
  return registros.map((r) => {
    const f = aPlano(r.toObject());
    return {
      comprador: { id: f.compradorId, nombre: f.compradorNombre },
      vendedor: { id: f.vendedorId, nombre: f.vendedorNombre },
      mismaCuenta: f.mismaCuenta,
      mismoNombre: f.mismoNombre,
      mismoBuzon: f.mismoBuzon,
      pedidos: f.pedidos,
      total: f.total,
      primera: f.primera,
      ultima: f.ultima,
      productos: f.productos,
    };
  });
}

// ---------- Señal G: reventa de lo comprado ----------

// Un vendedor (una cuenta que PUEDE vender) le compra un producto a OTRO vendedor
// y tiene publicado un producto del mismo artículo — la misma clave canónica de
// descripción (fraudeSyncService.claveArticulo):
//   (vendedor)-[:COMPRÓ]->(original)<-[:VENDE]-(otro vendedor)
//   (original)-[:ES_ARTICULO]->(artículo)<-[:ES_ARTICULO]-(publicación)<-[:VENDE]-(vendedor)
// Seis saltos que ninguna tabla relacional contesta con un solo JOIN, y el tipo
// de patrón que un grafo resuelve de forma natural. Es la regla "no revender lo
// que compraste", que el aviso de compra les hace aceptar a estas cuentas
// (compromisoService.js).
//
// Una fila por (vendedor, publicación) con TODOS los originales equivalentes que
// compró: comprarle el mismo artículo a dos vendedores sigue siendo una sola
// publicación bajo sospecha, no dos. La consulta NO mira si la publicación está
// activa ni cuándo se publicó: el grafo no guarda el estado de los productos, y
// una copia atrasada diría que algo "se vende hoy" cuando ya se pausó — eso lo
// resuelve enriquecerReventa() EN VIVO contra el catálogo.
const CONSULTA_REVENTA = `
MATCH (s:Usuario)-[c:COMPRÓ]->(p:Producto)<-[:VENDE]-(v:Usuario)
WHERE v.id_usuario <> s.id_usuario
MATCH (p)-[:ES_ARTICULO]->(a:Articulo)<-[:ES_ARTICULO]-(q:Producto)<-[:VENDE]-(s)
WITH s, q, p, v,
     count(DISTINCT c.compra_id) AS pedidos,
     min(c.fecha) AS primera, max(c.fecha) AS ultima,
     collect(DISTINCT c.detalle_id) AS detalles,
     collect(DISTINCT c.compra_id) AS compras
WITH s, q,
     collect({productoId: p.producto_id, descripcion: p.descripcion, vendedorId: v.id_usuario, vendedorNombre: v.nombre,
              pedidos: pedidos, primera: primera, ultima: ultima, detalles: detalles, compras: compras}) AS originales
RETURN s.id_usuario AS vendedorId, s.nombre AS vendedorNombre,
       q.producto_id AS publicacionId, q.descripcion AS publicacionDescripcion,
       originales
ORDER BY vendedorId, publicacionId
`;

async function buscarReventa() {
  const registros = await neo4j.leer(CONSULTA_REVENTA, {});
  return registros.map((r) => {
    const f = aPlano(r.toObject());
    return {
      vendedor: { id: f.vendedorId, nombre: f.vendedorNombre },
      publicacion: { id: f.publicacionId, descripcion: f.publicacionDescripcion },
      originales: f.originales.map((o) => ({
        producto: { id: o.productoId, descripcion: o.descripcion },
        vendedor: { id: o.vendedorId, nombre: o.vendedorNombre },
        pedidos: o.pedidos,
        primera: o.primera,
        ultima: o.ultima,
        detalles: o.detalles,
        compras: o.compras,
      })),
    };
  });
}

// Lo que el grafo no sabe, resuelto EN VIVO (Mongo + MySQL), y el filtro que
// convierte "tiene una publicación equivalente" en "HOY lo está vendiendo":
//   - estado actual de la publicación (Mongo): solo cuenta una ACTIVA. Pausarla
//     hace desaparecer el hallazgo, que es exactamente lo que debe pasar.
//   - cuándo se publicó (el evento de creación del historial, ProductoEvento) —
//     la fecha cierra el círculo: publicar DESPUÉS de comprar es el patrón.
//   - atributos de ambos productos: que coincidan (Talla, Color…) dice que no es
//     solo un título parecido.
//   - unidades y precio pagado de cada compra, y si ese pedido lleva la
//     constancia del compromiso de no reventa (MySQL): lo que vuelve exigible la
//     cláusula de los Términos de Servicio.
async function enriquecerReventa(brutos) {
  if (brutos.length === 0) return [];
  await conectarMongo();

  const idsPublicaciones = [...new Set(brutos.map((b) => b.publicacion.id))];
  const idsOriginales = [...new Set(brutos.flatMap((b) => b.originales.map((o) => o.producto.id)))];
  const idsDetalles = [...new Set(brutos.flatMap((b) => b.originales.flatMap((o) => o.detalles)))];
  const idsCompras = [...new Set(brutos.flatMap((b) => b.originales.flatMap((o) => o.compras)))];

  const [docs, creaciones, detalles, compras] = await Promise.all([
    Producto.find({ producto_id: { $in: [...idsPublicaciones, ...idsOriginales] } }).select('producto_id estado atributos inventario').lean(),
    ProductoEvento.find({ producto_id: { $in: idsPublicaciones }, tipo: 'creacion' }).select('producto_id fecha').lean(),
    prisma.compra_detalle.findMany({ where: { id: { in: idsDetalles } }, select: { id: true, cantidad: true, precio_final: true } }),
    prisma.compra.findMany({ where: { id: { in: idsCompras } }, select: { id: true, fecha: true, no_reventa_aceptada_en: true } }),
  ]);
  const docPorId = new Map(docs.map((d) => [d.producto_id, d]));
  const creadaEn = new Map(creaciones.map((e) => [e.producto_id, e.fecha]));
  const detallePorId = new Map(detalles.map((d) => [d.id, d]));
  const compraPorId = new Map(compras.map((c) => [c.id, c]));

  // Atributos iguales = el mismo conjunto de nombre=valor, normalizado, y no
  // vacío (dos productos SIN atributos no "coinciden" en nada).
  const firma = (atributos) => new Set((atributos ?? []).map((a) => `${normalizarNombre(a.nombre)}=${normalizarNombre(a.valor)}`));
  const iguales = (a, b) => a.size > 0 && a.size === b.size && [...a].every((x) => b.has(x));

  const resultado = [];
  for (const b of brutos) {
    const doc = docPorId.get(b.publicacion.id);
    if (doc?.estado !== 'activo') continue;

    const originales = b.originales
      .map((o) => {
        const lineas = o.detalles.map((id) => detallePorId.get(id)).filter(Boolean);
        const unidades = lineas.reduce((n, l) => n + l.cantidad, 0);
        const pagado = lineas.reduce((n, l) => n + Number(l.precio_final), 0);
        const original = docPorId.get(o.producto.id);
        return {
          producto: { ...o.producto, precioActual: original?.inventario?.precio ?? null, atributos: original?.atributos ?? [] },
          vendedor: o.vendedor,
          unidades,
          precioUnitario: unidades > 0 ? pagado / unidades : null,
          primera: o.primera,
          ultima: o.ultima,
          pedidos: o.compras
            .map((id) => ({ compraId: id, fecha: compraPorId.get(id)?.fecha ?? null, aceptoCompromisoEn: compraPorId.get(id)?.no_reventa_aceptada_en ?? null }))
            .sort((x, y) => x.compraId - y.compraId),
        };
      })
      .sort((x, y) => new Date(x.primera) - new Date(y.primera));

    const primeraCompra = originales[0].primera;
    const publicadaEn = creadaEn.get(b.publicacion.id) ?? null;
    const pedidos = originales.flatMap((o) => o.pedidos);
    const aceptaciones = pedidos.map((p) => p.aceptoCompromisoEn).filter(Boolean).sort((x, y) => new Date(x) - new Date(y));
    const precioPublicado = doc.inventario?.precio ?? null;
    const precioPagado = originales[0].precioUnitario;

    resultado.push({
      vendedor: b.vendedor,
      publicacion: {
        ...b.publicacion,
        estado: doc.estado,
        precio: precioPublicado,
        cantidad: doc.inventario?.cantidad ?? 0,
        creadaEn: publicadaEn,
        atributos: doc.atributos ?? [],
      },
      originales,
      primeraCompra,
      listadaDespues: publicadaEn !== null && new Date(publicadaEn) > new Date(primeraCompra),
      mismosAtributos: originales.some((o) => iguales(firma(o.producto.atributos), firma(doc.atributos))),
      // Cuánto más (o menos) cobra por unidad que lo que él pagó — informativo, no
      // decide el nivel: revender con pérdida también es revender.
      variacionPrecio: precioPagado > 0 && precioPublicado !== null ? precioPublicado / precioPagado - 1 : null,
      compromiso: { pedidos: pedidos.length, aceptados: aceptaciones.length, primeraAceptacion: aceptaciones[0] ?? null },
    });
  }
  return resultado;
}

// ---------- Enriquecimiento (MySQL + Mongo, en vivo) ----------

const UN_DIA_MS = 86400000;
// Bajo este umbral, la antigüedad de la cuenta se menciona en el motivo como
// refuerzo de la señal — una cuenta de un día que ya dispara un patrón pesa
// distinto que una con meses de historial. Ajustable, no una regla dura.
const DIAS_CUENTA_RECIENTE = 30;

// Ficha por usuario — todo lo que un administrador necesita para decidir si
// vale la pena investigar, no solo el nombre. Neo4j guarda a propósito solo
// {id_usuario, nombre, rol} (ver fraudeSyncService.js) — el resto se resuelve
// acá, en vivo, contra MySQL (fuente de identidad) y Mongo (reseñas), nunca
// cacheado en el grafo. Se pide en lote (un solo roundtrip por base para todos
// los ids de una respuesta), no una consulta por fila.
//
// `nacimientos` (fecha de nacimiento por cuenta) se devuelve APARTE de las
// fichas a propósito: sirve para corroborar que dos cuentas con el mismo
// nombre son la misma persona, pero la fecha en sí nunca viaja al navegador.
async function enriquecerUsuarios(ids) {
  if (ids.length === 0) return { fichas: new Map(), nacimientos: new Map() };

  const [usuarios, comprasPorUsuario] = await Promise.all([
    prisma.usuarios.findMany({ where: { id_usuario: { in: ids } }, include: { rol: true } }),
    prisma.compra.groupBy({
      by: ['id_usuario'],
      where: { id_usuario: { in: ids } },
      _count: { id: true },
      _sum: { total: true },
    }),
  ]);

  await conectarMongo();
  const resenasPorUsuario = await Resena.aggregate([
    { $match: { usuario_id: { $in: ids } } },
    { $group: { _id: '$usuario_id', cantidad: { $sum: 1 } } },
  ]);

  const comprasMap = new Map(comprasPorUsuario.map((c) => [c.id_usuario, c]));
  const resenasMap = new Map(resenasPorUsuario.map((r) => [r._id, r.cantidad]));
  const ahora = Date.now();

  const fichas = new Map();
  const nacimientos = new Map();
  for (const u of usuarios) {
    const compras = comprasMap.get(u.id_usuario);
    const diasDesdeCreacion = Math.max(0, Math.floor((ahora - u.creado_en.getTime()) / UN_DIA_MS));
    const totalCompras = compras?._count.id ?? 0;
    const totalGastado = Number(compras?._sum.total ?? 0);
    nacimientos.set(u.id_usuario, u.fecha_nacimiento.toISOString().slice(0, 10));
    fichas.set(u.id_usuario, {
      id: u.id_usuario,
      nombre: `${u.nombres} ${u.apellidos}`,
      correo: u.correo,
      rol: u.rol.tipo_rol,
      // Cuentas de antes de agregar este campo (2026-09-18) muestran la
      // fecha de esa migración, no su alta real — no se guardó antes. Solo
      // es confiable para cuentas creadas de acá en adelante.
      creadoEn: u.creado_en.toISOString(),
      diasDesdeCreacion,
      cuentaReciente: diasDesdeCreacion <= DIAS_CUENTA_RECIENTE,
      totalCompras,
      totalGastado,
      promedioCompra: totalCompras > 0 ? totalGastado / totalCompras : 0,
      totalResenas: resenasMap.get(u.id_usuario) ?? 0,
    });
  }
  return { fichas, nacimientos };
}

async function resolverCatalogo(subcategoriaIds, categoriaIds) {
  if (subcategoriaIds.length === 0 && categoriaIds.length === 0) return { subcategorias: new Map(), categorias: new Map() };
  await conectarMongo();
  const [subs, cats] = await Promise.all([
    Subcategoria.find({ _id: { $in: subcategoriaIds } }).select('subcategoria').lean(),
    Categoria.find({ _id: { $in: categoriaIds } }).select('categoria').lean(),
  ]);
  return {
    subcategorias: new Map(subs.map((s) => [String(s._id), s.subcategoria])),
    categorias: new Map(cats.map((c) => [String(c._id), c.categoria])),
  };
}

// ---------- Texto del motivo ----------

const formatoQ = (n) => `Q${Number(n).toLocaleString('es-GT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const formatoFecha = (f) => (f ? new Date(f).toLocaleDateString('es-GT', { dateStyle: 'medium' }) : 'fecha desconocida');
const formatoDia = (dia) => new Date(`${dia}T12:00:00Z`).toLocaleDateString('es-GT', { dateStyle: 'medium', timeZone: 'UTC' });

function diasATexto(dias) {
  if (dias < 1) return 'menos de un día';
  if (dias === 1) return '1 día';
  return `${dias} días`;
}

const pluralCompras = (n) => `${n} compra${n === 1 ? '' : 's'}`;
const pluralPedidos = (n) => `${n} pedido${n === 1 ? '' : 's'}`;
// vecesPromedio es null si el promedio previo fue 0 (no se puede dividir).
const textoVeces = (g) => (g.vecesPromedio === null ? 'muchas veces' : `${g.vecesPromedio.toFixed(1)} veces`);

// El motivo se arma acá, junto a la consulta que produce los datos que cita
// — si la lógica de la consulta cambia, el texto que la explica cambia en el
// mismo archivo, no en uno aparte que se puede desalinear.
function construirMotivoResenas({ usuario1, usuario2, productosCompartidos, productos, promedio1, promedio2 }, { ventanaSegundos, calificacionMinima }, ficha1, ficha2) {
  const minutos = Math.max(1, Math.round(ventanaSegundos / 60));
  const frases = [
    `${usuario1.nombre} y ${usuario2.nombre} reseñaron los mismos ${productosCompartidos} productos (${productos.join(', ')}), con calificación promedio de ${promedio1.toFixed(1)} y ${promedio2.toFixed(1)} estrellas respectivamente (mínimo exigido: ${calificacionMinima}), y cada par de reseñas de este grupo quedó separado por menos de ${minutos} minutos.`,
    'Mismos productos, calificación alta y tiempos tan cercanos es el patrón que suele dejar una cuenta reseñándose a sí misma con un segundo perfil (por ejemplo, un vendedor impulsando su propia calificación) — no dos compradores que coinciden por casualidad.',
  ];
  const recientes = [ficha1, ficha2].filter((f) => f?.cuentaReciente);
  if (recientes.length === 2) {
    frases.push(`Las dos cuentas son recientes — creadas hace ${diasATexto(ficha1.diasDesdeCreacion)} y ${diasATexto(ficha2.diasDesdeCreacion)} — lo que refuerza la señal.`);
  } else if (recientes.length === 1) {
    frases.push(`La cuenta de ${recientes[0].nombre} se creó hace ${diasATexto(recientes[0].diasDesdeCreacion)}, lo que refuerza la señal.`);
  }
  return frases.join(' ');
}

// Cierre común de las señales con nivel de confianza: nunca baja el nivel, solo
// lo explica.
function cierreConfianza(corroboradores) {
  if (corroboradores.length > 0) {
    return `${corroboradores.map((c) => `Además, ${c.detalle}.`).join(' ')} Otra señal independiente corrobora este hallazgo, así que se marca con confianza alta: la postura por defecto ante esta evidencia es tratarla como sospechosa hasta que una revisión humana confirme lo contrario, no al revés.`;
  }
  return 'Ninguna otra señal corrobora este hallazgo, así que por sí solo es más débil: conviene revisar el historial completo de la cuenta antes de actuar, no tratarlo como confirmado.';
}

function notaCuentaReciente(ficha, nombre) {
  return ficha?.cuentaReciente ? [`La cuenta de ${nombre} se creó hace ${diasATexto(ficha.diasDesdeCreacion)}, lo que refuerza la señal.`] : [];
}

function construirMotivoGasto(g, ficha, corroboradores) {
  const productos = g.lineas.map((l) => `"${l.descripcion}"`).join(', ');
  return [
    `${g.usuario.nombre} hizo una compra de ${formatoQ(g.total)} el ${formatoFecha(g.fecha)} (${productos}): ${textoVeces(g)} su compra promedio de ${formatoQ(g.promedio)} y por encima de la más alta que había hecho hasta entonces (${formatoQ(g.maximo)}), medido sobre sus ${g.ordenesPrevias} compras anteriores.`,
    'Es la lógica con que un banco vigila el gasto de un cliente: cada movimiento se compara contra el patrón histórico de esa misma persona, no contra un promedio general. Un salto así puede ser legítimo (un regalo, una compra planeada), pero también es lo que deja una cuenta tomada por un tercero o usada para mover dinero en montos que no corresponden a su historial.',
    cierreConfianza(corroboradores),
    ...notaCuentaReciente(ficha, g.usuario.nombre),
  ].join(' ');
}

function construirMotivoCategoria(c, ficha, corroboradores) {
  const productos = c.productos.map((p) => `"${p.descripcion}"`).join(', ');
  const habituales = c.habituales.map((h) => `${h.categoria} (${pluralCompras(h.ordenes)}, ${h.porcentaje}%)`).join(', ');
  return [
    `${c.usuario.nombre} compró ${productos} el ${formatoFecha(c.fecha)} — su primera compra registrada en la categoría "${c.categoria}". Hasta ese momento acumulaba ${pluralCompras(c.ordenesPrevias)} a lo largo de ${diasATexto(c.diasHistorial)}, siempre en: ${habituales}.`,
    'Comprar por primera vez fuera del patrón habitual no es sospechoso por sí solo — los intereses cambian —, pero después de un historial largo y consistente es lo que suele dejar una cuenta tomada por un tercero: se compra lo que le interesa a quien la tomó (a menudo algo fácil de revender), no lo que acostumbraba comprar su titular.',
    cierreConfianza(corroboradores),
    ...notaCuentaReciente(ficha, c.usuario.nombre),
  ].join(' ');
}

function construirMotivoRafaga(r, ficha, corroboradores, p) {
  const frases = [`${r.usuario.nombre} hizo ${pluralPedidos(r.pedidos)} el ${formatoDia(r.dia)} por un total de ${formatoQ(r.gastado)}.`];
  if (r.reglas.muchosPedidos) {
    frases.push(
      r.maxPedidos === 0
        ? `Es un volumen de pedidos que una cuenta sin historial previo no suele tener en un solo día (el mínimo para señalarlo es ${p.minimoPedidos}).`
        : `Es al menos ${p.factorPedidos} veces su día más activo hasta entonces (${pluralPedidos(r.maxPedidos)}) y no menos de ${p.minimoPedidos} pedidos.`
    );
  }
  if (r.reglas.muchoGasto) {
    const veces = r.promedioGasto > 0 ? `${(r.gastado / r.promedioGasto).toFixed(1)} veces` : 'muchas veces';
    frases.push(`Gastó ${veces} lo que gasta en un día de compras normal (${formatoQ(r.promedioGasto)}, sobre ${r.diasPrevios} días con compras) y más que en cualquier día anterior (${formatoQ(r.maxGasto)}).`);
  }
  frases.push(
    'Es la misma idea que el gasto anómalo, pero medida sobre el día completo: una cuenta puede repartir un gasto fuera de lo normal en varios pedidos que, mirados uno por uno, parecen normales — la forma típica de probar un medio de pago o de fraccionar un movimiento para que ninguna pieza llame la atención. Puede ser legítimo (un día de ofertas, una compra grande en partes), pero también es lo que deja una cuenta tomada o un movimiento de dinero fragmentado.',
    cierreConfianza(corroboradores),
    ...notaCuentaReciente(ficha, r.usuario.nombre)
  );
  return frases.join(' ');
}

// Cómo se relacionan comprador y vendedor, en el mismo orden de fuerza que usa
// el nivel de confianza: buzón (deliberado) > nombre (puede ser un homónimo).
function textoVinculoAutocompra(f) {
  const partes = [];
  if (f.mismoBuzon) partes.push('usa el mismo buzón de correo');
  if (f.mismoNombre) partes.push('se llama exactamente igual');
  return partes.join(' y ');
}

function construirMotivoAutocompra(f, corroboradores) {
  const productos = f.productos.map((p) => `"${p}"`).join(', ');
  const base = f.mismaCuenta
    ? `${f.comprador.nombre} (cuenta #${f.comprador.id}) compró ${pluralPedidos(f.pedidos)} por ${formatoQ(f.total)} de sus propios productos (${productos}).`
    : `${f.comprador.nombre} (cuenta #${f.comprador.id}) compró ${pluralPedidos(f.pedidos)} por ${formatoQ(f.total)} de productos que vende ${f.vendedor.nombre} (cuenta #${f.vendedor.id}), otra cuenta que ${textoVinculoAutocompra(f)} (${productos}).`;
  const explicacion = f.mismaCuenta
    ? 'Comprarse los propios productos infla las ventas y la apariencia de popularidad del vendedor sin que haya un cliente real, y puede mover dinero por el comercio. También puede ser algo inocente — probar el propio flujo de compra —, por eso solo sube a confianza alta si otra señal lo corrobora.'
    : `Que una misma persona le compre a su otra cuenta es la forma más directa de mover dinero por el comercio: el "comprador" paga, el "vendedor" cobra (menos la comisión de la plataforma) y el dinero queda con apariencia de una venta legítima — lavado de dinero —, además de inflar las ventas y la reputación del vendedor. ${
        f.mismoBuzon
          ? 'Compartir buzón de correo no es algo que ocurra por casualidad: como el correo exacto no puede repetirse entre cuentas, es una decisión deliberada de quien maneja las dos.'
          : 'Que un comprador le compre a un vendedor que se llama exactamente igual no es algo que ocurra por casualidad.'
      } Por eso se marca con confianza alta.`;
  return [base, explicacion, ...(corroboradores.length ? [cierreConfianza(corroboradores)] : [])].join(' ');
}

// Una frase por vínculo que forma el grupo — "las cuentas #3, #7 se llaman
// exactamente igual", "las cuentas #7, #9 usan el mismo buzón de correo".
// Los correos legibles salen de la ficha (MySQL), no del grafo.
function describirVinculo(v, miembrosPorId) {
  const cuentas = `las cuentas ${v.ids.map((id) => `#${id}`).join(', ')}`;
  if (v.tipo === 'nombre') return `${cuentas} se llaman exactamente igual ("${v.nombre}", después de normalizar mayúsculas, tildes y espacios)`;
  const correos = v.ids.map((id) => miembrosPorId.get(id)?.ficha?.correo).filter(Boolean);
  return `${cuentas} usan el mismo buzón de correo${correos.length ? ` (${correos.join(', ')})` : ''}`;
}

function construirMotivoRelacionadas(a, corroboradores) {
  const miembrosPorId = new Map(a.miembros.map((m) => [m.id, m]));
  const porBuzon = a.vinculos.some((v) => v.tipo === 'correo');
  const porNombre = a.vinculos.some((v) => v.tipo === 'nombre');
  const resumenMiembros = a.miembros
    .filter((m) => m.ordenes > 0)
    .map((m) => `cuenta #${m.id} (${pluralCompras(m.ordenes)}, ${formatoQ(m.gastado)}${m.categorias.length ? `, en ${m.categorias.join(' y ')}` : ''})`)
    .join('; ');
  const vinculos = a.vinculos.map((v) => describirVinculo(v, miembrosPorId)).join('; ');
  const frases = [
    `${a.miembros.length} cuentas parecen ser de una misma persona: ${vinculos}. Cada una compró por su lado: ${resumenMiembros}. Entre todas movieron ${formatoQ(a.totalGastado)} en ${pluralCompras(a.totalOrdenes)}.`,
    'Una persona con varias cuentas compradoras puede estar fraccionando el dinero entre identidades para que ninguna llame la atención, o pasándolo por compras para darle apariencia de comercio legítimo y cobrar una comisión por el movimiento (lavado de dinero).',
  ];
  if (porBuzon) {
    frases.push(
      `Compartir buzón de correo es evidencia fuerte por sí sola: como el correo exacto no puede repetirse entre cuentas, usar la misma bandeja (con un alias "+", o los puntos de Gmail) es una decisión deliberada, y es lo único que delata a quien cambia el nombre en cada cuenta${porNombre ? ' — acá, además, el nombre coincide' : ''}. Por eso se marca con confianza alta.`
    );
    if (corroboradores.length > 0) frases.push(`${corroboradores.map((c) => `Además, ${c.detalle}.`).join(' ')}`);
  } else {
    frases.push('Pero dos personas distintas también pueden llamarse igual, así que el nombre por sí solo es una coincidencia a verificar, no una prueba.', cierreConfianza(corroboradores));
  }
  return frases.join(' ');
}

const pluralUnidades = (n) => `${n} unidad${n === 1 ? '' : 'es'}`;

function construirMotivoReventa(h, corroboradores) {
  const compras = h.originales
    .map((o) => `"${o.producto.descripcion}" a ${o.vendedor.nombre} (cuenta #${o.vendedor.id}) el ${formatoFecha(o.primera)}, ${pluralUnidades(o.unidades)}${o.precioUnitario !== null ? ` a ${formatoQ(o.precioUnitario)} c/u` : ''}`)
    .join('; y ');
  const p = h.publicacion;
  const frases = [
    `${h.vendedor.nombre} (cuenta #${h.vendedor.id}) compró ${compras}, y hoy tiene publicado y activo un producto equivalente: "${p.descripcion}" (producto #${p.id}${p.precio !== null ? `, ${formatoQ(p.precio)}` : ''}, ${p.cantidad} en stock${p.creadaEn ? `, publicado el ${formatoFecha(p.creadaEn)}` : ''}).`,
  ];
  if (h.variacionPrecio !== null) {
    const porcentaje = Math.round(Math.abs(h.variacionPrecio) * 100);
    frases.push(
      porcentaje === 0
        ? 'Lo publica al mismo precio que pagó por unidad.'
        : `Lo publica ${porcentaje}% ${h.variacionPrecio > 0 ? 'por encima de' : 'por debajo de'} lo que pagó por unidad.`
    );
  }
  frases.push(
    'Una cuenta que puede vender no debe revender lo que le compra a otro vendedor: es lo que aprovecha el comercio de otros sin producir nada y deja al vendedor original fuera de su propia venta. Incumple los Términos de Servicio de TiendaYa.',
    h.compromiso.aceptados > 0
      ? `En ${pluralPedidos(h.compromiso.aceptados)} de esas compras aceptó expresamente el compromiso de no reventa (el primero, el ${formatoFecha(h.compromiso.primeraAceptacion)}): no es solo una sospecha, es un compromiso que dejó asentado.`
      : 'Esas compras no llevan constancia de un compromiso de no reventa (son anteriores a que se pidiera): la sospecha se apoya en la coincidencia, no en un compromiso roto.',
    'La coincidencia es de TÍTULO (mismas palabras significativas, sin importar el orden ni los artículos): no prueba que sea la misma pieza — puede ser un competidor legítimo que vende algo parecido.',
    cierreConfianza(corroboradores)
  );
  return frases.join(' ');
}

// ---------- Orquestación ----------

// Corre las siete señales juntas para el panel — cada una es independiente, que
// una falle no debe tirar abajo a las otras (mismo criterio que
// ventasService.js con `advertencias` en vez de un error total). Después las
// cruza: una señal corroborada por otra, independiente, sube a confianza alta.
//
// Qué corrobora a qué:
//   - B, C y E (conducta de una cuenta): la misma COMPRA en B y C, o el mismo
//     DÍA en E con B/C (dos eventos sueltos de meses distintos no se refuerzan
//     entre sí); y cualquier momento de la cuenta si además está en D, F o A —
//     señales de IDENTIDAD o coordinación, no de un evento puntual.
//   - D (cuentas de una misma persona): un vínculo por BUZÓN compartido ya es
//     evidencia fuerte por sí solo — como `usuarios.correo` es único, usar la
//     misma bandeja es una decisión deliberada — y parte en "alta". Un grupo que
//     solo comparte NOMBRE parte en "posible" (dos personas distintas pueden
//     llamarse igual) y sube con: misma fecha de nacimiento, una autocompra entre
//     sus miembros, reseñas coordinadas entre ellos, o conducta anómala (B/C/E)
//     en cualquiera de ellos. Compartir buzón además del nombre es lo que lo
//     convierte en "alta": el correo corrobora al nombre.
//   - F entre cuentas distintas de una misma persona (nombre o buzón) ya parte en
//     "alta"; F de una cuenta consigo misma parte en "posible" (puede ser el
//     vendedor probando su flujo).
//   - G (reventa) parte en "posible" — la coincidencia es de título, y un
//     competidor legítimo puede vender algo parecido a lo que compró para
//     compararlo — y sube con: haber publicado DESPUÉS de comprar (la secuencia de
//     una reventa), atributos idénticos, otra reventa de la misma cuenta, o que la
//     cuenta aparezca en D, F, A o con conducta anómala (B/C/E). A la inversa,
//     que una cuenta revenda corrobora esas señales (comprar mucho de golpe para
//     revender es justo una ráfaga de gasto).
async function consultarFraude(parametros = {}) {
  const advertencias = [];
  const aislar = (nombre, promesa) =>
    promesa.catch((err) => {
      advertencias.push(`No se pudo evaluar ${nombre}: ${err.message}`);
      return [];
    });

  const [resenas, relacionadas, gastos, categorias, rafagas, autocompras, reventasBrutas] = await Promise.all([
    aislar('reseñas coordinadas', buscarResenasCoordinadas(parametros.resenas)),
    aislar('cuentas de una misma persona', buscarCuentasRelacionadas(parametros.relacionadas)),
    aislar('gasto anómalo', buscarGastoAnomalo(parametros.gasto)),
    aislar('categoría inusual', buscarCategoriaInusual(parametros.categoria)),
    aislar('ráfagas de gasto', buscarRafagaGasto(parametros.rafaga)),
    aislar('autocompras', buscarAutocompra()),
    aislar('reventa de lo comprado', buscarReventa()),
  ]);
  // Las publicaciones activas se resuelven ANTES de armar el resto: que una
  // cuenta esté revendiendo es también un corroborador de sus otras señales.
  const reventas = await enriquecerReventa(reventasBrutas).catch((err) => {
    advertencias.push(`No se pudo resolver el estado de las publicaciones en reventa: ${err.message}`);
    return [];
  });

  const idsUsuarios = [
    ...new Set([
      ...resenas.flatMap((r) => [r.usuario1.id, r.usuario2.id]),
      ...relacionadas.flatMap((a) => a.miembros.map((m) => m.id)),
      ...gastos.map((g) => g.usuario.id),
      ...categorias.map((c) => c.usuario.id),
      ...rafagas.map((r) => r.usuario.id),
      ...autocompras.flatMap((f) => [f.comprador.id, f.vendedor.id]),
      ...reventas.flatMap((r) => [r.vendedor.id, ...r.originales.map((o) => o.vendedor.id)]),
    ]),
  ];
  const idsCategorias = [
    ...new Set([
      ...categorias.flatMap((c) => [c.categoriaId, ...c.habituales.map((h) => h.categoria)]),
      ...gastos.flatMap((g) => g.lineas.map((l) => l.categoria)),
      ...relacionadas.flatMap((a) => a.miembros.flatMap((m) => m.categorias)),
    ]),
  ].filter(Boolean);
  const idsSubcategorias = [...new Set(categorias.flatMap((c) => c.productos.map((p) => p.subcategoria)))].filter(Boolean);

  // Enriquecimiento independiente: que falle el catálogo no debe dejar sin
  // fichas a los hallazgos, ni al revés — los hallazgos se muestran igual.
  const [{ fichas, nacimientos }, catalogo] = await Promise.all([
    enriquecerUsuarios(idsUsuarios).catch((err) => {
      advertencias.push(`No se pudieron cargar las fichas de usuario: ${err.message}`);
      return { fichas: new Map(), nacimientos: new Map() };
    }),
    resolverCatalogo(idsSubcategorias, idsCategorias).catch((err) => {
      advertencias.push(`No se pudieron cargar los nombres del catálogo: ${err.message}`);
      return { subcategorias: new Map(), categorias: new Map() };
    }),
  ]);
  const nombreCategoria = (id) => catalogo.categorias.get(id) ?? 'categoría desconocida';

  // ----- Índices de cruce entre señales -----
  const agruparPor = (lista, claves) => {
    const mapa = new Map();
    for (const item of lista) {
      for (const clave of new Set(claves(item))) {
        if (!mapa.has(clave)) mapa.set(clave, []);
        mapa.get(clave).push(item);
      }
    }
    return mapa;
  };
  const resenasDe = agruparPor(resenas, (r) => [r.usuario1.id, r.usuario2.id]);
  const relacionadaDe = agruparPor(relacionadas, (a) => a.miembros.map((m) => m.id));
  const autocompraDe = agruparPor(autocompras, (f) => [f.comprador.id, f.vendedor.id]);
  const reventaDe = agruparPor(reventas, (r) => [r.vendedor.id]);
  const gastoDe = agruparPor(gastos, (g) => [g.usuario.id]);
  const categoriaDe = agruparPor(categorias, (c) => [c.usuario.id]);
  const rafagaDe = agruparPor(rafagas, (r) => [r.usuario.id]);
  const gastoPorCompra = agruparPor(gastos, (g) => [g.compraId]);
  const categoriaPorCompra = agruparPor(categorias, (c) => [c.compraId]);
  const gastoPorDia = agruparPor(gastos, (g) => [`${g.usuario.id}|${fechaGuatemala(g.fecha)}`]);
  const categoriaPorDia = agruparPor(categorias, (c) => [`${c.usuario.id}|${fechaGuatemala(c.fecha)}`]);
  const rafagaPorDia = agruparPor(rafagas, (r) => [`${r.usuario.id}|${r.dia}`]);

  const nombresPorId = new Map();
  for (const lista of [gastos, categorias, rafagas]) for (const x of lista) nombresPorId.set(x.usuario.id, x.usuario.nombre);
  for (const a of relacionadas) for (const m of a.miembros) nombresPorId.set(m.id, m.nombre);
  for (const f of autocompras) {
    nombresPorId.set(f.comprador.id, f.comprador.nombre);
    nombresPorId.set(f.vendedor.id, f.vendedor.nombre);
  }
  for (const r of resenas) {
    nombresPorId.set(r.usuario1.id, r.usuario1.nombre);
    nombresPorId.set(r.usuario2.id, r.usuario2.nombre);
  }
  for (const r of reventas) {
    nombresPorId.set(r.vendedor.id, r.vendedor.nombre);
    for (const o of r.originales) nombresPorId.set(o.vendedor.id, o.vendedor.nombre);
  }
  const quien = (id) => fichas.get(id)?.nombre ?? nombresPorId.get(id) ?? `la cuenta #${id}`;

  // Señales de IDENTIDAD/coordinación de una cuenta (D, F, A) y de conducta
  // sostenida (G) — corroboran cualquier momento de la cuenta.
  function corroboradoresDeIdentidad(usuarioId, { sinAutocompra = false, sinReventa = false } = {}) {
    const lista = [];
    // Una entrada por vínculo de ESTA cuenta (nombre y/o buzón): el que sea
    // por buzón pesa más, y el motivo lo dice.
    const persona = relacionadaDe.get(usuarioId)?.[0];
    for (const v of persona?.vinculos.filter((x) => x.ids.includes(usuarioId)) ?? []) {
      const otras = v.ids.filter((id) => id !== usuarioId).map((id) => `#${id}`);
      const cuentas = `${otras.length === 1 ? 'la cuenta' : 'las cuentas'} ${otras.join(', ')}`;
      lista.push({
        tipo: 'cuentasRelacionadas',
        detalle: `esta cuenta ${v.tipo === 'correo' ? 'usa el mismo buzón de correo que' : 'comparte nombre completo con'} ${cuentas} (ver "Cuentas de una misma persona")`,
      });
    }
    if (!sinAutocompra && autocompraDe.has(usuarioId)) {
      lista.push({ tipo: 'autocompra', detalle: 'esta cuenta aparece en una autocompra, comprando o vendiendo (ver "Autocompra")' });
    }
    if (resenasDe.has(usuarioId)) {
      lista.push({ tipo: 'resenasCoordinadas', detalle: 'esta cuenta también aparece coordinando reseñas (ver "Reseñas coordinadas")' });
    }
    if (!sinReventa && reventaDe.has(usuarioId)) {
      lista.push({ tipo: 'reventa', detalle: 'esta cuenta aparece vendiendo un producto que le compró a otro vendedor (ver "Reventa de lo comprado")' });
    }
    return lista;
  }

  // Conducta anómala de una cuenta (B, C, E), en cualquier momento — la usan
  // las señales de identidad (D, F) como corroborador.
  function corroboradoresDeConducta(usuarioId) {
    const lista = [];
    const nombre = quien(usuarioId);
    if (gastoDe.has(usuarioId)) lista.push({ tipo: 'gastoAnomalo', usuarioId, detalle: `${nombre} tiene una compra con gasto anómalo respecto a su propio historial` });
    if (rafagaDe.has(usuarioId)) lista.push({ tipo: 'rafagaGasto', usuarioId, detalle: `${nombre} tuvo una ráfaga de gasto en un solo día` });
    if (categoriaDe.has(usuarioId)) lista.push({ tipo: 'categoriaInusual', usuarioId, detalle: `${nombre} compró por primera vez en una categoría ajena a su historial` });
    return lista;
  }

  const conNivel = (corroboradores, base = 'posible') => ({
    corroboradores,
    nivelConfianza: corroboradores.length > 0 || base === 'alta' ? 'alta' : 'posible',
  });

  // ----- A: reseñas coordinadas -----
  const hallazgosResenas = resenas.map((r) => {
    const ficha1 = fichas.get(r.usuario1.id) ?? null;
    const ficha2 = fichas.get(r.usuario2.id) ?? null;
    return {
      ...r,
      usuario1: { ...r.usuario1, ficha: ficha1 },
      usuario2: { ...r.usuario2, ficha: ficha2 },
      motivo: construirMotivoResenas(r, conDefectos('resenas', parametros.resenas), ficha1, ficha2),
    };
  });

  // ----- D: cuentas de una misma persona -----
  const hallazgosRelacionadas = relacionadas.map((a) => {
    // Todas las cuentas del grupo, no solo las que compraron: un vendedor que
    // nunca compró sigue siendo parte de la misma persona.
    const idsMiembros = a.miembros.map((m) => m.id);
    const porBuzon = a.vinculos.some((v) => v.tipo === 'correo');
    const corroboradores = [];
    const porNacimiento = new Map();
    for (const id of idsMiembros) {
      const nac = nacimientos.get(id);
      if (nac) porNacimiento.set(nac, [...(porNacimiento.get(nac) ?? []), id]);
    }
    const mismaFechaNacimiento = [...porNacimiento.values()].some((cuentas) => cuentas.length >= 2);
    if (mismaFechaNacimiento) corroboradores.push({ tipo: 'fechaNacimiento', detalle: 'al menos dos de estas cuentas declararon la misma fecha de nacimiento' });
    for (const f of autocompras) {
      if (!f.mismaCuenta && idsMiembros.includes(f.comprador.id) && idsMiembros.includes(f.vendedor.id)) {
        corroboradores.push({ tipo: 'autocompra', detalle: `la cuenta #${f.comprador.id} le compró a la cuenta #${f.vendedor.id} (${formatoQ(f.total)} en ${pluralPedidos(f.pedidos)}), ver "Autocompra"` });
      }
    }
    for (const r of resenas) {
      if (idsMiembros.includes(r.usuario1.id) && idsMiembros.includes(r.usuario2.id)) {
        corroboradores.push({ tipo: 'resenasCoordinadas', detalle: `las cuentas #${r.usuario1.id} y #${r.usuario2.id} también coordinan reseñas, ver "Reseñas coordinadas"` });
      }
    }
    for (const id of idsMiembros) {
      corroboradores.push(...corroboradoresDeConducta(id));
      if (reventaDe.has(id)) corroboradores.push({ tipo: 'reventa', detalle: `${quien(id)} vende un producto que le compró a otro vendedor, ver "Reventa de lo comprado"` });
    }
    const miembros = a.miembros.map((m) => ({ ...m, categorias: m.categorias.map(nombreCategoria), ficha: fichas.get(m.id) ?? null }));
    const hallazgo = { ...a, miembros, mismaFechaNacimiento };
    // El buzón compartido ya es evidencia por sí solo (parte en "alta"); el
    // nombre solo, no.
    return { ...hallazgo, ...conNivel(corroboradores, porBuzon ? 'alta' : 'posible'), motivo: construirMotivoRelacionadas(hallazgo, corroboradores) };
  });

  // ----- F: autocompra -----
  const hallazgosAutocompra = autocompras.map((f) => {
    const corroboradores = [];
    if (f.mismaCuenta) {
      corroboradores.push(...corroboradoresDeIdentidad(f.comprador.id, { sinAutocompra: true }), ...corroboradoresDeConducta(f.comprador.id));
    } else {
      const nacComprador = nacimientos.get(f.comprador.id);
      if (nacComprador && nacComprador === nacimientos.get(f.vendedor.id)) {
        corroboradores.push({ tipo: 'fechaNacimiento', detalle: 'las dos cuentas declararon la misma fecha de nacimiento' });
      }
    }
    return {
      ...f,
      comprador: { ...f.comprador, ficha: fichas.get(f.comprador.id) ?? null },
      vendedor: { ...f.vendedor, ficha: fichas.get(f.vendedor.id) ?? null },
      ...conNivel(corroboradores, f.mismaCuenta ? 'posible' : 'alta'),
      motivo: construirMotivoAutocompra(f, corroboradores),
    };
  });

  // ----- G: reventa de lo comprado -----
  const hallazgosReventa = reventas.map((r) => {
    const corroboradores = [];
    // La secuencia de una reventa: compra el original y DESPUÉS publica el suyo.
    if (r.listadaDespues) {
      corroboradores.push({
        tipo: 'publicadaDespuesDeComprar',
        detalle: `publicó su oferta DESPUÉS de comprar el original (compró el ${formatoFecha(r.primeraCompra)} y la publicó el ${formatoFecha(r.publicacion.creadaEn)})`,
      });
    }
    if (r.mismosAtributos) {
      corroboradores.push({ tipo: 'mismosAtributos', detalle: 'los atributos de su publicación coinciden exactamente con los del producto que compró' });
    }
    const otrasReventas = (reventaDe.get(r.vendedor.id)?.length ?? 1) - 1;
    if (otrasReventas > 0) {
      corroboradores.push({ tipo: 'reventaRecurrente', detalle: `la misma cuenta aparece revendiendo ${otrasReventas} producto${otrasReventas === 1 ? '' : 's'} más` });
    }
    // Sin su propia señal como corroborador (se corroboraría a sí misma).
    corroboradores.push(...corroboradoresDeIdentidad(r.vendedor.id, { sinReventa: true }), ...corroboradoresDeConducta(r.vendedor.id));
    return {
      ...r,
      vendedor: { ...r.vendedor, ficha: fichas.get(r.vendedor.id) ?? null },
      originales: r.originales.map((o) => ({ ...o, vendedor: { ...o.vendedor, ficha: fichas.get(o.vendedor.id) ?? null } })),
      ...conNivel(corroboradores),
      motivo: construirMotivoReventa(r, corroboradores),
    };
  });

  // ----- E: ráfaga de gasto -----
  const hallazgosRafaga = rafagas.map((r) => {
    const ficha = fichas.get(r.usuario.id) ?? null;
    const corroboradores = [];
    for (const g of gastoPorDia.get(`${r.usuario.id}|${r.dia}`) ?? []) {
      corroboradores.push({ tipo: 'gastoAnomalo', detalle: `ese mismo día el pedido #${g.compraId} (${formatoQ(g.total)}) fue un gasto anómalo respecto a su propio historial` });
    }
    for (const c of categoriaPorDia.get(`${r.usuario.id}|${r.dia}`) ?? []) {
      corroboradores.push({ tipo: 'categoriaInusual', detalle: `ese mismo día compró por primera vez en una categoría ajena a su historial (pedido #${c.compraId})` });
    }
    corroboradores.push(...corroboradoresDeIdentidad(r.usuario.id));
    return {
      ...r,
      usuario: { ...r.usuario, ficha },
      ...conNivel(corroboradores),
      motivo: construirMotivoRafaga(r, ficha, corroboradores, conDefectos('rafaga', parametros.rafaga)),
    };
  });

  // ----- B: gasto anómalo -----
  const hallazgosGasto = gastos.map((g) => {
    const ficha = fichas.get(g.usuario.id) ?? null;
    const corroboradores = [];
    for (const c of categoriaPorCompra.get(g.compraId) ?? []) {
      corroboradores.push({ tipo: 'categoriaInusual', detalle: `en esa misma compra ${g.usuario.nombre} compró por primera vez en la categoría "${nombreCategoria(c.categoriaId)}", ajena a su historial` });
    }
    const dia = fechaGuatemala(g.fecha);
    for (const r of rafagaPorDia.get(`${g.usuario.id}|${dia}`) ?? []) {
      corroboradores.push({ tipo: 'rafagaGasto', detalle: `ese mismo día (${formatoDia(r.dia)}) hizo ${pluralPedidos(r.pedidos)} por ${formatoQ(r.gastado)} — una ráfaga de gasto` });
    }
    corroboradores.push(...corroboradoresDeIdentidad(g.usuario.id));
    const lineas = g.lineas.map((l) => ({ ...l, categoria: nombreCategoria(l.categoria) }));
    return {
      ...g,
      usuario: { ...g.usuario, ficha },
      lineas,
      ...conNivel(corroboradores),
      motivo: construirMotivoGasto({ ...g, lineas }, ficha, corroboradores),
    };
  });

  // ----- C: categoría inusual -----
  const hallazgosCategoria = categorias.map((c) => {
    const ficha = fichas.get(c.usuario.id) ?? null;
    const corroboradores = [];
    for (const g of gastoPorCompra.get(c.compraId) ?? []) {
      corroboradores.push({ tipo: 'gastoAnomalo', detalle: `esa misma compra (${formatoQ(g.total)}) es ${textoVeces(g)} su compra promedio de ${formatoQ(g.promedio)}, un gasto anómalo respecto a su propio historial` });
    }
    const dia = fechaGuatemala(c.fecha);
    for (const r of rafagaPorDia.get(`${c.usuario.id}|${dia}`) ?? []) {
      corroboradores.push({ tipo: 'rafagaGasto', detalle: `ese mismo día (${formatoDia(r.dia)}) hizo ${pluralPedidos(r.pedidos)} por ${formatoQ(r.gastado)} — una ráfaga de gasto` });
    }
    corroboradores.push(...corroboradoresDeIdentidad(c.usuario.id));
    const hallazgo = {
      usuario: { ...c.usuario, ficha },
      categoria: nombreCategoria(c.categoriaId),
      compraId: c.compraId,
      fecha: c.fecha,
      productos: c.productos.map((p) => ({ ...p, subcategoria: catalogo.subcategorias.get(p.subcategoria) ?? 'subcategoría desconocida' })),
      ordenesPrevias: c.ordenesPrevias,
      diasHistorial: c.diasHistorial,
      habituales: c.habituales.map((h) => ({
        categoria: nombreCategoria(h.categoria),
        ordenes: h.ordenes,
        porcentaje: Math.min(100, Math.round((100 * h.ordenes) / c.ordenesPrevias)),
      })),
    };
    return { ...hallazgo, ...conNivel(corroboradores), motivo: construirMotivoCategoria(hallazgo, ficha, corroboradores) };
  });

  // Confianza alta primero; dentro de cada nivel se conserva el orden de la
  // consulta (por monto o por fecha). El sort de JS es estable.
  const porSeveridad = (a, b) => (b.nivelConfianza === 'alta') - (a.nivelConfianza === 'alta');

  return {
    cuentasRelacionadas: hallazgosRelacionadas.sort(porSeveridad),
    autocompra: hallazgosAutocompra.sort(porSeveridad),
    reventa: hallazgosReventa.sort(porSeveridad),
    resenasCoordinadas: hallazgosResenas,
    rafagaGasto: hallazgosRafaga.sort(porSeveridad),
    gastoAnomalo: hallazgosGasto.sort(porSeveridad),
    categoriaInusual: hallazgosCategoria.sort(porSeveridad),
    advertencias,
  };
}

module.exports = {
  consultarFraude,
  // Las fichas de usuario también las usa la pantalla de cuentas bloqueadas
  // (bloqueoService.js), con el mismo formato que el panel de fraude.
  enriquecerUsuarios,
  buscarResenasCoordinadas,
  buscarCuentasRelacionadas,
  buscarGastoAnomalo,
  buscarCategoriaInusual,
  buscarRafagaGasto,
  buscarAutocompra,
  buscarReventa,
  PARAMETROS_POR_DEFECTO,
};
