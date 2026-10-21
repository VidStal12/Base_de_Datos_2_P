const busquedaService = require('./busquedaService');
const productoService = require('./productoService');
const categoriaService = require('./categoriaService');
const suspension = require('./suspensionService');
const Producto = require('../models/mongo/Producto');
const { conectar } = require('../config/mongo');
const { componenteCaido } = require('../utils/resiliencia');
const { escaparRegex } = require('../utils/validation');
const facetas = require('./facetasBusqueda');

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

// La búsqueda y la navegación por categorías son UNA sola consulta (busquedaService.buscar). Con
// Elasticsearch apagado la contesta Mongo (`modo: 'basico'`); con el índice vacío en la portada también,
// para que la tienda no aparezca vacía hasta que alguien repueble el índice.
async function buscar(opciones = {}) {
  let respuesta = await conRespaldo(() => busquedaService.buscar(opciones), () => buscarEnCatalogo(opciones), 'elasticsearch');
  if (respuesta.total === 0 && !respuesta.modo && esNavegacionPura(opciones)) {
    respuesta = await buscarEnCatalogo(opciones).then((deMongo) => (deMongo.total > 0 ? deMongo : respuesta), () => respuesta);
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

module.exports = { buscar, sugerir, listar, obtener, categorias };
