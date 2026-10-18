const Redis = require('ioredis');

let cliente;

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

// Conexión perezosa y reutilizada, mismo patrón que config/mongo.js — se abre
// una sola vez, la primera vez que algún servicio la necesita.
function conectar() {
  if (!cliente) {
    cliente = new Redis(process.env.REDIS_URL);
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
  }
  return cliente;
}

// Cierra únicamente el cliente ya abierto, sin crear conexiones al apagar ni
// continuar reintentando contra un Redis que podría estar fuera de servicio.
function cerrar() {
  if (cliente) cliente.disconnect();
  cliente = undefined;
}

module.exports = { conectar, cerrar };
