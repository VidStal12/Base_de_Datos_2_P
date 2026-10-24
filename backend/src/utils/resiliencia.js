// Resiliencia ante la caída de una base de datos (IA/ENTREGA-3-CONSISTENCIA.md §7).
//
// La aplicación tiene que seguir usable cuando se apaga uno o varios contenedores de
// Docker: lo que depende de esa base deja de estar disponible, el resto no se entera.
// Medido contra los contenedores reales, el problema de fondo NO era qué hacía el
// código al fallar (casi todo ya fallaba "abierto" o con un 503 explicado), sino CUÁNTO
// tardaba en enterarse: ioredis esperaba ~73 s por comando, Mongo 30 s, Neo4j 30 s,
// MySQL 10 s. Con Redis apagado hasta el catálogo público tardaba 108 s por petición.
//
// Este módulo concentra las tres piezas que hacen falta para fallar RÁPIDO y CLARO:
//   - ServicioNoDisponible: el error tipado (503) que los clientes de cada base lanzan.
//   - componenteCaido(): reconoce un fallo de conexión venga de donde venga (Prisma,
//     Mongoose, ioredis, neo4j-driver, cassandra-driver, Elasticsearch o un errno de
//     red), porque los servicios reciben el error CRUDO del driver.
//   - crearCircuito(): un cortacircuitos mínimo. La primera falla de conexión lo abre y,
//     durante unos segundos, las llamadas siguientes fallan al instante en vez de
//     esperar el timeout cada una; pasado ese tiempo se deja pasar una prueba.

const COMPONENTES = {
  mysql: { nombre: 'la base de datos principal (MySQL)', afecta: 'cuentas, carrito y pedidos' },
  mongo: { nombre: 'el catálogo (MongoDB)', afecta: 'detalle del catálogo, reseñas y edición de productos' },
  redis: { nombre: 'la caché (Redis)', afecta: 'ofertas flash y topes de pedidos' },
  elasticsearch: { nombre: 'el buscador (Elasticsearch)', afecta: 'búsqueda avanzada y autocompletado' },
  neo4j: { nombre: 'el grafo de fraude (Neo4j)', afecta: 'el panel de fraude' },
  cassandra: { nombre: 'la analítica de ventas (Cassandra)', afecta: 'el panel de ventas' },
};

const CODIGO_NO_DISPONIBLE = 'SERVICIO_NO_DISPONIBLE';

class ServicioNoDisponible extends Error {
  // `mensaje` (opcional) reemplaza el texto genérico cuando quien lanza sabe decir QUÉ
  // función se pierde («las ofertas flash necesitan Redis…») en vez de nombrar solo la base.
  constructor(componente, causa, mensaje) {
    const info = COMPONENTES[componente];
    super(
      mensaje ||
        (info
          ? `No se puede usar ${info.nombre} en este momento. Probá de nuevo en unos instantes.`
          : 'Un servicio del que depende esta acción no está disponible en este momento. Probá de nuevo en unos instantes.'),
      causa ? { cause: causa } : undefined
    );
    this.name = 'ServicioNoDisponible';
    this.status = 503;
    this.codigo = CODIGO_NO_DISPONIBLE;
    this.componente = componente || 'desconocido';
  }
}

const CODIGO_CREDENCIAL_RECHAZADA = 'CREDENCIAL_RECHAZADA';
const MENSAJE_PUBLICO_CREDENCIAL = 'El servidor no pudo autenticarse con uno de sus servicios (error de configuración). Avisá al equipo.';

// Una base que RESPONDE pero rechaza las credenciales del backend (contraseña vieja, una cuenta sin el
// permiso que el módulo necesita) NO está caída: reintentar no sirve, y esconderlo como «no responde» deja
// la aplicación funcionando a medias sin que nadie sepa por qué. Es un error de configuración: se dice una
// vez, con la cuenta y qué revisar, y los controles de seguridad que dependen de esa base fallan CERRADO
// (IA/PLAN-ENTREGA-FINAL.md §4.3). Nunca llega al cliente con su texto: ver utils/http.js.
class CredencialRechazada extends Error {
  constructor(componente, cuenta, causa) {
    super(
      `${COMPONENTES[componente]?.nombre ?? 'Un servicio'} rechazó las credenciales del backend${cuenta ? ` (cuenta ${cuenta})` : ''}. Revisá backend/.env y los permisos de esa cuenta.`,
      causa ? { cause: causa } : undefined
    );
    this.name = 'CredencialRechazada';
    this.status = 500;
    this.codigo = CODIGO_CREDENCIAL_RECHAZADA;
    this.componente = componente || 'desconocido';
    this.cuenta = cuenta ?? null;
  }
}

// Errores de red que no dicen QUÉ base se cayó (un ECONNREFUSED es un ECONNREFUSED).
const ERRNO_DE_RED = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNABORTED']);

// Cada regla mira el nombre del error, su código y su mensaje. El orden importa solo
// cuando un mismo texto podría casar con dos: la más específica va primero.
const REGLAS = [
  ['mysql', {
    nombres: /^PrismaClient(Initialization|RustPanic)Error$|^DriverAdapterError$/,
    codigos: /^P(1001|1002|1008|1017|2024|2028)$|^ER_(CON_COUNT_ERROR|SERVER_SHUTDOWN)$|^PROTOCOL_CONNECTION_LOST$/,
    mensajes: /Can't reach database server|Unable to start a transaction|Timed out fetching a new connection|retrieve connection from pool timeout|pool timeout|Server has closed the connection|Connection (lost|refused)|Pool (is )?closed/i,
  }],
  ['mongo', {
    nombres: /^Mongo(ose)?(ServerSelection|Network|NetworkTimeout|NotConnected|TopologyClosed|PoolCleared|ServerClosed)Error$/,
    codigos: /^$/,
    mensajes: /buffering timed out|Client must be connected|Topology is closed|connection pool .* cleared/i,
  }],
  ['redis', {
    nombres: /^(MaxRetriesPerRequestError|RedisNoDisponible)$/,
    codigos: /^REDIS_NO_DISPONIBLE$/,
    mensajes: /Command timed out|Connection is closed|Stream isn't writeable|Reached the max retries per request/i,
  }],
  ['neo4j', {
    nombres: /^Neo4jError$/,
    codigos: /^(ServiceUnavailable|SessionExpired|Neo\.ClientError\.Security\.AuthenticationRateLimit)$/,
    mensajes: /Pool is closed|acquisition timeout|Connection was closed by server|Failed to connect to server|Could not perform discovery/i,
  }],
  ['cassandra', {
    nombres: /^(NoHostAvailableError|OperationTimedOutError|BusyConnectionError)$/,
    codigos: /^$/,
    mensajes: /All host\(s\) tried for query failed|Host considered as DOWN/i,
  }],
  ['elasticsearch', {
    nombres: /^(ConnectionError|NoLivingConnectionsError|TimeoutError|RequestAbortedError)$/,
    codigos: /^$/,
    mensajes: /Could not connect to Elasticsearch|No Living connections/i,
  }],
];

// ¿Este error significa "una base no responde"? Devuelve el id del componente
// ('mysql', 'mongo'…), 'desconocido' si es un fallo de red sin pistas, o null si es otra
// cosa (un error de validación, un 404, un bug): esos NO se tratan como caída.
function componenteCaido(err) {
  if (!err || typeof err !== 'object') return null;
  if (err.codigo === CODIGO_NO_DISPONIBLE) return err.componente || 'desconocido';
  const nombre = String(err.name || '');
  const codigo = String(err.code || '');
  const mensaje = String(err.message || '');
  for (const [componente, regla] of REGLAS) {
    if (regla.nombres.test(nombre) || (codigo && regla.codigos.test(codigo)) || regla.mensajes.test(mensaje)) return componente;
  }
  // El driver suele envolver el errno de red (Prisma → DriverAdapterError → SqlError →
  // ECONNREFUSED): se revisa también la causa.
  if (ERRNO_DE_RED.has(codigo) || ERRNO_DE_RED.has(String(err.errno || ''))) return 'desconocido';
  if (err.cause && err.cause !== err) return componenteCaido(err.cause);
  return null;
}

// Cómo dice cada base «no tenés permiso» o «no sé quién sos». Las respuestas de Redis empiezan con su
// código (WRONGPASS, NOAUTH, NOPERM); dentro de un script Lua llegan como «ACL failure in script» o «The user
// executing the script can't…». Mongo responde con el código 13 (Unauthorized: «requires authentication» si no
// entraste, «not authorized on…» si entraste y no puedes) o el 18 (AuthenticationFailed). (Elasticsearch,
// Cassandra y Neo4j se suman al activar su autenticación.)
const REGLAS_ACCESO = [
  ['redis', { mensajes: /^(WRONGPASS|NOAUTH|NOPERM)\b|ACL failure in script|The user executing the script can't (run this command|access at least one of the keys)/ }],
  ['mongo', { mensajes: /^Authentication failed|requires authentication|not authorized on /, codeNames: ['Unauthorized', 'AuthenticationFailed'] }],
];

// ¿Este error significa «la base me rechaza» (credencial mala o cuenta sin permiso)? Devuelve el id del
// componente ('redis'…) o null. Es lo opuesto a componenteCaido(): un error de acceso NUNCA se trata como
// una caída (no hay circuito que abrir ni «se sigue sin él»).
function esErrorDeAcceso(err, profundidad = 0) {
  if (!err || typeof err !== 'object' || profundidad > 4) return null;
  if (err.codigo === CODIGO_CREDENCIAL_RECHAZADA) return err.componente || 'desconocido';
  const mensaje = String(err.message || '');
  for (const [componente, regla] of REGLAS_ACCESO) {
    if (regla.mensajes.test(mensaje) || regla.codeNames?.includes(err.codeName)) return componente;
  }
  if (err.cause && err.cause !== err) return esErrorDeAcceso(err.cause, profundidad + 1);
  return null;
}

// Cortacircuitos por componente. Solo los fallos de CONEXIÓN lo abren: un error de la
// consulta (un 400 del motor, una clave duplicada) significa que la base está arriba.
function crearCircuito(componente, { aperturaMs = 5000, ahora = Date.now } = {}) {
  let abiertoHasta = 0;
  let fallo = false;
  return {
    componente,
    abierto: () => ahora() < abiertoHasta,
    reiniciar() {
      abiertoHasta = 0;
      fallo = false;
    },
    async ejecutar(operacion) {
      if (ahora() < abiertoHasta) throw new ServicioNoDisponible(componente);
      try {
        const resultado = await operacion();
        abiertoHasta = 0;
        if (fallo) {
          fallo = false;
          avisarRecuperacion(componente);
        }
        return resultado;
      } catch (err) {
        if (componenteCaido(err)) {
          abiertoHasta = ahora() + aperturaMs;
          fallo = true;
          avisarCaida(componente, err);
          throw err instanceof ServicioNoDisponible ? err : new ServicioNoDisponible(componente, err);
        }
        throw err;
      }
    },
  };
}

// Una línea legible de por qué falló una base. Los errores de los drivers vienen con ruido que no
// ayuda en un log: Prisma antepone la RUTA del archivo y un recorte del código («Invalid
// `prisma.x.findMany()` invocation in C:\…»), y un ECONNREFUSED de Node 20+ llega como un
// AggregateError con el mensaje vacío (el dato está en `code` o en `errors[0]`).
function descripcionDe(err) {
  const candidatos = [err?.message, err?.code, err?.errors?.[0]?.message, err?.errors?.[0]?.code, err?.cause?.message, err?.cause?.code];
  const texto = candidatos.find((candidato) => typeof candidato === 'string' && candidato.trim()) || 'sin detalle';
  const lineas = texto.split('\n').map((linea) => linea.trim()).filter(Boolean);
  const ruido = /invocation in|^→|^\d+\s|[A-Za-z]:\\|\.js:\d+/;
  return (lineas.find((linea) => !ruido.test(linea)) || lineas[0] || 'sin detalle').slice(0, 200);
}

// Un log por componente cada `cadaMs`: una base caída no debe escribir una línea por
// petición (las vistas del catálogo hacen decenas por segundo).
const ultimoAviso = new Map();
function avisarCaida(componente, err, { cadaMs = 15000, ahora = Date.now() } = {}) {
  // Un rechazo de credenciales no es una caída: se dice como lo que es (con la cuenta, si se sabe).
  if (esErrorDeAcceso(err)) return avisarCredencial(componente, err, err?.cuenta, { cadaMs, ahora });
  const ultimo = ultimoAviso.get(componente) ?? 0;
  if (ahora - ultimo < cadaMs) return false;
  ultimoAviso.set(componente, ahora);
  console.error(`[resiliencia] ${componente} no responde (se sigue sin él): ${descripcionDe(err)}`);
  return true;
}

// Una línea por cuenta cada `cadaMs` cuando una base rechaza las credenciales del backend: sin ella el
// síntoma es «no funciona la caché» o, peor, un control de seguridad que se apagó solo.
const ARCHIVO_DE_CUENTAS = { redis: 'redisCuentas.js', mongo: 'mongoCuentas.js' };
const ultimoAvisoCredencial = new Map();
function avisarCredencial(componente, err, cuenta, { cadaMs = 15000, ahora = Date.now() } = {}) {
  // El motivo es el que dio la base (WRONGPASS, NOPERM…), no el texto de nuestro propio CredencialRechazada.
  const causa = err?.codigo === CODIGO_CREDENCIAL_RECHAZADA && err.cause ? err.cause : err;
  // La cuenta sale de quien avisa o, si no la sabe, del propio mensaje de Redis («User rd_cupos has no permissions…»).
  const quien = cuenta ?? err?.cuenta ?? /User (\S+) has no permissions/.exec(String(causa?.message))?.[1];
  const id = `${componente}:${quien ?? ''}`;
  const ultimo = ultimoAvisoCredencial.get(id) ?? 0;
  if (ahora - ultimo < cadaMs) return false;
  ultimoAvisoCredencial.set(id, ahora);
  const archivo = ARCHIVO_DE_CUENTAS[componente] ?? 'redisCuentas.js y mongoCuentas.js';
  console.error(`[acceso] ${componente} rechazó a la cuenta del backend${quien ? ` ${quien}` : ''}: ${descripcionDe(causa).replace(/[.\s]+$/, '')}. Revisá backend/.env y los permisos de esa cuenta en src/config/${archivo} (npm run seguridad:inicializar).`);
  return true;
}

// El registro de un fallo de un proceso en segundo plano (los barridos y el outbox corren cada
// 30-60 s): si es una base apagada, una línea cada 15 s por componente en vez del bloque
// completo del driver en cada vuelta; cualquier otro error se muestra entero, porque ESE sí
// puede ser un bug que hay que leer.
function registrarFallo(contexto, err) {
  const componente = componenteCaido(err);
  if (componente) return avisarCaida(componente, err);
  const denegado = esErrorDeAcceso(err);
  if (denegado) return avisarCredencial(denegado, err, err?.cuenta);
  console.error(`${contexto}:`, err?.message ?? err);
  return true;
}

// Cuando un componente que se había avisado como caído vuelve, queda una línea que lo dice
// (sin ella, el log terminaba en "no responde" y no se sabía si ya se había recuperado).
function avisarRecuperacion(componente) {
  if (!ultimoAviso.has(componente)) return false;
  ultimoAviso.delete(componente);
  console.log(`[resiliencia] ${componente} volvió a responder`);
  return true;
}

module.exports = {
  COMPONENTES,
  CODIGO_NO_DISPONIBLE,
  CODIGO_CREDENCIAL_RECHAZADA,
  MENSAJE_PUBLICO_CREDENCIAL,
  ServicioNoDisponible,
  CredencialRechazada,
  componenteCaido,
  esErrorDeAcceso,
  crearCircuito,
  descripcionDe,
  avisarCaida,
  avisarCredencial,
  avisarRecuperacion,
  registrarFallo,
};
