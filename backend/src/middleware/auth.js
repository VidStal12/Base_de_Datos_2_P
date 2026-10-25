const jwt = require('jsonwebtoken');
const { CODIGO_CUENTA_SUSPENDIDA, exigirCuentaActiva } = require('../services/suspensionService');
const politica = require('../services/politicaAccesoService');
const auditoria = require('../services/auditoriaAccesoService');
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

const CODIGO_DENEGADO = 'ACL_DENEGADO';

// La clave de la ruta en la lista blanca (config/politicaRutas.js): «GET /api/admin/ventas». Sale de cómo se montó
// el router, así que ninguna ruta repite su propio nombre; tests/accesoRutas.test.js prueba que coincide con lo declarado.
function claveDeLaRuta(req) {
  const metodo = req.method === 'HEAD' ? 'GET' : req.method; // Express contesta un HEAD con el manejador del GET
  const trozo = req.route?.path ?? req.path;
  return `${metodo} ${req.baseUrl}${trozo === '/' ? '' : trozo}`; // router.post('/') de /api/productos es «POST /api/productos»
}

// Requiere requireAuth antes en la cadena. `rolesPermitidos` es lo que declara el CÓDIGO para la ruta (la lista
// blanca); un administrador puede ajustar desde /admin/permisos qué roles entran a las rutas declaradas editables
// (services/politicaAccesoService.js, que decide con el rol de HOY de la cuenta, no con el del token). Lo que se
// deniega queda en el registro de auditoría.
function requireRole(...rolesPermitidos) {
  const middleware = async (req, res, next) => {
    if (!req.usuario) return res.status(403).json({ error: 'No tenés permiso para esta acción', codigo: CODIGO_DENEGADO });
    const ruta = claveDeLaRuta(req);
    let decision;
    try {
      decision = await politica.permite(req.usuario, ruta, rolesPermitidos);
    } catch (err) {
      return next(err);
    }
    if (!decision.permitido) {
      auditoria.registrarDenegacion(req.usuario, ruta, decision.rol);
      return res.status(403).json({ error: 'No tenés permiso para esta acción', codigo: CODIGO_DENEGADO });
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

module.exports = { requireAuth, requireRole, optionalAuth, CODIGO_DENEGADO, claveDeLaRuta };
