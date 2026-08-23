const mongoose = require('mongoose');

let conexion;

// Conexión perezosa y reutilizada — se abre una sola vez, la primera vez que
// algún servicio la necesita, en vez de al arrancar el proceso.
function conectar() {
  if (!conexion) {
    conexion = mongoose.connect(process.env.MONGO_URI);
  }
  return conexion;
}

module.exports = { conectar };
