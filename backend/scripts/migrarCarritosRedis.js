require('dotenv/config');
const prisma = require('../src/config/prisma');
const { conectar, cerrar } = require('../src/config/redis');

// Ejecutar con el backend detenido, antes de arrancar la versión persistente.
// Idempotente: las filas SQL existentes prevalecen, no se suman en un reintento.
async function main() {
  const redis = conectar();
  let cursor = '0';
  let migrados = 0;
  do {
    const [siguiente, claves] = await redis.scan(cursor, 'MATCH', 'carrito:*', 'COUNT', 100);
    cursor = siguiente;
    for (const clave of claves) {
      const usuarioId = Number(clave.split(':')[1]);
      if (!Number.isInteger(usuarioId) || usuarioId <= 0 || await redis.type(clave) !== 'hash') continue;
      const crudo = await redis.hgetall(clave);
      const legacy = Object.entries(crudo).filter(([id, cantidad]) => /^\d+$/.test(id) && /^\d+$/.test(cantidad) && Number(cantidad) > 0);
      if (!legacy.length) continue;
      await prisma.$transaction(async (tx) => {
        const usuario = await tx.$queryRaw`SELECT id_usuario FROM usuarios WHERE id_usuario = ${usuarioId} FOR UPDATE`;
        if (!usuario.length) return;
        const inventarios = await tx.inventario.findMany({ where: { id_producto: { in: legacy.map(([id]) => Number(id)) } } });
        for (const inv of inventarios) {
          const cantidad = Math.min(Number(crudo[inv.id_producto]), inv.cantidad);
          if (cantidad <= 0) continue;
          await tx.carrito.upsert({
            where: { id_usuario_id_producto: { id_usuario: usuarioId, id_producto: inv.id_producto } },
            create: { id_usuario: usuarioId, id_producto: inv.id_producto, cantidad, estado: 'activo' },
            update: {},
          });
          migrados += 1;
        }
      });
    }
  } while (cursor !== '0');
  console.log(`Carritos anteriores conciliados con MySQL: ${migrados} líneas. Las claves Redis se reconstruirán al leerlos.`);
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); cerrar(); });
