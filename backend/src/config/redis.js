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

// Conexión perezosa y reutilizada, mismo patrón que config/mongo.js — se abre
// una sola vez, la primera vez que algún servicio la necesita.
function conectar() {
  if (!cliente) {
    cliente = new Redis(process.env.REDIS_URL);
    // Registrado una sola vez acá (no en cada llamada) — ioredis expone esto
    // después como cliente.decrementarOferta(key, ...argv), un comando más.
    cliente.defineCommand('decrementarOferta', { numberOfKeys: 1, lua: LUA_DECREMENTAR_OFERTA });
    cliente.defineCommand('reintegrarOferta', { numberOfKeys: 1, lua: LUA_REINTEGRAR_OFERTA });
    cliente.defineCommand('leerCarrito', { numberOfKeys: 2, lua: LUA_LEER_CARRITO });
    cliente.defineCommand('publicarCarrito', { numberOfKeys: 2, lua: LUA_PUBLICAR_CARRITO });
    cliente.defineCommand('invalidarCarrito', { numberOfKeys: 2, lua: LUA_INVALIDAR_CARRITO });
    cliente.defineCommand('leerOferta', { numberOfKeys: 2, lua: LUA_LEER_OFERTA });
    cliente.defineCommand('publicarOferta', { numberOfKeys: 2, lua: LUA_PUBLICAR_OFERTA });
    // Invalidar es lo mismo para el carrito y la oferta: subir la revisión y
    // borrar los datos, en un solo paso atómico.
    cliente.defineCommand('invalidarOferta', { numberOfKeys: 2, lua: LUA_INVALIDAR_CARRITO });
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
