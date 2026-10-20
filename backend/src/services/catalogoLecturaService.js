const busquedaService = require('./busquedaService');
const productoService = require('./productoService');
const categoriaService = require('./categoriaService');
const suspension = require('./suspensionService');
const Producto = require('../models/mongo/Producto');
const { conectar } = require('../config/mongo');
const { componenteCaido } = require('../utils/resiliencia');
const { escaparRegex } = require('../utils/validation');

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

function contar(productos, clave) {
  const cuentas = new Map();
  for (const producto of productos) {
    const nombre = clave(producto);
    if (nombre) cuentas.set(nombre, (cuentas.get(nombre) || 0) + 1);
  }
  return [...cuentas.entries()].sort((a, b) => b[1] - a[1]).map(([nombre, cantidad]) => ({ nombre, cantidad }));
}

// Misma forma que la agregación de Elasticsearch: { nombreDelAtributo: [valores…] }, los 20
// atributos y 30 valores más frecuentes.
function facetasDe(productos) {
  const porNombre = new Map();
  for (const producto of productos) {
    for (const { nombre, valor } of producto.atributos || []) {
      if (!porNombre.has(nombre)) porNombre.set(nombre, new Map());
      const valores = porNombre.get(nombre);
      valores.set(valor, (valores.get(valor) || 0) + 1);
    }
  }
  const masFrecuentes = (mapa, limite) => [...mapa.entries()].sort((a, b) => b[1] - a[1]).slice(0, limite);
  const totales = new Map([...porNombre].map(([nombre, valores]) => [nombre, [...valores.values()].reduce((a, b) => a + b, 0)]));
  return Object.fromEntries(masFrecuentes(totales, 20).map(([nombre]) => [nombre, masFrecuentes(porNombre.get(nombre), 30).map(([valor]) => valor)]));
}

// La misma respuesta que busquedaService.buscar(), armada con Mongo. `modo: 'basico'` le
// avisa a la interfaz que la tolerancia a errores de tipeo no está activa.
async function buscarEnCatalogo(opciones) {
  const productos = await productoService.listar({
    q: opciones.q,
    categoriaId: opciones.categoriaId,
    subcategoriaId: opciones.subcategoriaId,
    atributos: opciones.atributos,
    precioMin: opciones.precioMin,
    precioMax: opciones.precioMax,
    ordenarPor: opciones.ordenarPor,
  });
  return {
    resultados: productos.slice(0, 60),
    total: productos.length,
    facetas: facetasDe(productos),
    categorias: contar(productos, (p) => p.subcategoria?.categoria),
    subcategorias: contar(productos, (p) => p.subcategoria?.subcategoria),
    modo: 'basico',
  };
}

function buscar(opciones = {}) {
  return conRespaldo(() => busquedaService.buscar(opciones), () => buscarEnCatalogo(opciones), 'elasticsearch');
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
