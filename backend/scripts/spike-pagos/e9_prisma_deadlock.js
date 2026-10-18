// E9 — Deadlock con el stack REAL de la aplicación (Prisma + @prisma/adapter-mariadb).
// E4 mostró el deadlock con el driver `mariadb` pelado; aquí se comprueba qué error ve el código del checkout
// (que corre sobre Prisma) y si reintentar la transacción completa con ese código basta. Trabaja en el esquema
// temporal: la URL de `DATABASE_URL` se reapunta a `prisma_migrate_shadow_db_poc` antes de crear el cliente.
const { PrismaClient } = require('@prisma/client');
const { PrismaMariaDb } = require('@prisma/adapter-mariadb');
const { nuevoRegistro, tabla, conConcurrencia, esperar } = require('./util');

async function ejecutar({ my, MYSQL_DB }, { rapido }) {
  const { checks, chequear } = nuevoRegistro();
  const notas = [];

  // Misma forma que el modelo `inventario` de schema.prisma (Prisma no valida la tabla al consultar, solo arma el SQL).
  await my.query(`CREATE TABLE inventario (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, id_producto INT NOT NULL,
    precio DECIMAL(10,2) NOT NULL, cantidad INT NOT NULL, UNIQUE KEY inventario_id_producto_key (id_producto)) ENGINE=InnoDB`);
  await my.query('INSERT INTO inventario (id_producto, precio, cantidad) VALUES (1, 10, 100000), (2, 10, 100000)');

  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${MYSQL_DB}`;
  const prisma = new PrismaClient({ adapter: new PrismaMariaDb(url.toString()) });
  const lectura = async () => (await my.query('SELECT cantidad FROM inventario ORDER BY id_producto')).map((f) => Number(f.cantidad));

  try {
    // Dos transacciones interactivas que tocan los mismos dos productos en orden opuesto, como un checkout sin orden canónico.
    const transaccion = (orden, pausaMs) => prisma.$transaction(async (tx) => {
      await tx.inventario.updateMany({ where: { id_producto: orden[0] }, data: { cantidad: { decrement: 1 } } });
      await esperar(pausaMs);
      await tx.inventario.updateMany({ where: { id_producto: orden[1] }, data: { cantidad: { decrement: 1 } } });
    }, { maxWait: 10000, timeout: 20000 });

    const resultados = await Promise.allSettled([transaccion([1, 2], 200), transaccion([2, 1], 200)]);
    const fallos = resultados.filter((r) => r.status === 'rejected').map((r) => r.reason);
    chequear('Prisma: dos transacciones con orden opuesto producen exactamente un fallo (la víctima del deadlock)', fallos.length === 1, `${fallos.length} fallos`);
    const error = fallos[0];
    const codigo = error?.code;
    const resumen = {
      clase: error?.constructor?.name, codigo: codigo ?? '(sin código de Prisma)',
      // Prisma antepone un fragmento de código a su mensaje: solo interesa la frase final.
      mensaje: (String(error?.message ?? '').match(/Transaction failed[^\n]*$/) || [String(error?.message ?? '').slice(-120)])[0],
    };
    chequear('Prisma expone el deadlock con un código estable que se puede capturar', typeof codigo === 'string' && codigo.length > 0, `${resumen.clase} ${resumen.codigo}`);
    const [a, b] = await lectura();
    chequear('La transacción víctima se revierte por completo (los dos productos quedan descontados igual, una sola vez)', a === 99999 && b === 99999, `cantidades ${a} y ${b}`);

    // Reintentar la transacción COMPLETA cuando llega ese código: todas deben terminar y el descuento debe ser exacto.
    const N = rapido ? 10 : 40;
    let reintentos = 0;
    const conReintento = async (orden) => {
      for (let intento = 0; intento < 8; intento++) {
        try { return await transaccion(orden, 30); } catch (err) {
          if (err.code !== codigo || !codigo) throw err;
          reintentos++;
        }
      }
      throw new Error('agotó los reintentos');
    };
    await my.query('UPDATE inventario SET cantidad = 100000');
    let terminaron = 0; let otros = 0;
    await conConcurrencia(N, N, async (i) => {
      try { await conReintento(i % 2 ? [1, 2] : [2, 1]); terminaron++; } catch { otros++; }
    });
    const [c, d] = await lectura();
    chequear(`Con reintento ante ${codigo}: las ${N} transacciones de orden opuesto terminan`, terminaron === N && otros === 0, `${terminaron}/${N}, ${reintentos} reintentos`);
    chequear('Con reintento: el descuento es exacto en ambos productos', c === 100000 - N && d === 100000 - N, `cantidades ${c} y ${d}`);
    notas.push(`El deadlock llega al código de la aplicación como ${resumen.clase} con código ${resumen.codigo}.`);

    return {
      titulo: 'E9 — Deadlock visto desde Prisma (el stack de la aplicación)',
      checks,
      tablas: [{ titulo: 'Error que ve el código del checkout', md: tabla(
        [{ clave: 'clase', titulo: 'Clase' }, { clave: 'codigo', titulo: 'Código' }, { clave: 'mensaje', titulo: 'Mensaje' }], [resumen]) }],
      notas,
      datos: { ...resumen, N, reintentos, terminaron },
    };
  } finally {
    await prisma.$disconnect();
  }
}

module.exports = { ejecutar };
