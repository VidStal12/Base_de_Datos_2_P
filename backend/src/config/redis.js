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
