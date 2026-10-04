// Cuerpo JSON de un error de servicio. Casi todos los errores del proyecto son
// solo `{ error }`; los que el frontend tiene que distinguir de un mensaje suelto
// (p. ej. el compromiso de no reventa, ver compromisoService.js) llevan además un
// `codigo` estable.
function cuerpoDeError(err) {
  return err.codigo ? { error: err.message, codigo: err.codigo } : { error: err.message };
}

module.exports = { cuerpoDeError };
