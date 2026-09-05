const fs = require('node:fs/promises');
const path = require('node:path');
const { Client } = require('cassandra-driver');

let conexion;

// La promesa compartida evita abrir varias conexiones si el panel y el worker
// consultan al mismo tiempo. Se elimina al fallar para permitir otro intento.
async function obtenerCliente() {
  if (!conexion) {
    conexion = conectar().catch((error) => {
      conexion = undefined;
      throw error;
    });
  }
  return conexion;
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
    socketOptions: { connectTimeout: 5000, readTimeout: 10000 },
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

module.exports = { obtenerCliente, cerrar };
