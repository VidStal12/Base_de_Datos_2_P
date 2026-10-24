const jwt = require('jsonwebtoken');
const { CODIGO_CUENTA_SUSPENDIDA, exigirCuentaActiva } = require('../services/suspensionService');
const { esErrorDeAcceso, registrarFallo } = require('../utils/resiliencia');

// Valida el token Y que la cuenta no esté suspendida (bloqueo temporal por fraude
// de confianza alta, ver suspensionService.js): una sola consulta a Redis por
// petición. Un token emitido antes de la suspensión deja de servir en la misma
// petición siguiente, sin esperar a que venza.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Token no proporcionado' });
  }

  let usuario;
  try {
    usuario = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }

  try {
    await exigirCuentaActiva(usuario.id_usuario, usuario.rol);
  } catch (err) {
    if (err.codigo === CODIGO_CUENTA_SUSPENDIDA) {
      return res.status(403).json({ error: err.message, codigo: err.codigo, hasta: err.hasta });
    }
    return next(err);
  }

  req.usuario = usuario;
  next();
}

// Requiere requireAuth antes en la cadena (usa req.usuario.rol, que viene del token).
function requireRole(...rolesPermitidos) {
  const middleware = (req, res, next) => {
    if (!req.usuario || !rolesPermitidos.includes(req.usuario.rol)) {
      return res.status(403).json({ error: 'No tenés permiso para esta acción' });
    }
    next();
  };
  middleware.acceso = { roles: [...rolesPermitidos] };
  return middleware;
}

// Como requireAuth, pero no rechaza si falta o es inválido el token — lo
// intenta parsear y listo, req.usuario queda undefined en vez de cortar la
// respuesta. Para rutas públicas que igual quieren saber quién pregunta
// CUANDO hay sesión (p. ej. mostrarle a un vendedor sus propios productos
// inactivos en el catálogo, sin exigirle login a todo el mundo que navega).
// Una cuenta suspendida se trata como si no hubiera sesión: sigue viendo el
// catálogo público, pero no lo que solo ve su dueño.
async function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme === 'Bearer' && token) {
    try {
      const usuario = jwt.verify(token, process.env.JWT_SECRET);
      await exigirCuentaActiva(usuario.id_usuario, usuario.rol);
      req.usuario = usuario;
    } catch (err) {
      // Token inválido/expirado, o cuenta suspendida, en una ruta pública: se
      // ignora, no se rechaza. Una Redis que rechaza a la cuenta de servicio es otra cosa: la persona queda
      // como anónima (nunca como sesión sin revisar), pero el error de configuración se anota.
      if (esErrorDeAcceso(err)) registrarFallo('No se pudo comprobar si la cuenta está suspendida', err);
    }
  }
  next();
}

// Etiquetas que lee tests/accesoRutas.test.js para saber, sin ejecutar nada, qué exige cada ruta
// del router real y compararlo con config/politicaRutas.js (la lista blanca de la API).
requireAuth.acceso = { sesion: true };
optionalAuth.acceso = { sesionOpcional: true };

module.exports = { requireAuth, requireRole, optionalAuth };
