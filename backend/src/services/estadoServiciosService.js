const mongoose = require('mongoose');
const prisma = require('../config/prisma');
const { conectar: conectarMongo } = require('../config/mongo');
const { conectar: conectarRedis } = require('../config/redis');
const { conCircuito } = require('../config/elasticsearch');
const neo4j = require('../config/neo4j');
const cassandra = require('../config/cassandra');
const { esErrorDeAcceso } = require('../utils/resiliencia');

// Qué base responde AHORA (GET /api/health/componentes). Existe para que la interfaz pueda
// decirle a la persona «hoy no hay ofertas flash» en vez de dejarla descubrirlo por
// un error, y para que quien apague un contenedor de Docker vea al instante cómo lo
// toma la aplicación. Cada comprobación es un ping barato por el MISMO camino que usa el
// código real (el cliente, el cortacircuitos), con un tope de tiempo propio: una base
// colgada no puede colgar este endpoint.
const TOPE_MS = 1500;
const VIGENCIA_MS = 2000;

const COMPROBACIONES = {
  mysql: async () => {
    await prisma.$queryRaw`SELECT 1`;
  },
  mongo: async () => {
    await conectarMongo();
    await mongoose.connection.db.admin().ping();
    // `ping` no pide autenticación: sin esta lectura la salud diría «ok» con un catálogo que responde 500 porque Mongo
    // rechaza a la cuenta del servidor. Una lectura mínima de su propia base comprueba también que tiene permiso.
    await mongoose.connection.db.collection('categorias').findOne({}, { projection: { _id: 1 } });
  },
  redis: async () => {
    await conectarRedis('salud').ping();
  },
  elasticsearch: async () => {
    const vivo = await conCircuito((cliente) => cliente.ping());
    if (vivo === false) throw new Error('Elasticsearch no respondió al ping');
  },
  neo4j: async () => {
    await neo4j.leer('RETURN 1');
  },
  cassandra: async () => {
    const cliente = await cassandra.obtenerCliente();
    await cliente.execute('SELECT release_version FROM system.local');
  },
};

function conTope(promesa, ms) {
  let temporizador;
  const tope = new Promise((_, rechazar) => {
    temporizador = setTimeout(() => rechazar(new Error(`sin respuesta en ${ms} ms`)), ms);
  });
  return Promise.race([promesa, tope]).finally(() => clearTimeout(temporizador));
}

async function comprobar(nombre, comprobacion) {
  const inicio = Date.now();
  try {
    await conTope(comprobacion(), TOPE_MS);
    return [nombre, { ok: true, ms: Date.now() - inicio }];
  } catch (err) {
    // `credencial: true` distingue «responde pero me rechaza» de «no responde» (solo lo ve un administrador).
    return [nombre, {
      ok: false,
      ms: Date.now() - inicio,
      error: String(err?.cause?.message || err?.message || err).split('\n')[0].slice(0, 160),
      ...(esErrorDeAcceso(err) && { credencial: true }),
    }];
  }
}

// «critico»: sin MySQL no hay cuentas ni pedidos, y sin Mongo ni el índice no hay catálogo.
// «degradado»: falta algo, pero comprar y vender sigue siendo posible.
// «completo»: todo responde.
function resumir(componentes) {
  const caidos = Object.entries(componentes).filter(([, c]) => !c.ok).map(([nombre]) => nombre);
  if (caidos.length === 0) return 'completo';
  const catalogoPerdido = caidos.includes('mongo') && caidos.includes('elasticsearch');
  return caidos.includes('mysql') || catalogoPerdido ? 'critico' : 'degradado';
}

// Lo que ve cualquiera que consulte la salud (la franja de AvisoServicios no inicia sesión): solo si cada
// base responde. Los milisegundos y, sobre todo, el texto del error del driver pueden traer direcciones
// internas, nombres de usuario o rutas de archivo; eso se lo queda un administrador (saludRoutes.js).
function paraPublico({ estado, componentes, consultadoEn }) {
  return {
    estado,
    componentes: Object.fromEntries(Object.entries(componentes).map(([nombre, { ok }]) => [nombre, { ok }])),
    consultadoEn,
  };
}

let reciente = null;
let enCurso = null;

async function consultar({ comprobaciones = COMPROBACIONES, ahora = Date.now } = {}) {
  if (reciente && ahora() - reciente.en < VIGENCIA_MS) return reciente.valor;
  if (!enCurso) {
    enCurso = Promise.all(Object.entries(comprobaciones).map(([nombre, fn]) => comprobar(nombre, fn)))
      .then((pares) => {
        const componentes = Object.fromEntries(pares);
        const valor = { estado: resumir(componentes), componentes, consultadoEn: new Date().toISOString() };
        reciente = { en: ahora(), valor };
        return valor;
      })
      .finally(() => {
        enCurso = null;
      });
  }
  return enCurso;
}

module.exports = { consultar, resumir, paraPublico, COMPROBACIONES };
