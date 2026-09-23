const { Client } = require('@elastic/elasticsearch');

let cliente;

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
async function conectar() {
  if (!cliente) {
    cliente = new Client({ node: process.env.ELASTICSEARCH_URL || 'http://localhost:9200' });
    const existe = await cliente.indices.exists({ index: INDICE });
    if (!existe) {
      await cliente.indices.create({ index: INDICE, mappings: MAPPING });
    } else {
      await cliente.indices.putMapping({ index: INDICE, ...MAPPING });
    }
  }
  return cliente;
}

function indice() {
  return INDICE;
}

async function cerrar() {
  if (cliente) {
    await cliente.close();
    cliente = undefined;
  }
}

module.exports = { conectar, indice, cerrar, MAPPING };
