const neo4j = require('neo4j-driver');
const { crearCircuito } = require('../utils/resiliencia');

let driver;

// El grafo es una copia derivada para detectar fraude: sin él se compra y se vende igual
// (el reenvío es de mejor esfuerzo y se recupera con `npm run fraude:backfill`). Con los
// tiempos por defecto del driver, un Neo4j apagado hacía esperar hasta 30 s por consulta
// (reintentos de la transacción) — y como el checkout espera ese reenvío antes de
// responder, una compra tardaba 31 s. Medido con el contenedor realmente detenido.
// maxTransactionRetryTime: el driver reintenta una transacción fallida con esperas de 1 s,
// 2 s…; con 500 ms no hay reintento (la primera espera ya lo excede) y una caída se detecta
// en lo que tarda el primer intento — en una instancia única no hay otro nodo al que mudarse.
const OPCIONES_DRIVER = {
  connectionTimeout: 1500,
  connectionAcquisitionTimeout: 2000,
  maxTransactionRetryTime: 500,
};

// Tras la primera falla, durante unos segundos las demás llamadas fallan al instante.
const circuito = crearCircuito('neo4j', { aperturaMs: 5000 });

// Conexión perezosa y reutilizada, mismo patrón que config/redis.js/
// config/cassandra.js — se abre una sola vez, la primera vez que algún
// servicio la necesita.
function conectar() {
  if (!driver) {
    driver = neo4j.driver(
      process.env.NEO4J_URI || 'bolt://localhost:7687',
      neo4j.auth.basic(process.env.NEO4J_USER || 'neo4j', process.env.NEO4J_PASSWORD || 'tiendaya_dev'),
      OPCIONES_DRIVER
    );
  }
  return driver;
}

// Corre una escritura (MERGE, etc.) en una sesión propia, cerrada al
// terminar — evita que cada servicio tenga que acordarse de abrir/cerrar su
// propia sesión. `parametros` siempre como objeto con valores primitivos, no
// interpolados en la consulta — mismo criterio que Prisma/Mongoose acá.
async function escribir(consulta, parametros = {}) {
  return circuito.ejecutar(async () => {
    const sesion = conectar().session();
    try {
      await sesion.executeWrite((tx) => tx.run(consulta, parametros));
    } finally {
      await sesion.close();
    }
  });
}

async function leer(consulta, parametros = {}) {
  return circuito.ejecutar(async () => {
    const sesion = conectar().session();
    try {
      const resultado = await sesion.executeRead((tx) => tx.run(consulta, parametros));
      return resultado.records;
    } finally {
      await sesion.close();
    }
  });
}

// Restricciones de unicidad de los nodos compartidos que une el antifraude por dispositivo (ver
// fraudeSyncService.registrarDispositivo): sin ellas, dos MERGE simultáneos del mismo hash pueden crear dos nodos.
// `IF NOT EXISTS` las hace idempotentes; una restricción además crea el índice por la propiedad, así buscar un
// dispositivo por su hash no recorre todos los nodos. Se aplican una vez por proceso, antes de la primera
// escritura que las necesita (mismo criterio que config/cassandra.js y config/elasticsearch.js: el esquema se
// aplica en el primer uso, no en un paso manual aparte que alguien se pueda olvidar de correr).
let esquema;
function asegurarEsquema() {
  if (!esquema) {
    esquema = (async () => {
      await escribir('CREATE CONSTRAINT dispositivo_hash_unico IF NOT EXISTS FOR (n:Dispositivo) REQUIRE n.hash IS UNIQUE');
      await escribir('CREATE CONSTRAINT perfil_hash_unico IF NOT EXISTS FOR (n:Perfil) REQUIRE n.hash IS UNIQUE');
    })().catch((err) => {
      esquema = undefined; // con Neo4j apagado se vuelve a intentar en la próxima escritura
      throw err;
    });
  }
  return esquema;
}

// Se usa al detener el backend o finalizar un script — mismo criterio que
// redis.cerrar()/cassandra.cerrar().
async function cerrar() {
  if (driver) {
    await driver.close();
    driver = undefined;
  }
  esquema = undefined;
}

module.exports = { conectar, escribir, leer, asegurarEsquema, cerrar, circuito };
