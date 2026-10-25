const { Client } = require('@elastic/elasticsearch');
const { crearCircuito } = require('../utils/resiliencia');
const { DIMENSION } = require('./embeddingsModelo');

let cliente;
let preparacion;

// Elasticsearch es el índice de búsqueda: apagado, el catálogo sigue (la búsqueda cae a
// Mongo, ver busquedaService.js). Con los valores por defecto del cliente (3 reintentos),
// una búsqueda tardaba 7-9 s en rendirse. Tras la primera falla de conexión, las demás
// llamadas fallan al instante durante unos segundos (ver utils/resiliencia.js).
const circuito = crearCircuito('elasticsearch', { aperturaMs: 5000 });

const INDICE = process.env.ELASTICSEARCH_INDICE || 'tiendaya_productos';

// Mapping definido a propósito (ver IA/PLAN-ELASTICSEARCH-BUSQUEDA.md §6) —
// nunca configuración por defecto, es un requerimiento técnico explícito.
// atributos como `nested` (no un array de objetos plano): sin eso, un
// filtro por {nombre, valor} podría calzar cruzando el nombre de un
// atributo con el valor de OTRO atributo distinto del mismo producto —
// mismo motivo por el que condicionesAtributos() usa $elemMatch en Mongo
// (ver productoService.js). imagen_url: index:false — se guarda para
// mostrarla en los resultados, nunca se busca ni se agrega por ella.
const MAPPING = {
  // 'strict': un campo que aDocumento() agregue sin declararlo acá FALLA al
  // indexar (strict_dynamic_mapping_exception) en vez de que Elasticsearch le
  // adivine el tipo. Con el valor por defecto (true) un campo olvidado quedaba
  // como `text` con el analizador estándar (sin español), y uno mal escrito
  // (precioo) creaba un campo nuevo sin avisar: el producto desaparecía de los
  // filtros de precio sin ningún error. Aplica también a los objetos internos
  // (atributos). OJO: indexarProducto() solo registra el error (mejor
  // esfuerzo), así que un campo olvidado dejaría el producto SIN indexar —
  // tests/busquedaMapping.test.js (npm run test:busqueda) es lo que obliga a
  // que aDocumento() y este mapping se mantengan alineados.
  dynamic: 'strict',
  properties: {
    producto_id: { type: 'integer' },
    descripcion: {
      type: 'text',
      analyzer: 'spanish',
      fields: { keyword: { type: 'keyword', ignore_above: 256 } },
    },
    vendedor_nombre: {
      type: 'text',
      analyzer: 'spanish',
      fields: { keyword: { type: 'keyword', ignore_above: 256 } },
    },
    imagen_url: { type: 'keyword', index: false },
    categoria: { type: 'keyword' },
    subcategoria: { type: 'keyword' },
    categoria_id: { type: 'keyword' },
    subcategoria_id: { type: 'keyword' },
    atributos: {
      type: 'nested',
      properties: {
        nombre: { type: 'keyword' },
        valor: { type: 'keyword' },
      },
    },
    precio: { type: 'float' },
    cantidad: { type: 'integer' },
    estado: { type: 'keyword' },
    total_vendido: { type: 'integer' },
    // Solo para que los resultados de búsqueda sepan de quién es cada producto
    // (la tarjeta oculta "Agregar al carrito" en los propios, ver
    // productoService.verificarNoEsPropio) — nunca se busca ni se agrega por él.
    vendedor_id: { type: 'integer' },
    // Autocompletado (ver IA/PLAN-ELASTICSEARCH-BUSQUEDA.md §4, "se puede
    // agregar después sin tocar lo de acá") — tipo `completion`, no
    // `edge_ngram`: es el campo pensado específicamente para typeahead (FST
    // interno optimizado para prefijos) y soporta `fuzzy` de forma nativa,
    // mismo criterio de tolerancia a errores que ya usa la búsqueda de texto.
    // `contexts: estado` — sin esto, un producto inactivo seguiría
    // sugiriéndose (se indexa igual, ver busquedaSyncService.js) aunque
    // buscar() ya lo filtre de los resultados reales: la sugerencia llevaría
    // a una búsqueda con cero resultados. El contexto deja filtrar por
    // estado:activo en la propia consulta de sugerencias, no después.
    sugerencia: {
      type: 'completion',
      contexts: [{ name: 'estado', type: 'category' }],
    },
    // Vector del producto para «productos parecidos» (ver IA/ADR-006-recomendacion-semantica-vectorial.md): lo calcula
    // embeddingService con el modelo local y solo vive acá, no hay otra copia en Mongo. Coseno sobre vectores
    // normalizados; el tipo de índice es el que Elasticsearch 8.15 usa por defecto (int8_hnsw). Un `index` completo
    // del documento SIN este campo lo borra, por eso busquedaSyncService.indexarProducto() actualiza en vez de
    // reemplazar cuando el modelo no está; y toda consulta que no lo necesite lo excluye de _source (ver
    // SIN_VECTOR en busquedaService.js): con él, la misma respuesta pesa 13 veces más.
    embedding: { type: 'dense_vector', dims: DIMENSION, index: true, similarity: 'cosine' },
  },
};

// Conexión perezosa y reutilizada, mismo patrón que config/neo4j.js/config/
// redis.js. Crea el índice con el mapping explícito si todavía no existe —
// mismo criterio que config/cassandra.js (aplicar el esquema en la primera
// conexión, no un paso manual aparte que alguien se pueda olvidar de correr).
// putMapping corre SIEMPRE, exista o no el índice: agregar un campo nuevo a
// un mapping ya aplicado es válido en Elasticsearch (a diferencia de
// cambiar el tipo de uno existente) y así este archivo se puede seguir
// ampliando sin necesitar borrar y recrear el índice a mano cada vez.
//
// La preparación (crear el índice / aplicar el mapping) se guarda como PROMESA y solo se
// conserva si termina bien: antes el cliente quedaba guardado antes de prepararlo, así que
// un primer uso con Elasticsearch apagado dejaba un cliente sin índice que ya nadie volvía
// a preparar, y dos primeros usos simultáneos se saltaban la preparación del otro.
function conectar() {
  if (!preparacion) {
    preparacion = circuito.ejecutar(async () => {
      const nuevo = new Client({
        node: process.env.ELASTICSEARCH_URL || 'http://localhost:9200',
        requestTimeout: 2000,
        maxRetries: 0,
      });
      try {
        const existe = await nuevo.indices.exists({ index: INDICE });
        if (!existe) {
          await nuevo.indices.create({ index: INDICE, mappings: MAPPING });
        } else {
          await nuevo.indices.putMapping({ index: INDICE, ...MAPPING });
        }
      } catch (err) {
        await nuevo.close().catch(() => {});
        throw err;
      }
      cliente = nuevo;
      return nuevo;
    }).catch((err) => {
      preparacion = undefined;
      throw err;
    });
  }
  return preparacion;
}

// Cada petición al motor pasa por acá: si Elasticsearch no responde, la primera falla abre
// el cortacircuitos y las siguientes no esperan. `operacion` recibe el cliente ya preparado.
function conCircuito(operacion) {
  return circuito.ejecutar(async () => operacion(await conectar()));
}

function indice() {
  return INDICE;
}

async function cerrar() {
  preparacion = undefined;
  if (cliente) {
    const abierto = cliente;
    cliente = undefined;
    await abierto.close();
  }
}

module.exports = { conectar, conCircuito, indice, cerrar, MAPPING, circuito };
