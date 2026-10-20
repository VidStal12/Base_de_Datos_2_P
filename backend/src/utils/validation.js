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

// Texto literal para usarlo dentro de una expresión regular (el texto lo escribe una persona
// en un buscador público: un `(` suelto o un patrón pesado no debe romper ni frenar la consulta).
function escaparRegex(texto) {
  return String(texto).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { esCorreoValido, validarPassword, esEnteroPositivo, escaparRegex };
