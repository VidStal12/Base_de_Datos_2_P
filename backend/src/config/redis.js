const Redis = require('ioredis');
const { ServicioNoDisponible, CredencialRechazada, esErrorDeAcceso, avisarCaida, avisarCredencial, avisarRecuperacion } = require('../utils/resiliencia');
const { definicion, usuarioDe, variableContrasena } = require('./redisCuentas');

// Un cliente por cuenta de servicio (ver redisCuentas.js): cada módulo del backend entra a Redis con la suya.
// Mientras Redis no tenga ACL (sin REDIS_CONTRASENA_* en el entorno) todas las cuentas comparten una única
// conexión «legada» sin credenciales, como antes de la Entrega Final.
const clientes = new Map();

// Redis es una caché y un puñado de contadores auxiliares (carrito, ofertas flash,
// bloqueos, topes de pedidos): sin él la aplicación sigue funcionando, solo que sin esos
// datos. Con los valores por defecto de ioredis NO era así — un Redis apagado dejaba cada
// comando esperando ~73 s (maxRetriesPerRequest 20 + reconexiones de 10 s), y como TODA
// petición autenticada consulta si la cuenta está suspendida, hasta el catálogo público
// tardaba ~108 s. Medido con el contenedor realmente detenido (IA/ENTREGA-3-CONSISTENCIA.md §7).
//   - commandTimeout: ningún comando espera más de esto por su respuesta (también los que
//     quedaron en la cola de espera de la conexión).
//   - maxRetriesPerRequest: la cola se descarta tras un solo reintento fallido.
//   - connectTimeout / retryStrategy: reconectar seguido, sin esperar 10 s por intento.
//   - enableReadyCheck / disableClientInfo: ioredis pregunta INFO y CLIENT SETINFO al conectar; una cuenta de
//     servicio no tiene (ni debe tener) esos comandos, y el rechazo ensuciaría el registro de ACL de Redis.
const OPCIONES_RESILIENTES = {
  commandTimeout: 1500,
  maxRetriesPerRequest: 1,
  connectTimeout: 2000,
  retryStrategy: (intento) => Math.min(intento * 250, 2000),
  enableReadyCheck: false,
  disableClientInfo: true,
};

// Tras un rechazo de credenciales no se insiste en bucle (cada reintento sería otro WRONGPASS): la cuenta queda
// «rechazada» y sus comandos fallan al instante con CredencialRechazada. Pasado este tiempo se prueba UNA vez
// más con un cliente nuevo, para que corregir el .env o recargar el ACL de Redis no exija reiniciar el backend.
const REINTENTO_CREDENCIAL_MS = 30000;

// Mientras el cliente está reconectando (la conexión ya se perdió), un comando nuevo
// falla AL INSTANTE en vez de esperar su commandTimeout: así una petición que toca Redis
// varias veces no suma 1,5 s por cada una. En 'connecting' (el primer arranque) sí se deja
// encolar, acotado por commandTimeout, porque Redis puede estar perfectamente sano.
class RedisTolerante extends Redis {
  sendCommand(comando, flujo) {
    if (this.credencialRechazada) {
      comando.reject(this.credencialRechazada);
      return comando.promise;
    }
    if (this.status === 'reconnecting' || this.status === 'end') {
      comando.reject(new ServicioNoDisponible('redis'));
      return comando.promise;
    }
    return super.sendCommand(comando, flujo);
  }
}

// Oferta flash (Entrega 2, ver IA/ENTREGA-2-PLAN.md §4.2): un único comando
// atómico que hace, en una sola ejecución de Redis (sin locks de aplicación,
// sin ventana entre "leer" y "decrementar" como tendría un DECR simple):
//   1) lazy-init si la clave todavía no existe — la siembra con el stock
//      inicial Y le pone TTL (la vigencia de la oferta, calculada por el
//      llamador a partir de vigente_hasta), en el mismo paso.
//   2) chequea si alcanza y descuenta, o rechaza, sin dejar nunca el
//      contador en negativo.
// KEYS[1] = clave (oferta:{productoId}:stock)
// ARGV[1] = stock inicial (para el lazy-init)
// ARGV[2] = TTL en segundos (para el lazy-init)
// ARGV[3] = cantidad pedida
// Devuelve el remanente (>= 0) si admite, o -1 si rechaza.
const LUA_DECREMENTAR_OFERTA = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  redis.call('SET', KEYS[1], ARGV[1])
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
local actual = tonumber(redis.call('GET', KEYS[1]))
local pedido = tonumber(ARGV[3])
if actual >= pedido then
  redis.call('DECRBY', KEYS[1], pedido)
  return actual - pedido
else
  return -1
end
`;

const LUA_REINTEGRAR_OFERTA = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return redis.call('INCRBY', KEYS[1], ARGV[1])
end
return 0
`;

// La reserva identificada permanece hasta después del fin de la oferta. Una
// respuesta perdida se puede repetir sin volver a descontar. El pool tiene una
// clave por revisión, así una devolución vieja nunca toca una oferta nueva.
const LUA_RESERVAR_OFERTA = `
local estado = redis.call('HGET', KEYS[2], 'estado')
if estado == 'reservada' then return 1 end
if estado == 'devuelta' then return -2 end
local ahora = tonumber(redis.call('TIME')[1])
local ttl = tonumber(ARGV[2]) - ahora
if ttl <= 0 then return -1 end
if redis.call('EXISTS', KEYS[1]) == 0 then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ttl)
end
local pedido = tonumber(ARGV[3])
local actual = tonumber(redis.call('GET', KEYS[1]))
if actual < pedido then return -1 end
redis.call('DECRBY', KEYS[1], pedido)
redis.call('HSET', KEYS[2], 'estado', 'reservada', 'cantidad', pedido)
redis.call('EXPIRE', KEYS[2], ttl + 86400)
return 1
`;
const LUA_DEVOLVER_RESERVA = `
local estado = redis.call('HGET', KEYS[2], 'estado')
if estado == 'devuelta' then return 0 end
if estado == 'reservada' and redis.call('EXISTS', KEYS[1]) == 1 then
  redis.call('INCRBY', KEYS[1], redis.call('HGET', KEYS[2], 'cantidad'))
end
-- También deja una tumba si la reserva nunca llegó: una llamada retrasada no
-- puede reservar después de que MySQL canceló el intento.
redis.call('HSET', KEYS[2], 'estado', 'devuelta')
local ahora = tonumber(redis.call('TIME')[1])
redis.call('EXPIRE', KEYS[2], math.max(86400, tonumber(ARGV[1]) - ahora + 86400))
return 1
`;

// La revisión evita que una lectura iniciada antes de una escritura/checkout
// vuelva a publicar cantidades anteriores. La marca permite cachear carritos vacíos.
const LUA_LEER_CARRITO = `
local contenido = redis.call('HGETALL', KEYS[1])
if #contenido > 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return {redis.call('GET', KEYS[2]) or '0', contenido}
`;
const LUA_PUBLICAR_CARRITO = `
if (redis.call('GET', KEYS[2]) or '0') ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], '_formato', '3')
local contenido = cjson.decode(ARGV[3])
for campo, valor in pairs(contenido) do redis.call('HSET', KEYS[1], campo, valor) end
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1
`;
const LUA_INVALIDAR_CARRITO = `
local revision = redis.call('INCR', KEYS[2])
redis.call('DEL', KEYS[1])
return revision
`;

// Datos de la oferta flash (`oferta:{id}:datos`) — mismo protocolo que el carrito
// (ver ofertaDatosService.js): un hash con su marca de formato, una revisión que
// evita publicar datos viejos, y una lectura que renueva el TTL. Dos diferencias
// pensadas para una oferta:
//   - el TTL deslizante NUNCA pasa del fin de la oferta: el hash guarda `vence_en`
//     (epoch en segundos) y la lectura renueva a min(inactividad, vence_en - ahora).
//     Si ya pasó, la clave se borra y el lector regenera (y encuentra la oferta
//     vencida).
//   - una clave de un formato anterior (la oferta guardaba antes UNA CADENA JSON en
//     este mismo nombre) se descarta en vez de fallar con WRONGTYPE.
// KEYS[1] = datos, KEYS[2] = revisión. ARGV[1] = TTL por inactividad, ARGV[2] = ahora.
const LUA_LEER_OFERTA = `
local tipo = redis.call('TYPE', KEYS[1]).ok
if tipo ~= 'hash' and tipo ~= 'none' then redis.call('DEL', KEYS[1]) end
local contenido = redis.call('HGETALL', KEYS[1])
if #contenido > 0 then
  local ttl = tonumber(ARGV[1])
  local vence = tonumber(redis.call('HGET', KEYS[1], 'vence_en'))
  if vence and vence - tonumber(ARGV[2]) < ttl then ttl = vence - tonumber(ARGV[2]) end
  if ttl > 0 then
    redis.call('EXPIRE', KEYS[1], ttl)
  else
    redis.call('DEL', KEYS[1])
    contenido = {}
  end
end
return {redis.call('GET', KEYS[2]) or '0', contenido}
`;
// Solo publica si la revisión sigue siendo la que el lector vio ANTES de
// regenerar: una edición/pausa entre medio la incrementó, y publicar lo que se
// leyó antes la desharía. Devuelve 1 si publicó, 0 si no.
// ARGV[1] = revisión esperada, ARGV[2] = TTL, ARGV[3] = {campo: valor} en JSON,
// ARGV[4] = marca de formato.
const LUA_PUBLICAR_OFERTA = `
if (redis.call('GET', KEYS[2]) or '0') ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], '_formato', ARGV[4])
local contenido = cjson.decode(ARGV[3])
for campo, valor in pairs(contenido) do redis.call('HSET', KEYS[1], campo, valor) end
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1
`;

// Bloqueo temporal de una cuenta (`bloqueo:{id_usuario}`, ver bloqueoService.js):
// la clave EXISTE mientras la cuenta está suspendida y su TTL es lo que falta para
// que se levante sola — Redis es quien hace vencer el bloqueo. Este script lo
// escribe SOLO si el TTL nuevo es mayor que el que ya tiene (o si no existía), en
// una sola ejecución atómica: un segundo hallazgo de la misma cuenta, o la
// reconstrucción desde MySQL, nunca pueden ACORTAR una suspensión que ya corre.
// KEYS[1] = clave, ARGV[1] = valor, ARGV[2] = TTL en milisegundos.
// PTTL devuelve -2 si la clave no existe y -1 si existe sin vencimiento; en ambos
// casos es menor que cualquier TTL pedido, así que se escribe. Devuelve 1 si
// escribió, 0 si ya había un bloqueo igual o más largo.
const LUA_BLOQUEAR_CUENTA = `
local actual = redis.call('PTTL', KEYS[1])
if actual < tonumber(ARGV[2]) then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
  return 1
end
return 0
`;

// Cupo por ventana de tiempo (INCR + EXPIRE), para frenar ráfagas ANTES de que se
// completen — hoy, los pedidos por hora de una cuenta (limitePedidosService.js) y
// los intentos de contraseña (reautenticacionService.js). Todo en una sola
// ejecución atómica, sin la ventana entre "contar" y "decidir" que tendría un INCR
// suelto más un chequeo en la aplicación: con N pedidos simultáneos, exactamente
// `límite` pasan.
//   - el primer uso abre la ventana (EXPIRE); la ventana es FIJA, no deslizante;
//   - si ya se llegó al límite, deshace su propio INCR (el contador no sube más
//     allá del límite) y devuelve -1 con lo que falta para que la ventana cierre;
//   - un contador que perdió su TTL (no debería) se repara en vez de quedar para
//     siempre.
// KEYS[1] = contador, ARGV[1] = límite, ARGV[2] = ventana en segundos.
// Devuelve { cuenta | -1, segundos que faltan }.
const LUA_RESERVAR_CUPO = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
  ttl = tonumber(ARGV[2])
end
if n > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return {-1, ttl}
end
return {n, ttl}
`;
// Devuelve un cupo reservado (el pedido no llegó a completarse). Nunca baja de
// cero, ni resucita un contador cuya ventana ya cerró.
const LUA_LIBERAR_CUPO = `
local n = tonumber(redis.call('GET', KEYS[1]) or '0')
if n > 0 then return redis.call('DECR', KEYS[1]) end
return 0
`;

// Las credenciales de una cuenta salen del entorno (backend/.env, que escribe `npm run seguridad:inicializar`);
// null si no hay contraseña definida, es decir, si Redis todavía no tiene ACL.
function credencialesDe(cuenta, env = process.env) {
  const contrasena = env[variableContrasena(cuenta)];
  return contrasena ? { username: usuarioDe(cuenta), password: contrasena } : null;
}

function crearCliente(credenciales) {
  const usuario = credenciales?.username ?? null;
  // La estrategia de reintento mira al propio cliente: una vez rechazadas las credenciales no se reconecta.
  const retryStrategy = (intento) => (cliente.credencialRechazada ? null : OPCIONES_RESILIENTES.retryStrategy(intento));
  const cliente = new RedisTolerante(process.env.REDIS_URL, { ...OPCIONES_RESILIENTES, ...(credenciales ?? {}), retryStrategy });
  // Sin un oyente, ioredis escribiría un "Unhandled error event" por cada reintento.
  cliente.on('error', (err) => {
    if (esErrorDeAcceso(err)) {
      // Rechazaron el login (WRONGPASS, o NOAUTH si el servidor exige credenciales y no hay): el cerrojo detiene el
      // bucle de reintentos y los comandos siguientes fallan con CredencialRechazada. Un NOPERM es otra cosa: el
      // login fue bueno y solo ese comando está prohibido; se avisa, pero la cuenta sigue en pie.
      if (!cliente.credencialRechazada && /^(WRONGPASS|NOAUTH)\b/.test(String(err.message))) {
        cliente.credencialRechazada = new CredencialRechazada('redis', usuario, err);
        cliente.rechazadaEn = Date.now();
      }
      avisarCredencial('redis', err, usuario);
      return;
    }
    avisarCaida('redis', err);
  });
  cliente.on('ready', () => avisarRecuperacion('redis'));
  // Registrado una sola vez acá (no en cada llamada) — ioredis expone esto
  // después como cliente.decrementarOferta(key, ...argv), un comando más.
  cliente.defineCommand('decrementarOferta', { numberOfKeys: 1, lua: LUA_DECREMENTAR_OFERTA });
  cliente.defineCommand('reintegrarOferta', { numberOfKeys: 1, lua: LUA_REINTEGRAR_OFERTA });
  cliente.defineCommand('reservarOfertaIdempotente', { numberOfKeys: 2, lua: LUA_RESERVAR_OFERTA });
  cliente.defineCommand('devolverReservaOferta', { numberOfKeys: 2, lua: LUA_DEVOLVER_RESERVA });
  cliente.defineCommand('leerCarrito', { numberOfKeys: 2, lua: LUA_LEER_CARRITO });
  cliente.defineCommand('publicarCarrito', { numberOfKeys: 2, lua: LUA_PUBLICAR_CARRITO });
  cliente.defineCommand('invalidarCarrito', { numberOfKeys: 2, lua: LUA_INVALIDAR_CARRITO });
  cliente.defineCommand('leerOferta', { numberOfKeys: 2, lua: LUA_LEER_OFERTA });
  cliente.defineCommand('publicarOferta', { numberOfKeys: 2, lua: LUA_PUBLICAR_OFERTA });
  // Invalidar es lo mismo para el carrito y la oferta: subir la revisión y
  // borrar los datos, en un solo paso atómico.
  cliente.defineCommand('invalidarOferta', { numberOfKeys: 2, lua: LUA_INVALIDAR_CARRITO });
  cliente.defineCommand('bloquearCuenta', { numberOfKeys: 1, lua: LUA_BLOQUEAR_CUENTA });
  cliente.defineCommand('reservarCupo', { numberOfKeys: 1, lua: LUA_RESERVAR_CUPO });
  cliente.defineCommand('liberarCupo', { numberOfKeys: 1, lua: LUA_LIBERAR_CUPO });
  return cliente;
}

// Conexión perezosa y reutilizada, mismo patrón que config/mongo.js — se abre una sola vez por cuenta, la
// primera vez que algún servicio la necesita. `cuenta` es obligatoria (las de redisCuentas.js): cada módulo dice
// con cuál entra, y los scripts de mantenimiento piden 'admin'; el servidor web nunca la usa.
function conectar(cuenta) {
  definicion(cuenta); // lanza si falta o no existe: un módulo no puede entrar «sin decir quién es»
  const credenciales = credencialesDe(cuenta);
  const id = credenciales ? cuenta : 'legado';
  let cliente = clientes.get(id);
  if (cliente?.credencialRechazada && Date.now() - cliente.rechazadaEn >= REINTENTO_CREDENCIAL_MS) {
    cliente.disconnect();
    clientes.delete(id);
    cliente = undefined;
  }
  if (!cliente) {
    cliente = crearCliente(credenciales);
    clientes.set(id, cliente);
  }
  return cliente;
}

// Cierra únicamente los clientes ya abiertos, sin crear conexiones al apagar ni
// continuar reintentando contra un Redis que podría estar fuera de servicio.
function cerrar() {
  for (const cliente of clientes.values()) cliente.disconnect();
  clientes.clear();
}

module.exports = { conectar, cerrar, credencialesDe };
