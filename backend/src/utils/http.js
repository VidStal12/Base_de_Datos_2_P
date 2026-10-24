const {
  ServicioNoDisponible,
  CODIGO_NO_DISPONIBLE,
  CODIGO_CREDENCIAL_RECHAZADA,
  MENSAJE_PUBLICO_CREDENCIAL,
  componenteCaido,
  esErrorDeAcceso,
  avisarCaida,
  avisarCredencial,
} = require('./resiliencia');

// Cuerpo JSON de un error de servicio. Casi todos los errores del proyecto son
// solo `{ error }`; los que el frontend tiene que distinguir de un mensaje suelto
// (p. ej. el compromiso de no reventa, ver compromisoService.js) llevan además un
// `codigo` estable.
//
// Una base apagada es el caso especial: el error crudo del driver trae rutas de
// archivo, nombres de tabla o direcciones internas (se vio: «Invalid
// `prisma.usuarios.findUnique()` invocation in C:\Users\…»), y no le sirve a nadie. Se
// reemplaza por un mensaje que dice QUÉ no está disponible, con el código estable
// SERVICIO_NO_DISPONIBLE y el componente para que la interfaz pueda reaccionar.
function cuerpoDeError(err) {
  // Una base que rechaza las credenciales del backend: ni el texto del error (nombra la cuenta, el comando y la
  // llave) ni qué base fue salen al cliente; el detalle queda en el log del servidor.
  if (esErrorDeAcceso(err)) return { error: MENSAJE_PUBLICO_CREDENCIAL, codigo: CODIGO_CREDENCIAL_RECHAZADA };
  const caido = componenteCaido(err);
  if (caido) {
    const aviso = err instanceof ServicioNoDisponible ? err : new ServicioNoDisponible(caido === 'desconocido' ? undefined : caido, err);
    return { error: aviso.message, codigo: CODIGO_NO_DISPONIBLE, componente: aviso.componente };
  }
  return err.codigo ? { error: err.message, codigo: err.codigo } : { error: err.message };
}

// El estado HTTP de un error: 503 si una base no responde (nunca 400/401/404/500, que
// hacían parecer "credenciales inválidas" o "producto inexistente" a una caída), el
// `status` que el servicio puso, o el que la ruta tenga por defecto.
function estadoDeError(err, porDefecto = 500) {
  // Un error de configuración del servidor es un 500 siempre: nunca el 400/401/404 que tenga la ruta por defecto
  // (hacía parecer «producto inexistente» o «credenciales inválidas» a una cuenta de servicio mal configurada).
  if (esErrorDeAcceso(err)) return 500;
  return componenteCaido(err) ? 503 : (err.status ?? porDefecto);
}

function responderError(res, err, porDefecto = 500) {
  const caido = componenteCaido(err);
  if (caido) avisarCaida(caido, err);
  const denegado = esErrorDeAcceso(err);
  if (denegado) avisarCredencial(denegado, err, err.cuenta);
  return res.status(estadoDeError(err, porDefecto)).json(cuerpoDeError(err));
}

// Último eslabón de Express 5: lo que una ruta deja escapar (un handler async sin
// try/catch) llega acá en vez de devolver la página de error por defecto, que en
// desarrollo incluye la traza completa.
function manejarErrores(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (!componenteCaido(err) && !esErrorDeAcceso(err) && !err.status) {
    console.error(`Error no controlado en ${req.method} ${req.originalUrl}:`, err.message);
    return res.status(500).json({ error: 'Ocurrió un error inesperado. Probá de nuevo en unos instantes.' });
  }
  return responderError(res, err, 500);
}

module.exports = { cuerpoDeError, estadoDeError, responderError, manejarErrores };
