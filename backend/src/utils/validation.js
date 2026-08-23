const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function esCorreoValido(correo) {
  return typeof correo === 'string' && EMAIL_REGEX.test(correo);
}

// Longitud mínima en vez de reglas de complejidad (mayúscula/número/símbolo):
// las guías actuales (NIST SP 800-63B) priorizan longitud sobre complejidad,
// que en la práctica solo empuja a patrones predecibles ("Clave1!").
function validarPassword(contrasena) {
  if (typeof contrasena !== 'string' || contrasena.length < 8) {
    throw new Error('La contraseña debe tener al menos 8 caracteres');
  }
}

function esEnteroPositivo(valor) {
  return Number.isInteger(valor) && valor > 0;
}

module.exports = { esCorreoValido, validarPassword, esEnteroPositivo };
