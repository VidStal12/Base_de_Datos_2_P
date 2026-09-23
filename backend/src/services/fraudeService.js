const neo4j = require('../config/neo4j');
const prisma = require('../config/prisma');
const { conectar: conectarMongo } = require('../config/mongo');
const Resena = require('../models/mongo/Resena');
const Subcategoria = require('../models/mongo/Subcategoria');

// Señal A (ver IA/PLAN-NEO4J-DETECCION-FRAUDE.md §3): cuentas distintas que
// reseñan el mismo conjunto de productos, en una ventana de tiempo corta,
// con calificaciones altas — coordinación entre reseñas de compras YA
// verificadas (reseñar sin comprar ya no es posible, ver resenaService.js).
// Devuelve también calificación promedio y la reseña más reciente del grupo
// — la ficha del usuario (ver enriquecerUsuarios) y el motivo en prosa
// necesitan esos datos, no solo el conteo.
const CONSULTA_RESENAS_COORDINADAS = `
MATCH (u1:Usuario)-[r1:RESEÑÓ]->(p:Producto)<-[r2:RESEÑÓ]-(u2:Usuario)
WHERE u1.id_usuario < u2.id_usuario
  AND abs(duration.between(r1.fecha, r2.fecha).seconds) < $ventanaSegundos
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

// Señal B (ver IA/PLAN-NEO4J-DETECCION-FRAUDE.md §4): una compra en una
// subcategoría que esa cuenta nunca tocó antes, Y ESA MISMA compra usó una
// dirección que otra cuenta distinta también usó (no "la cuenta tiene AL­
// GUNA dirección compartida en algún momento" — la dirección compartida
// tiene que ser la de la compra que se está señalando, si no, dos
// condiciones ciertas por separado pero de compras distintas no dicen nada).
// Agrupa TODAS las cuentas que comparten esa dirección en una sola fila —
// si tres cuentas apuntan al mismo domicilio, eso es una fila más rica, no
// tres filas repetidas de la misma compra.
//
// Dirección compartida SOLA tiene explicaciones inocentes reales —
// familiares, compañeros de casa, una oficina — y marcar una cuenta genuina
// como sospechosa tiene un costo real (ver conversación de diseño). Por eso
// esto también chequea, por cada cuenta que comparte la dirección, si ADEMÁS
// pagó alguna vez con el mismo método (mismo token de pasarela) que esta
// compra puntual: dos personas de verdad distintas casi nunca comparten una
// tarjeta, aunque sí compartan techo — coincidir en las dos cosas a la vez
// es mucho más difícil de explicar sin fraude que compartir solo el
// domicilio. mismoMetodoPago viaja por cuenta compartida, no es un
// sí/no global de la fila — dos cuentas pueden compartir la dirección y solo
// una de ellas compartir también la tarjeta.
const CONSULTA_DESVIACION_PATRON = `
MATCH (u:Usuario)-[c:COMPRÓ]->(p:Producto)
WHERE NOT EXISTS {
  MATCH (u)-[c2:COMPRÓ]->(otro:Producto)
  WHERE otro.subcategoria = p.subcategoria AND otro <> p AND c.fecha > c2.fecha
}
MATCH (u)-[:ENVIÓ_A]->(d:Direccion {direccion_texto: c.direccion_texto})<-[:ENVIÓ_A]-(otraCuenta:Usuario)
WHERE otraCuenta.id_usuario <> u.id_usuario
WITH u, p, c, otraCuenta,
     EXISTS { (otraCuenta)-[:PAGÓ_CON]->(:MetodoPago {token_pasarela: c.metodo_pago_token}) } AS mismoMetodoPago
WITH u, p, c,
     collect(DISTINCT {id: otraCuenta.id_usuario, nombre: otraCuenta.nombre, mismoMetodoPago: mismoMetodoPago}) AS otrasCuentas
RETURN u.id_usuario AS usuarioId, u.nombre AS usuarioNombre,
       p.producto_id AS productoId, p.descripcion AS productoDescripcion, p.subcategoria AS subcategoriaId,
       c.fecha AS fecha, c.monto AS monto,
       otrasCuentas
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

const UN_DIA_MS = 86400000;
// Bajo este umbral, la antigüedad de la cuenta se menciona en el motivo como
// refuerzo de la señal — una cuenta de un día que ya dispara un patrón pesa
// distinto que una con meses de historial. Ajustable, no una regla dura.
const DIAS_CUENTA_RECIENTE = 30;

// Ficha por usuario — todo lo que un administrador necesita para decidir si
// vale la pena investigar, no solo el nombre. Neo4j guarda a propósito solo
// {id_usuario, nombre, rol} (ver PLAN-NEO4J-DETECCION-FRAUDE.md §5, "no se
// copian datos personales al grafo") — el resto se resuelve acá, en vivo,
// contra MySQL (fuente de identidad) y Mongo (reseñas), nunca cacheado en
// el grafo. Se pide en lote (un solo roundtrip por base para todos los ids
// de una respuesta), no una consulta por fila.
async function enriquecerUsuarios(ids) {
  if (ids.length === 0) return new Map();

  const [usuarios, comprasPorUsuario] = await Promise.all([
    prisma.usuarios.findMany({
      where: { id_usuario: { in: ids } },
      include: { rol: true, direcciones: true, metodos_pago: true },
    }),
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
  for (const u of usuarios) {
    const compras = comprasMap.get(u.id_usuario);
    const diasDesdeCreacion = Math.max(0, Math.floor((ahora - u.creado_en.getTime()) / UN_DIA_MS));
    fichas.set(u.id_usuario, {
      id: u.id_usuario,
      nombre: `${u.nombres} ${u.apellidos}`,
      correo: u.correo,
      rol: u.rol.tipo_rol,
      // Cuentas de antes de agregar este campo (2026-09-18) muestran la
      // fecha de esa migración, no su alta real — no se guardó antes. Solo
      // es confiable para cuentas creadas de acá en adelante; el consumidor
      // (panel/motivo) no distingue un caso del otro porque no hay forma de
      // saber, desde el dato mismo, a cuál pertenece.
      creadoEn: u.creado_en.toISOString(),
      diasDesdeCreacion,
      cuentaReciente: diasDesdeCreacion <= DIAS_CUENTA_RECIENTE,
      direcciones: deduplicarPorContenido(u.direcciones.map((d) => ({ pais: d.pais, direccion: d.direccion, codigoPostal: d.codigo_postal }))),
      // Nunca token_pasarela ni el número completo — mismo criterio que
      // CheckoutPage.jsx, solo lo que ya es seguro mostrar.
      metodosPago: deduplicarPorContenido(u.metodos_pago.map((m) => ({ marca: m.marca, ultimos4: m.ultimos_4_digitos }))),
      totalCompras: compras?._count.id ?? 0,
      totalGastado: Number(compras?._sum.total ?? 0),
      totalResenas: resenasMap.get(u.id_usuario) ?? 0,
    });
  }
  return fichas;
}

async function resolverSubcategorias(ids) {
  if (ids.length === 0) return new Map();
  await conectarMongo();
  const subs = await Subcategoria.find({ _id: { $in: ids } }).select('subcategoria').lean();
  return new Map(subs.map((s) => [String(s._id), s.subcategoria]));
}

// Direcciones/métodos de pago con el mismo contenido (p. ej. un checkout
// viejo que guardó una fila nueva en vez de reusar la existente) se ven
// como el mismo dato repetido en la ficha — dedupe por contenido, no por id,
// mismo criterio que ya usa la clave de Direccion/MetodoPago en Neo4j.
function deduplicarPorContenido(items) {
  const vistos = new Set();
  return items.filter((item) => {
    const clave = JSON.stringify(item);
    if (vistos.has(clave)) return false;
    vistos.add(clave);
    return true;
  });
}

// El mismo (usuario, producto, cuentas con las que comparte dirección) puede
// aparecer repetido si esa persona compró el mismo producto más de una vez
// (por ejemplo, este mismo dataset de prueba, recreado varias veces durante
// el desarrollo) — no es una segunda señal, es la misma observación otra
// vez. Se colapsa a la ocurrencia más reciente; SÍ quedan como filas
// separadas los casos donde el conjunto de cuentas compartidas cambia entre
// compras, porque eso sí es información nueva. CONSULTA_DESVIACION_PATRON ya
// ordena por fecha descendente, así que la primera vez que se ve una clave
// ya es la más reciente — la comparación de fecha es solo un resguardo, no
// depende de ese orden.
function colapsarRepetidos(filas) {
  const porClave = new Map();
  for (const f of filas) {
    const clave = `${f.usuario.id}|${f.producto.id}|${f.otrasCuentas.map((o) => o.id).sort((a, b) => a - b).join(',')}`;
    const actual = porClave.get(clave);
    if (!actual || (f.fecha && (!actual.fecha || f.fecha > actual.fecha))) {
      porClave.set(clave, f);
    }
  }
  return [...porClave.values()];
}

function diasATexto(dias) {
  if (dias <= 1) return 'menos de un día';
  if (dias === 1) return '1 día';
  return `${dias} días`;
}

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

// ¿Esta misma pareja de cuentas coordina TAMBIÉN reseñas (Señal A)? Dos
// señales independientes — cada una con su propio criterio, su propia
// consulta, su propia posibilidad de ser casualidad por separado —
// apuntando al mismo par es mucho más difícil de explicar como casualidad
// que cualquiera de las dos sola. No importa el orden de u1/u2 en la fila de
// reseñas coordinadas, se chequean los dos sentidos.
function apareceEnSenalA(resenas, idA, idB) {
  return resenas.some(
    (r) => (r.usuario1.id === idA && r.usuario2.id === idB) || (r.usuario1.id === idB && r.usuario2.id === idA)
  );
}

// Dirección compartida sola tiene explicaciones inocentes reales — familia,
// compañeros de casa, una oficina, incluso varias cuentas de una misma
// familia cargando la tarjeta de uno de los padres — así que el texto no
// trata todas las filas igual. Pero la corrección va en un solo sentido:
// un corroborador independiente (mismo método de pago, o esta misma pareja
// también coordinando en la Señal A) SUBE el nivel a "alta" — la postura
// por defecto ante evidencia real es tratarla como sospechosa hasta que una
// persona revisando confirme lo contrario, no que el sistema se
// autoconvenza de que es inocente. El contexto de actividad propia de cada
// cuenta (más abajo) es al revés a propósito: se muestra siempre, pero
// nunca baja el nivel — es información para que decida una persona, no una
// segunda oportunidad para que el algoritmo se baje solo.
function construirMotivoDesviacion({ usuario, producto, subcategoriaNombre, monto, fecha, otrasCuentas }, ficha) {
  const nombresOtros = otrasCuentas.map((o) => o.nombre).join(', ');
  const plural = otrasCuentas.length !== 1;
  const fechaTexto = fecha ? new Date(fecha).toLocaleDateString('es-GT', { dateStyle: 'medium' }) : 'fecha desconocida';
  const corroboradas = otrasCuentas.filter((o) => o.mismoMetodoPago || o.tambienEnSenalA);

  const frases = [
    `${usuario.nombre} compró "${producto.descripcion}" el ${fechaTexto} por Q${monto.toFixed(2)} — su primera compra registrada en "${subcategoriaNombre}" — y la envió a una dirección que también usa${plural ? 'n' : ''} ${plural ? `${otrasCuentas.length} cuentas distintas` : 'otra cuenta'}: ${nombresOtros}.`,
  ];

  if (corroboradas.length > 0) {
    for (const o of corroboradas) {
      const razones = [];
      if (o.mismoMetodoPago) razones.push('también pagó alguna vez con el mismo método de pago que esta compra');
      if (o.tambienEnSenalA) razones.push('esta misma pareja de cuentas también aparece coordinando reseñas en la Señal A');
      frases.push(`Además, ${o.nombre} ${razones.join(', y ')}.`);
    }
    frases.push(
      'Un corroborador independiente además de la dirección — mismo método de pago o coordinación en otra señal — es mucho más difícil de explicar como familia o compañeros de casa que compartir solo el domicilio. Se marca como confianza alta: la postura por defecto ante esta evidencia es tratarla como sospechosa hasta que una revisión humana confirme lo contrario, no al revés.'
    );
  } else {
    frases.push(
      'Comprar por primera vez en una categoría nueva no es sospechoso por sí solo; compartir la dirección de envío de esa compra puntual con otra cuenta sí lo es — pero también tiene explicaciones inocentes reales (familiares, compañeros de casa, una oficina). Ninguna de las cuentas comparte además el método de pago ni aparece coordinando reseñas, así que esta señal por sí sola es más débil — conviene revisar el historial completo antes de actuar, no tratarla como confirmada.'
    );
  }

  // Contexto neutral, no usado para subir NI bajar el nivel (ese ya quedó
  // decidido arriba, antes de esto) — actividad propia sustancial y
  // repartida en el tiempo es más compatible con una cuenta real (persona o
  // familia) que con una armada solo para esto, pero decidir eso es trabajo
  // de quien revisa, no de este texto.
  for (const o of otrasCuentas) {
    if (!o.ficha) continue;
    frases.push(
      `Contexto sobre ${o.nombre}: ${o.ficha.totalCompras} compra(s) y ${o.ficha.totalResenas} reseña(s) propias, cuenta activa desde hace ${diasATexto(o.ficha.diasDesdeCreacion)}.`
    );
  }

  if (ficha?.cuentaReciente) {
    frases.push(`La cuenta de ${usuario.nombre} se creó hace ${diasATexto(ficha.diasDesdeCreacion)}, lo que refuerza la señal.`);
  }
  return frases.join(' ');
}

// Parámetros ajustables con default (ver PLAN-NEO4J-DETECCION-FRAUDE.md §10)
// — nunca interpolados en la consulta.
async function resenasCoordinadas({ ventanaSegundos = 3600, minimoProductosCompartidos = 3, calificacionMinima = 4 } = {}) {
  const registros = await neo4j.leer(CONSULTA_RESENAS_COORDINADAS, { ventanaSegundos, minimoProductosCompartidos, calificacionMinima });
  const filas = registros.map((r) => ({
    usuario1: { id: aNumero(r.get('usuario1Id')), nombre: r.get('usuario1Nombre') },
    usuario2: { id: aNumero(r.get('usuario2Id')), nombre: r.get('usuario2Nombre') },
    productosCompartidos: aNumero(r.get('productosCompartidos')),
    productos: r.get('productos'),
    promedio1: aNumero(r.get('promedio1')),
    promedio2: aNumero(r.get('promedio2')),
    ultimaActividad: r.get('ultimaActividad')?.toString?.() ?? null,
  }));

  const ids = [...new Set(filas.flatMap((f) => [f.usuario1.id, f.usuario2.id]))];
  const fichas = await enriquecerUsuarios(ids);

  return filas.map((f) => {
    const ficha1 = fichas.get(f.usuario1.id) ?? null;
    const ficha2 = fichas.get(f.usuario2.id) ?? null;
    return {
      usuario1: { ...f.usuario1, ficha: ficha1 },
      usuario2: { ...f.usuario2, ficha: ficha2 },
      productosCompartidos: f.productosCompartidos,
      productos: f.productos,
      promedio1: f.promedio1,
      promedio2: f.promedio2,
      ultimaActividad: f.ultimaActividad,
      motivo: construirMotivoResenas(f, { ventanaSegundos, calificacionMinima }, ficha1, ficha2),
    };
  });
}

async function desviacionPatron() {
  // resenas: para el cruce con la Señal A (ver apareceEnSenalA). Best-effort
  // y con su propio catch — que esto falle no debe tirar abajo la Señal B
  // entera, solo perder la posibilidad de escalar por ese corroborador
  // (mismo criterio de "una señal no tira abajo a la otra" que ya rige
  // consultarFraude()). Se pide con sus propios parámetros por defecto,
  // igual que haría un llamado aparte a resenasCoordinadas() — duplica una
  // consulta barata en vez de acoplar las dos funciones entre sí.
  const [registros, resenas] = await Promise.all([
    neo4j.leer(CONSULTA_DESVIACION_PATRON, {}),
    resenasCoordinadas().catch(() => []),
  ]);
  const filas = colapsarRepetidos(
    registros.map((r) => ({
      usuario: { id: aNumero(r.get('usuarioId')), nombre: r.get('usuarioNombre') },
      producto: { id: aNumero(r.get('productoId')), descripcion: r.get('productoDescripcion') },
      subcategoriaId: r.get('subcategoriaId'),
      fecha: r.get('fecha')?.toString?.() ?? null,
      monto: aNumero(r.get('monto')),
      otrasCuentas: r.get('otrasCuentas').map((o) => ({ id: aNumero(o.id), nombre: o.nombre, mismoMetodoPago: o.mismoMetodoPago })),
    }))
  );

  const idsUsuarios = [...new Set(filas.flatMap((f) => [f.usuario.id, ...f.otrasCuentas.map((o) => o.id)]))];
  const idsSubcategorias = [...new Set(filas.map((f) => f.subcategoriaId))];
  const [fichas, subcategorias] = await Promise.all([enriquecerUsuarios(idsUsuarios), resolverSubcategorias(idsSubcategorias)]);

  return filas.map((f) => {
    const ficha = fichas.get(f.usuario.id) ?? null;
    const subcategoriaNombre = subcategorias.get(f.subcategoriaId) ?? 'categoría desconocida';
    const otrasCuentasEnriquecidas = f.otrasCuentas.map((o) => ({
      ...o,
      ficha: fichas.get(o.id) ?? null,
      tambienEnSenalA: apareceEnSenalA(resenas, f.usuario.id, o.id),
    }));
    // 'alta' si CUALQUIER corroborador independiente aparece — mismo método
    // de pago O esta misma pareja coordinando reseñas en la Señal A. Nunca
    // al revés: nada de lo demás que se calcula acá puede bajar el nivel,
    // solo subirlo — "alta" es la postura por defecto ante evidencia real,
    // que sea inocente lo decide una persona revisando, no el algoritmo
    // bajándose solo (ver construirMotivoDesviacion).
    const nivelConfianza = otrasCuentasEnriquecidas.some((o) => o.mismoMetodoPago || o.tambienEnSenalA) ? 'alta' : 'posible';
    return {
      usuario: { ...f.usuario, ficha },
      producto: f.producto,
      subcategoria: subcategoriaNombre,
      fecha: f.fecha,
      monto: f.monto,
      nivelConfianza,
      otrasCuentas: otrasCuentasEnriquecidas,
      motivo: construirMotivoDesviacion({ ...f, subcategoriaNombre, otrasCuentas: otrasCuentasEnriquecidas }, ficha),
    };
  });
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
