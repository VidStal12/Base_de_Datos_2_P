const { createHash } = require('node:crypto');

// Cuentas de servicio de Redis — la LISTA BLANCA de IA/PLAN-ENTREGA-FINAL.md §4.0 y §4.2.
//
// Cada módulo del backend entra a Redis con su propia cuenta, y cada cuenta parte de «nada»
// (-@all, sin llaves, sin canales) y solo suma los comandos y las llaves de ese módulo. El usuario
// `default` queda apagado. Así un bug, un script mal escrito o una credencial filtrada de un módulo
// no toca las llaves de otro: el carrito no puede levantar una suspensión, la revisión de sesión no
// puede escribir, y nadie sale de aquí con FLUSHALL, KEYS o CONFIG.
//
// Este archivo es la única fuente de la verdad: config/redis.js lo usa para conectar, y
// scripts/seguridad/inicializar.js lo vuelca en docker/redis/users.acl (el archivo que lee Redis).
// Para sumar una llave o un comando a un módulo se edita AQUÍ y se vuelve a correr
// `npm run seguridad:inicializar`.
//
// `comandos` incluye los que corren DENTRO de los scripts Lua de config/redis.js: Redis comprueba cada
// redis.call() contra los permisos de quien llamó al script, así que un script no abre más puertas que
// la propia cuenta. `llaves` usa la sintaxis de Redis: `~patron` lectura y escritura, `%R~patron` solo lectura.
//
// `pruebas` es la matriz que corre `npm run verificar:acceso`: lo permitido se comprueba con ACL DRYRUN
// (sin ejecutarlo: no toca datos) y lo negado se ejecuta de verdad y tiene que responder NOPERM.

const CUENTAS = {
  candados_r: {
    uso: 'Leer si una cuenta está suspendida o bajo vigilancia (middleware de autenticación, control de pedidos y paneles). No puede poner ni levantar un candado.',
    modulos: ['services/candadoRedis (estado, restantes, usuarios)'],
    llaves: ['%R~bloqueo:*', '%R~restriccion:*'],
    comandos: ['pttl', 'scan'],
    pruebas: {
      permitido: [['PTTL', 'bloqueo:7'], ['PTTL', 'restriccion:7'], ['SCAN', '0']],
      negado: [['DEL', 'bloqueo:7'], ['SET', 'bloqueo:7', 'x'], ['PTTL', 'carrito:7'], ['GET', 'bloqueo:7'], ['FLUSHALL']],
    },
  },
  candados_w: {
    uso: 'Poner y levantar candados de cuenta (suspensión por fraude y límites suaves). No toca ninguna otra familia de llaves.',
    modulos: ['services/candadoRedis (bloquear, levantar)'],
    llaves: ['~bloqueo:*', '~restriccion:*'],
    comandos: ['pttl', 'set', 'del', 'eval', 'evalsha'],
    pruebas: {
      permitido: [['DEL', 'bloqueo:7'], ['SET', 'restriccion:7', 'x'], ['PTTL', 'bloqueo:7']],
      negado: [['GET', 'carrito:1'], ['DEL', 'carrito:1'], ['SET', 'oferta:1:stock', '9'], ['SCAN', '0'], ['EVAL', "return redis.call('GET','carrito:1')", '0']],
    },
  },
  carrito: {
    uso: 'Copia del carrito en Redis (leer, publicar e invalidar con scripts atómicos).',
    modulos: ['services/cartService'],
    llaves: ['~carrito:*'],
    comandos: ['eval', 'evalsha', 'hgetall', 'hset', 'get', 'del', 'incr', 'expire'],
    pruebas: {
      permitido: [['HGETALL', 'carrito:7'], ['INCR', 'carrito:7:revision'], ['DEL', 'carrito:7']],
      negado: [['GET', 'bloqueo:7'], ['DEL', 'bloqueo:7'], ['KEYS', '*'], ['FLUSHALL'], ['INFO'], ['CONFIG', 'GET', '*'], ['SCAN', '0'], ['EVAL', "return redis.call('GET','bloqueo:7')", '0']],
    },
  },
  ofertas: {
    uso: 'Ofertas flash: datos y revisión de la oferta, contador de stock y reserva de cada intento de compra.',
    modulos: ['services/ofertaDatosService', 'services/ofertaFlashService', 'services/checkoutIntentoService'],
    llaves: ['~oferta:*', '~checkout:reserva:*'],
    comandos: ['eval', 'evalsha', 'get', 'set', 'del', 'exists', 'incr', 'incrby', 'decrby', 'expire', 'hget', 'hset', 'hgetall', 'type', 'time'],
    pruebas: {
      permitido: [['GET', 'oferta:7:stock'], ['DECRBY', 'oferta:7:stock:abc', '1'], ['HSET', 'checkout:reserva:xyz', 'estado', 'reservada']],
      negado: [['SET', 'bloqueo:7', 'x'], ['GET', 'carrito:7'], ['GET', 'oferta-recomendada:1:7:stock'], ['KEYS', '*'], ['FLUSHALL']],
    },
  },
  cupos: {
    uso: 'Topes por ventana de tiempo: pedidos por hora de una cuenta e intentos de contraseña al reautenticar.',
    modulos: ['services/limitePedidosService', 'services/reautenticacionService'],
    llaves: ['~limite:pedidos:*', '~reauth:intentos:*'],
    comandos: ['eval', 'evalsha', 'get', 'del', 'incr', 'decr', 'expire', 'ttl'],
    pruebas: {
      permitido: [['INCR', 'limite:pedidos:7'], ['DEL', 'reauth:intentos:7'], ['TTL', 'limite:pedidos:7']],
      negado: [['GET', 'bloqueo:7'], ['DEL', 'bloqueo:7'], ['SET', 'limite:pedidos:7', '0'], ['GET', 'carrito:7'], ['FLUSHALL']],
    },
  },
  recomendaciones: {
    uso: 'Caché de las recomendaciones de compra de una persona y su cupo personal para comprarlas.',
    modulos: ['services/tendenciaService'],
    llaves: ['~recomendaciones:*', '~oferta-recomendada:*'],
    comandos: ['eval', 'evalsha', 'get', 'set', 'exists', 'expire', 'incrby', 'decrby'],
    pruebas: {
      permitido: [['GET', 'recomendaciones:7'], ['SET', 'recomendaciones:7', 'x'], ['INCRBY', 'oferta-recomendada:1:7:stock', '1']],
      negado: [['GET', 'oferta:1:stock'], ['SET', 'bloqueo:7', 'x'], ['DEL', 'recomendaciones:7'], ['FLUSHALL']],
    },
  },
  actividad: {
    uso: 'Actividad reciente de una persona (últimas búsquedas y productos vistos) para sugerirle algo cuando una búsqueda no encuentra nada.',
    modulos: ['services/catalogoLecturaService (registrarActividad, obtenerUltimaActividad)'],
    llaves: ['~actividad:*'],
    comandos: ['lrange', 'lpush', 'lrem', 'ltrim', 'expire'],
    pruebas: {
      permitido: [['LRANGE', 'actividad:7', '0', '0'], ['LPUSH', 'actividad:7', '{}'], ['LTRIM', 'actividad:7', '0', '4']],
      negado: [['GET', 'carrito:7'], ['DEL', 'actividad:7'], ['LRANGE', 'bloqueo:7', '0', '0'], ['SET', 'actividad:7', 'x'], ['FLUSHALL']],
    },
  },
  salud: {
    uso: 'Comprobar que Redis responde (GET /api/health/componentes). No lee ni escribe ninguna llave.',
    modulos: ['services/estadoServiciosService'],
    llaves: [],
    comandos: ['ping'],
    pruebas: {
      permitido: [['PING']],
      negado: [['GET', 'carrito:7'], ['SET', 'x', '1'], ['KEYS', '*'], ['INFO']],
    },
  },
  admin: {
    uso: 'Scripts de mantenimiento y verificación (backend/scripts/*). El servidor web nunca la usa.',
    modulos: ['scripts/*'],
    todo: true,
    pruebas: {
      permitido: [['PING'], ['GET', 'carrito:7'], ['KEYS', '*'], ['ACL', 'WHOAMI']],
      negado: [],
    },
  },
};

const PREFIJO_USUARIO = 'rd_';
const usuarioDe = (cuenta) => `${PREFIJO_USUARIO}${cuenta}`;
const variableContrasena = (cuenta) => `REDIS_CONTRASENA_${cuenta.toUpperCase()}`;
const sha256 = (texto) => createHash('sha256').update(texto).digest('hex');

function definicion(cuenta) {
  const d = CUENTAS[cuenta];
  if (!d) throw new Error(`Cuenta de Redis desconocida: «${cuenta}». Las cuentas son: ${Object.keys(CUENTAS).join(', ')}.`);
  return d;
}

// Las reglas de la cuenta en la sintaxis de ACL SETUSER, SIN la contraseña. `resetkeys`, `resetchannels` y
// `-@all` borran cualquier permiso previo: la lista de abajo es todo lo que la cuenta puede hacer.
function reglas(cuenta) {
  const d = definicion(cuenta);
  if (d.todo) return ['on', 'allkeys', 'allchannels', '+@all'];
  return ['on', 'resetkeys', 'resetchannels', '-@all', ...d.comandos.map((c) => `+${c}`), ...d.llaves];
}

// Una línea del archivo de ACL de Redis. La contraseña va como hash (#<sha256>): el archivo no contiene
// ningún secreto que sirva para entrar.
function lineaAcl(cuenta, contrasena) {
  if (typeof contrasena !== 'string' || contrasena.length < 16) throw new Error(`La contraseña de ${usuarioDe(cuenta)} debe tener al menos 16 caracteres`);
  return ['user', usuarioDe(cuenta), `#${sha256(contrasena)}`, ...reglas(cuenta)].join(' ');
}

// El archivo completo (Redis no admite comentarios en él). El usuario `default` (sin contraseña y con
// todos los permisos) queda apagado.
function archivoAcl(contrasenas) {
  const lineas = ['user default off'];
  for (const cuenta of Object.keys(CUENTAS)) {
    const contrasena = contrasenas[cuenta];
    if (!contrasena) throw new Error(`Falta la contraseña de la cuenta «${cuenta}» (${variableContrasena(cuenta)})`);
    lineas.push(lineaAcl(cuenta, contrasena));
  }
  return `${lineas.join('\n')}\n`;
}

module.exports = { CUENTAS, usuarioDe, variableContrasena, reglas, lineaAcl, archivoAcl, definicion, sha256 };
