const { PrismaClient } = require('@prisma/client');
const { PrismaMariaDb } = require('@prisma/adapter-mariadb');

// MySQL es la autoridad transaccional: si está apagado no hay login, carrito ni pedidos
// (lo único honesto es decirlo), pero el catálogo y la búsqueda siguen. Con los tiempos
// por defecto del pool de MariaDB cada petición esperaba 10 s ("pool timeout") antes de
// fallar; acá se corta en ~2,5 s. Los parámetros viajan en la propia cadena de conexión y
// un valor ya presente en DATABASE_URL tiene prioridad.
function conexionConTiempos(cadena) {
  if (!cadena) return cadena; // sin DATABASE_URL el error sigue siendo el de siempre, al primer uso
  const url = new URL(cadena);
  if (!url.searchParams.has('acquireTimeout')) url.searchParams.set('acquireTimeout', '2500');
  if (!url.searchParams.has('connectTimeout')) url.searchParams.set('connectTimeout', '2000');
  return url.toString();
}

const adapter = new PrismaMariaDb(conexionConTiempos(process.env.DATABASE_URL));
const prisma = new PrismaClient({ adapter });

module.exports = prisma;
