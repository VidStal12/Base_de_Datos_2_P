const Redis = require('ioredis');

let cliente;

// Conexión perezosa y reutilizada, mismo patrón que config/mongo.js — se abre
// una sola vez, la primera vez que algún servicio la necesita.
function conectar() {
  if (!cliente) {
    cliente = new Redis(process.env.REDIS_URL);
  }
  return cliente;
}

module.exports = { conectar };
