const busquedaService = require('./busquedaService');
const productoService = require('./productoService');
const categoriaService = require('./categoriaService');
const suspension = require('./suspensionService');
const tendenciaService = require('./tendenciaService');
const Producto = require('../models/mongo/Producto');
const { conectar } = require('../config/mongo');
const { conectar: conectarRedis } = require('../config/redis');
const { componenteCaido, registrarFallo } = require('../utils/resiliencia');
const { escaparRegex } = require('../utils/validation');
const facetas = require('./facetasBusqueda');
const reglas = require('./reglasRelacionados');

// Lecturas del catálogo que SOBREVIVEN a la caída de Mongo o de Elasticsearch
// (IA/ENTREGA-3-CONSISTENCIA.md §7). Los dos guardan una copia de lo que el catálogo
// muestra — Mongo es la fuente, el índice de búsqueda la copia que se escribe junto a
// ella —, así que cada uno es el respaldo del otro:
//
//   Elasticsearch apagado → la búsqueda y el autocompletado pasan a Mongo: texto literal en
//                            vez de tolerancia ortográfica y relevancia («búsqueda básica»).
//   Mongo apagado         → el catálogo, el detalle y las categorías se leen del índice:
//                            sin reseñas, ofertas flash ni historial, que solo existen en Mongo.
//
// Si los DOS están apagados la lectura falla con la caída del catálogo (503). Solo se cae
// al respaldo cuando el que falló es el esperado: un error de validación o un bug no se
// esconde detrás de un resultado alternativo.
const cayo = (err, componente) => componenteCaido(err) === componente;

// El respaldo falló también: el error que se informa es el del origen (el que la persona
// esperaba usar), no el del respaldo.
async function conRespaldo(principal, respaldo, componente) {
  try {
    return await principal();
  } catch (err) {
    if (!cayo(err, componente)) throw err;
    try {
      return await respaldo();
    } catch {
      throw err;
    }
  }
}

// La misma respuesta que busquedaService.buscar() (ver facetasBusqueda.js), armada con Mongo.
// `modo: 'basico'` le avisa a la interfaz que la tolerancia a errores de tipeo no está activa.
// A Mongo solo se le pide el TEXTO (más estado activo y vendedores suspendidos, que ya filtra
// productoService.listar): categoría, precio y atributos se aplican en memoria porque las facetas
// disyuntivas necesitan "todos los filtros menos el suyo" y el conjunto recortado no alcanza.
// Es la misma cuenta que hacen las agregaciones del motor, así que la interfaz no nota la diferencia.
async function buscarEnCatalogo(opciones) {
  const filtros = facetas.normalizarConsulta(opciones);
  const productos = await productoService.listar({ q: filtros.q });
  return { ...facetas.desdeLista(productos, filtros), modo: 'basico' };
}

// El índice se actualiza al crear o editar un producto, pero NO al comprarlo: el stock y las ventas
// que muestra una tarjeta pueden ir atrasados respecto de Mongo, que sí los descuenta en cada checkout
// (checkoutService.js). Se vuelven a leer de Mongo solo para los productos de la página (a lo sumo 100,
// una consulta) y se reemplazan en la respuesta. Sin Mongo se muestran los valores del índice: la
// búsqueda no debe fallar por un dato que solo hace falta pulir.
async function conExistenciasVigentes(respuesta) {
  if (respuesta.modo === 'basico' || respuesta.resultados.length === 0) return respuesta; // el respaldo ya viene de Mongo
  try {
    await conectar();
    const docs = await Producto.find({ producto_id: { $in: respuesta.resultados.map((p) => p.id) } })
      .select('producto_id inventario.cantidad total_vendido')
      .lean();
    const vigentes = new Map(docs.map((doc) => [doc.producto_id, doc]));
    return {
      ...respuesta,
      resultados: respuesta.resultados.map((p) => {
        const vigente = vigentes.get(p.id);
        if (!vigente) return p;
        return {
          ...p,
          inventario: { ...p.inventario, cantidad: vigente.inventario?.cantidad ?? p.inventario.cantidad },
          total_vendido: vigente.total_vendido ?? p.total_vendido,
        };
      }),
    };
  } catch (err) {
    if (!componenteCaido(err)) console.error('No se pudo releer el stock de los resultados de la búsqueda:', err.message);
    return respuesta;
  }
}

// La portada y las categorías sin ningún otro filtro. Solo ahí un índice VACÍO es sospechoso: un
// Elasticsearch recién creado, al que todavía no se le corrió `npm run busqueda:backfill`.
function esNavegacionPura(opciones) {
  const f = facetas.normalizarConsulta(opciones);
  return !f.q && Object.keys(f.atributos).length === 0 && f.precioMin === undefined && f.precioMax === undefined && f.pagina === 1;
}

const CANTIDAD_SUGERIDOS = 6;

// Actividad reciente del usuario — una búsqueda que SÍ encontró algo, o un producto que
// abrió para ver su detalle — en Redis, mismo patrón que carrito/oferta: un dato de bajo
// costo si se pierde, no hace falta persistirlo en MySQL. Guarda hasta 5 entradas con 30
// días de TTL en UNA sola lista (no una por tipo), para que "lo último que hizo" sea lo
// último de verdad y no siempre lo último que buscó.
const CLAVE_ACTIVIDAD_RECIENTE = (usuarioId) => `actividad:${usuarioId}`;
const MAX_ACTIVIDADES_GUARDADAS = 5;
const TTL_ACTIVIDAD_SEGUNDOS = 60 * 60 * 24 * 30;

async function registrarActividad(usuarioId, tipo, valor) {
  try {
    const redis = await conectarRedis('actividad');
    const clave = CLAVE_ACTIVIDAD_RECIENTE(usuarioId);
    const entrada = JSON.stringify({ tipo, valor });
    await redis.lrem(clave, 0, entrada);
    await redis.lpush(clave, entrada);
    await redis.ltrim(clave, 0, MAX_ACTIVIDADES_GUARDADAS - 1);
    await redis.expire(clave, TTL_ACTIVIDAD_SEGUNDOS);
  } catch (err) {
    // registrarFallo avisa UNA vez por caída (no una línea por petición mientras Redis está apagado).
    registrarFallo('No se pudo registrar la actividad reciente', err);
  }
}

async function obtenerUltimaActividad(usuarioId) {
  try {
    const redis = await conectarRedis('actividad');
    const [masReciente] = await redis.lrange(CLAVE_ACTIVIDAD_RECIENTE(usuarioId), 0, 0);
    return masReciente ? JSON.parse(masReciente) : null;
  } catch (err) {
    registrarFallo('No se pudo leer la actividad reciente', err);
    return null;
  }
}

// Se llama desde productoRoutes.js (GET /:id) cada vez que alguien logueado ve el detalle
// de un producto que sí le quedó visible (no uno oculto por suspensión del vendedor).
function registrarVistaProducto(usuarioId, productoId) {
  if (!usuarioId) return;
  registrarActividad(usuarioId, 'producto', productoId);
}

// Reintento con la última actividad del usuario. Usa conRespaldo/obtener directamente
// (no buscar()) para no volver a entrar a sugeridosSinResultados si esa actividad vieja ya
// no encuentra nada — evitaría una recursión contra el mismo valor.
async function intentarActividadReciente(usuarioId) {
  const actividad = await obtenerUltimaActividad(usuarioId);
  if (!actividad) return null;

  if (actividad.tipo === 'busqueda') {
    const resultado = await conRespaldo(
      () => busquedaService.buscar({ q: actividad.valor }),
      () => buscarEnCatalogo({ q: actividad.valor }),
      'elasticsearch'
    );
    if (resultado.total > 0) {
      // Vienen del índice, que no se entera de las ventas: igual que en los resultados de la búsqueda, el
      // stock de cada tarjeta se relee de Mongo (conExistenciasVigentes) para no mostrar «En stock» de más.
      const { resultados } = await conExistenciasVigentes({ ...resultado, resultados: resultado.resultados.slice(0, CANTIDAD_SUGERIDOS) });
      return {
        sugeridos: resultados,
        origenSugerencia: 'busquedaReciente',
        terminoBusquedaReciente: actividad.valor,
      };
    }
    return null;
  }

  if (actividad.tipo === 'producto') {
    try {
      const producto = await obtener(actividad.valor);
      const oculto = await productoService.vendedorOculto(producto.vendedor_id);
      // Solo un producto ACTIVO: el detalle se abre por URL directa aunque el producto esté pausado,
      // pero la vitrina (y esta sugerencia, que invita a comprarlo) solo ofrece lo que hoy se vende.
      // Se mira acá y no solo al registrar la vista, porque pudo pausarse después de que el usuario lo vio.
      if (!oculto && producto.estado === 'activo') return { sugeridos: [producto], origenSugerencia: 'productoVisto' };
    } catch {
      // el producto ya no existe, o su vendedor quedó suspendido: seguimos a la siguiente capa
    }
    return null;
  }

  return null;
}

// Cuando la búsqueda de TEXTO no encuentra NADA (ni con tolerancia a errores de tipeo, o
// directamente porque lo escrito no tiene relación con el catálogo — "asadasdasd"), en vez
// de una página vacía se ofrece lo que probablemente le interese a quien pregunta, mismo
// criterio que cualquier tienda grande (Amazon, Temu) ante una búsqueda sin resultados:
//   1) si hay sesión, repetir su última actividad (una búsqueda que sí dio resultados, o el
//      último producto que vio el detalle) — lo que haya pasado más reciente de las dos;
//   2) si no hay actividad reciente que reutilizar, sus recomendaciones por historial de
//      compras (tendenciaService, ya construido para Entrega 2);
//   3) si no hay sesión, o nada de lo anterior encontró algo, los más vendidos del catálogo.
// Que esto falle (Mongo/MySQL/Redis caídos) no debe tumbar la búsqueda: sin sugerencias, la
// respuesta sigue siendo la de cero resultados tal cual. Distinto del caso de esNavegacionPura
// (índice vacío en la portada): acá sí hubo texto para comparar contra el catálogo, y nada calzó.
async function sugeridosSinResultados(usuarioId) {
  try {
    if (usuarioId) {
      const porActividadReciente = await intentarActividadReciente(usuarioId);
      if (porActividadReciente) return porActividadReciente;

      const { productos } = await tendenciaService.recomendar(usuarioId);
      if (productos.length > 0) return { sugeridos: productos, origenSugerencia: 'historial' };
    }
    const { resultados } = await buscar({ ordenarPor: 'masVendidos' });
    return resultados.length > 0 ? { sugeridos: resultados.slice(0, CANTIDAD_SUGERIDOS), origenSugerencia: 'tendencia' } : {};
  } catch (err) {
    registrarFallo('No se pudieron calcular sugeridosSinResultados', err);
    return {};
  }
}

// La búsqueda y la navegación por categorías son UNA sola consulta (busquedaService.buscar). Con
// Elasticsearch apagado la contesta Mongo (`modo: 'basico'`); con el índice vacío en la portada también,
// para que la tienda no aparezca vacía hasta que alguien repueble el índice. `usuarioId` es opcional
// (viene de optionalAuth en la ruta): sin sesión, sugeridosSinResultados salta directo a más vendidos.
async function buscar(opciones = {}, usuarioId) {
  // `opciones` es req.query SIN validar: ?q=a&q=b llega como arreglo. El texto que se usa acá es el mismo que
  // normalizarConsulta le pasa al motor (cadena recortada, de a lo sumo 200 caracteres), nunca el valor crudo.
  const { q } = facetas.normalizarConsulta(opciones);
  let respuesta = await conRespaldo(() => busquedaService.buscar(opciones), () => buscarEnCatalogo(opciones), 'elasticsearch');
  if (respuesta.total === 0 && !respuesta.modo && esNavegacionPura(opciones)) {
    respuesta = await buscarEnCatalogo(opciones).then((deMongo) => (deMongo.total > 0 ? deMongo : respuesta), () => respuesta);
  }
  if (respuesta.total > 0 && usuarioId && q) {
    registrarActividad(usuarioId, 'busqueda', q);
  }
  if (respuesta.total === 0 && q) {
    respuesta = { ...respuesta, ...(await sugeridosSinResultados(usuarioId)) };
  }
  return conExistenciasVigentes(respuesta);
}

// Sugerencias por prefijo contra Mongo: sin tolerancia a errores, pero escribir en la caja de
// búsqueda sigue ofreciendo títulos reales.
async function sugerirEnCatalogo(q) {
  if (!q || !q.trim()) return [];
  await conectar();
  const suspendidos = await suspension.vendedoresSuspendidos();
  const filtro = { estado: 'activo', descripcion: new RegExp(`^${escaparRegex(q.trim())}`, 'i') };
  if (suspendidos.size > 0) filtro.vendedor_id = { $nin: [...suspendidos] };
  const docs = await Producto.find(filtro).select('descripcion').limit(40).lean();
  return [...new Set(docs.map((doc) => doc.descripcion))].slice(0, 8);
}

function sugerir(q) {
  return conRespaldo(() => busquedaService.sugerir(q), () => sugerirEnCatalogo(q), 'elasticsearch');
}

function listar(opciones = {}) {
  return conRespaldo(
    () => productoService.listar(opciones),
    // Las ofertas flash viven en Mongo (y su cupo en Redis): el índice no las conoce.
    () => (opciones.soloOfertas === 'true' || opciones.soloOfertas === true ? [] : busquedaService.listarDesdeIndice(opciones)),
    'mongo'
  );
}

// `desde_indice` le dice a la pantalla del producto que reseñas, historial y oferta flash no
// están disponibles ahora mismo.
function obtener(id) {
  return conRespaldo(
    () => productoService.obtener(id),
    async () => ({ ...(await busquedaService.obtenerDelIndice(id)), desde_indice: true }),
    'mongo'
  );
}

function categorias() {
  return conRespaldo(() => categoriaService.listar(), () => busquedaService.categoriasDelIndice(), 'mongo');
}

// ---------- Productos relacionados (ficha del producto) ----------
//
// Tres capas, de la mejor a la que siempre alcanza (IA/ADR-006-recomendacion-semantica-vectorial.md):
//   1) por significado: los vecinos del vector del producto en el índice (`modo: 'semantico'`). Todo sale del
//      índice, así que sigue funcionando con Mongo apagado (el stock vigente se relee de Mongo solo si responde);
//   2) misma subcategoría, de Mongo (`modo: 'subcategoria'`): cuando Elasticsearch está apagado, cuando el producto
//      todavía no tiene vector (se indexó sin el modelo) o cuando por significado no hay suficientes parecidos;
//   3) nada (`modo: 'ninguno'`): con menos de MINIMO resultados la sección se oculta — mejor nada que algo sin
//      relación. Con Elasticsearch y Mongo apagados a la vez se informa la caída del buscador (503), como en el resto.
// Un producto inexistente, o de un vendedor suspendido, es un 404 (igual que su detalle para el público).
const SIN_RELACIONADOS = { modo: 'ninguno', productos: [] };
const bastan = (respuesta) => respuesta.productos.length >= reglas.MINIMO;

async function relacionadosPorSignificado(id, usuarioId) {
  let similares;
  try {
    similares = await busquedaService.similares(id, { vendedorPropioId: usuarioId });
  } catch (err) {
    // Un producto que el índice no conoce (se creó con Elasticsearch apagado y aún no hubo backfill) puede existir en
    // Mongo: se deja la decisión a la capa siguiente, que lo confirma o responde 404.
    if (err.status === 404) return { modo: 'semantico', productos: [] };
    throw err;
  }
  // El índice no se entera de las ventas: se relee el stock vigente de Mongo (una consulta para todos los candidatos)
  // para dejar lo agotado al final con datos de hoy, no de la última edición.
  const { resultados } = await conExistenciasVigentes({ resultados: similares.candidatos });
  return { modo: 'semantico', productos: reglas.elegir(resultados, { titulo: similares.origen.descripcion }) };
}

async function relacionadosPorSubcategoria(id, usuarioId) {
  const producto = await productoService.obtener(id);
  if (await productoService.vendedorOculto(producto.vendedor_id)) throw Object.assign(new Error('Producto no encontrado'), { status: 404 });
  const { id: subcategoriaId, subcategoria } = producto.subcategoria ?? {};
  if (!subcategoriaId) return SIN_RELACIONADOS;
  const delMismoTipo = (await productoService.listar({ subcategoriaId }))
    .filter((otro) => otro.id !== producto.id && otro.vendedor_id !== Number(usuarioId))
    .sort((a, b) => (b.total_vendido ?? 0) - (a.total_vendido ?? 0)); // sin una medida de parecido, los más vendidos primero
  return { modo: 'subcategoria', subcategoria, productos: reglas.elegir(delMismoTipo, { titulo: producto.descripcion }) };
}

async function relacionados(id, usuarioId) {
  const porSignificado = await conRespaldo(
    () => relacionadosPorSignificado(id, usuarioId),
    () => relacionadosPorSubcategoria(id, usuarioId),
    'elasticsearch'
  );
  if (bastan(porSignificado)) return porSignificado;
  if (porSignificado.modo === 'subcategoria') return SIN_RELACIONADOS; // ya era el respaldo: no hay otra capa
  // El índice contestó, pero sin suficientes parecidos (o el producto no tiene vector): se prueba con la subcategoría.
  // Si Mongo está apagado no se puede confirmar nada: la sección se oculta. Un 404 sí se informa.
  const porSubcategoria = await relacionadosPorSubcategoria(id, usuarioId).catch((err) => {
    if (cayo(err, 'mongo')) return SIN_RELACIONADOS;
    throw err;
  });
  return bastan(porSubcategoria) ? porSubcategoria : SIN_RELACIONADOS;
}

module.exports = { buscar, sugerir, listar, obtener, categorias, registrarVistaProducto, relacionados };
