const fs = require('node:fs/promises');
const path = require('node:path');
const { Client } = require('cassandra-driver');
const { ServicioNoDisponible, crearCircuito } = require('../utils/resiliencia');

let conexion;

// Cassandra solo alimenta el panel de ventas (las ventas viajan por el outbox de MySQL,
// ver ventasSyncService.js): apagada, el checkout no se entera. Aun así, que el panel
// y el worker lo descubran rápido: tras la primera falla de conexión, las demás llamadas
// fallan al instante durante unos segundos en vez de esperar cada una su connectTimeout.
const circuito = crearCircuito('cassandra', { aperturaMs: 5000 });

// La promesa compartida evita abrir varias conexiones si el panel y el worker
// consultan al mismo tiempo. Se elimina al fallar para permitir otro intento.
async function obtenerCliente() {
  if (!conexion) {
    conexion = circuito.ejecutar(() => conectar()).catch((error) => {
      conexion = undefined;
      throw error;
    });
    return conexion;
  }
  const cliente = await conexion;
  // El driver ya sabe que el nodo cayó (reconecta solo, con espera creciente): se
  // responde de inmediato en vez de dejar que cada consulta espere su readTimeout.
  if (cliente.getState().getConnectedHosts().length === 0) throw new ServicioNoDisponible('cassandra');
  return cliente;
}

async function conectar() {
  const keyspace = process.env.CASSANDRA_KEYSPACE || 'tiendaya_analytics';
  // El keyspace se interpola como identificador CQL, por eso no admite texto
  // arbitrario. Los valores de ventas se envían siempre como parámetros.
  if (!/^[a-z][a-z0-9_]{0,47}$/.test(keyspace)) {
    throw new Error('CASSANDRA_KEYSPACE debe tener 1–48 letras minúsculas, números o guiones bajos y comenzar con una letra');
  }
  const port = Number(process.env.CASSANDRA_PORT || 9042);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('CASSANDRA_PORT debe ser un puerto válido');
  }
  const localDataCenter = process.env.CASSANDRA_LOCAL_DATACENTER || 'datacenter1';
  const opciones = {
    contactPoints: (process.env.CASSANDRA_CONTACT_POINTS || '127.0.0.1')
      .split(',').map((punto) => punto.trim()).filter(Boolean),
    localDataCenter,
    protocolOptions: { port },
    socketOptions: { connectTimeout: 2000, readTimeout: 5000 },
    queryOptions: { prepare: true },
  };
  if (!opciones.contactPoints.length) {
    throw new Error('CASSANDRA_CONTACT_POINTS necesita al menos un servidor');
  }

  // Primero se conecta sin keyspace porque puede no existir en un volumen
  // nuevo. El archivo CQL es la única definición del esquema para Docker y Node.
  const inicializador = new Client(opciones);
  try {
    await inicializador.connect();
    const ruta = path.resolve(__dirname, '../../../docker/cassandra-init/01-schema.cql');
    const esquema = (await fs.readFile(ruta, 'utf8'))
      .replace(/--[^\n]*/g, '')
      .replace(/\btiendaya_analytics\b/g, keyspace)
      .replace(/'datacenter1'/g, () => `'${localDataCenter.replace(/'/g, "''")}'`);
    for (const sentencia of esquema.split(';').map((parte) => parte.trim()).filter(Boolean)) {
      await inicializador.execute(sentencia, [], { prepare: false });
    }
  } finally {
    await inicializador.shutdown();
  }

  // El cliente de consultas ya nace con su keyspace: ningún servicio necesita
  // ejecutar USE ni incluir el nombre configurable en cada sentencia.
  const cliente = new Client({ ...opciones, keyspace });
  try {
    await cliente.connect();
    return cliente;
  } catch (error) {
    await cliente.shutdown();
    throw error;
  }
}

// Se usa al detener HTTP o finalizar el script para liberar los sockets.
async function cerrar() {
  const pendiente = conexion;
  conexion = undefined;
  if (pendiente) {
    const cliente = await pendiente.catch(() => null);
    if (cliente) await cliente.shutdown();
  }
}

module.exports = { obtenerCliente, cerrar, circuito };
