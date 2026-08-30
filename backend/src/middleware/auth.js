const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Token no proporcionado' });
  }

  try {
    req.usuario = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

// Requiere requireAuth antes en la cadena (usa req.usuario.rol, que viene del token).
function requireRole(...rolesPermitidos) {
  return (req, res, next) => {
    if (!req.usuario || !rolesPermitidos.includes(req.usuario.rol)) {
      return res.status(403).json({ error: 'No tenés permiso para esta acción' });
    }
    next();
  };
}

// Como requireAuth, pero no rechaza si falta o es inválido el token — lo
// intenta parsear y listo, req.usuario queda undefined en vez de cortar la
// respuesta. Para rutas públicas que igual quieren saber quién pregunta
// CUANDO hay sesión (p. ej. mostrarle a un vendedor sus propios productos
// inactivos en el catálogo, sin exigirle login a todo el mundo que navega).
function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme === 'Bearer' && token) {
    try {
      req.usuario = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      // Token inválido/expirado en una ruta pública: se ignora, no se rechaza.
    }
  }
  next();
}

module.exports = { requireAuth, requireRole, optionalAuth };
