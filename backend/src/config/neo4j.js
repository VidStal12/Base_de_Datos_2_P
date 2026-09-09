const neo4j = require('neo4j-driver');

let driver;

// Conexión perezosa y reutilizada, mismo patrón que config/redis.js/
// config/cassandra.js — se abre una sola vez, la primera vez que algún
// servicio la necesita.
function conectar() {
  if (!driver) {
    driver = neo4j.driver(
      process.env.NEO4J_URI || 'bolt://localhost:7687',
      neo4j.auth.basic(process.env.NEO4J_USER || 'neo4j', process.env.NEO4J_PASSWORD || 'tiendaya_dev')
    );
  }
  return driver;
}

// Corre una escritura (MERGE, etc.) en una sesión propia, cerrada al
// terminar — evita que cada servicio tenga que acordarse de abrir/cerrar su
// propia sesión. `parametros` siempre como objeto con valores primitivos, no
// interpolados en la consulta — mismo criterio que Prisma/Mongoose acá.
async function escribir(consulta, parametros = {}) {
  const sesion = conectar().session();
  try {
    await sesion.executeWrite((tx) => tx.run(consulta, parametros));
  } finally {
    await sesion.close();
  }
}

async function leer(consulta, parametros = {}) {
  const sesion = conectar().session();
  try {
    const resultado = await sesion.executeRead((tx) => tx.run(consulta, parametros));
    return resultado.records;
  } finally {
    await sesion.close();
  }
}

// Se usa al detener el backend o finalizar un script — mismo criterio que
// redis.cerrar()/cassandra.cerrar().
async function cerrar() {
  if (driver) {
    await driver.close();
    driver = undefined;
  }
}

module.exports = { conectar, escribir, leer, cerrar };
