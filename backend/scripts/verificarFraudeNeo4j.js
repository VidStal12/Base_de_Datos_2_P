require('dotenv').config();
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const prisma = require('../src/config/prisma');
const neo4j = require('../src/config/neo4j');
require('../src/models/mongo/Categoria');
const { checkout } = require('../src/services/checkoutService');
const resenaService = require('../src/services/resenaService');
const fraudeService = require('../src/services/fraudeService');

// Evidencia de funcionamiento de las dos señales de fraude (Entrega 2, ver
// IA/PLAN-NEO4J-DETECCION-FRAUDE.md) — con el catálogo y las cuentas de
// prueba actuales, ninguna consulta encuentra nada (ver plan §8): siembra el
// patrón, documentado como sintético, corriendo checkout()/resenaService.crear()
// REALES (no MERGE directo a Neo4j) para probar el camino en vivo de punta a
// punta, no solo las consultas de lectura.
async function crearCuenta(correo, nombres) {
  const existente = await prisma.usuarios.findFirst({ where: { correo } });
  if (existente) return existente;
  const comprador = await prisma.rol_usuario.findFirst({ where: { tipo_rol: 'comprador' } });
  const hash = await bcrypt.hash('Password123!', 10);
  return prisma.usuarios.create({
    data: { rol_id: comprador.id, nombres, apellidos: 'Prueba', correo, contrasena: hash, fecha_nacimiento: new Date('1995-01-01') },
  });
}

// Idempotente por contenido, no solo por dueño — re-correr el script no debe
// acumular una dirección/método de pago nuevo cada vez.
async function crearDireccion(usuarioId, direccion) {
  const existente = await prisma.direcciones.findFirst({ where: { id_usuario: usuarioId, ...direccion } });
  if (existente) return existente;
  return prisma.direcciones.create({ data: { id_usuario: usuarioId, pais: 'Guatemala', ...direccion } });
}

async function crearMetodoPago(usuarioId, token) {
  const existente = await prisma.metodo_pago.findFirst({ where: { id_usuario: usuarioId, token_pasarela: token } });
  if (existente) return existente;
  return prisma.metodo_pago.create({
    data: { id_usuario: usuarioId, titular: 'Cuenta de prueba', token_pasarela: token, ultimos_4_digitos: '0000', marca: 'Visa' },
  });
}

async function main() {
  // --- Señal A: dos cuentas que reseñan los mismos 3 productos, en bloque,
  // con calificación alta — sin haber tenido ningún contacto antes. ---
  const test1 = await crearCuenta('fraude.test1@example.com', 'Fraude Test1');
  const test2 = await crearCuenta('fraude.test2@example.com', 'Fraude Test2');
  const dir1 = await crearDireccion(test1.id_usuario, { direccion: 'Km 14 Carretera a El Salvador', codigo_postal: '01064' });
  const pago1 = await crearMetodoPago(test1.id_usuario, 'tok_fraude_test1');
  const dir2 = await crearDireccion(test2.id_usuario, { direccion: 'Avenida Reforma 12-01', codigo_postal: '01009' });
  const pago2 = await crearMetodoPago(test2.id_usuario, 'tok_fraude_test2');

  const productos = await prisma.producto.findMany({ where: { inventario: { cantidad: { gte: 1 } } }, take: 3, select: { id: true } });
  if (productos.length < 3) throw new Error('Hacen falta al menos 3 productos con stock para esta verificación.');
  const productoIds = productos.map((p) => p.id);
  console.log(`Señal A: ${test1.correo} y ${test2.correo} van a comprar y reseñar los productos ${productoIds.join(', ')}.`);

  for (const [usuario, direccion, metodoPago] of [
    [test1, dir1, pago1],
    [test2, dir2, pago2],
  ]) {
    console.log(`  checkout() para ${usuario.correo}...`);
    await checkout({
      usuarioId: usuario.id_usuario,
      direccionId: direccion.id,
      metodoPagoId: metodoPago.id,
      items: productoIds.map((productoId) => ({ productoId, cantidad: 1 })),
    });
    console.log(`  checkout() listo para ${usuario.correo}.`);
    for (const productoId of productoIds) {
      console.log(`  reseña de ${usuario.correo} para el producto ${productoId}...`);
      try {
        await resenaService.crear({ id_usuario: usuario.id_usuario, rol: 'comprador' }, productoId, {
          calificacion: 5,
          comentario: 'Excelente producto, lo recomiendo muchísimo.',
        });
        console.log(`  reseña lista.`);
      } catch (err) {
        // Re-correr el script (p. ej. después de interrumpirlo a mitad de
        // camino) no debe fallar solo porque una corrida anterior ya dejó
        // esta reseña puntual — el índice único de Resena.js es justamente
        // lo que hace este caso seguro de ignorar.
        if (err.status === 409) console.log('  ya existía de una corrida anterior, sigo.');
        else throw err;
      }
    }
  }

  // --- Señal B: una cuenta nueva, sin ningún historial, compra por primera
  // vez y envía a una dirección cuyo TEXTO coincide con la de test1 — misma
  // dirección física, cuentas "distintas". ---
  const test3 = await crearCuenta('fraude.test3@example.com', 'Fraude Test3');
  const dirCompartidaConTest1 = await crearDireccion(test3.id_usuario, {
    direccion: 'Km 14 Carretera a El Salvador', // mismo texto que dir1 a propósito
    codigo_postal: '01064',
  });
  const pago3 = await crearMetodoPago(test3.id_usuario, 'tok_fraude_test3');
  console.log(`Señal B: ${test3.correo} compra por primera vez, enviando a la misma dirección que ${test1.correo}.`);
  await checkout({
    usuarioId: test3.id_usuario,
    direccionId: dirCompartidaConTest1.id,
    metodoPagoId: pago3.id,
    items: [{ productoId: productoIds[0], cantidad: 1 }],
  });

  // El reenvío a Neo4j es de mejor esfuerzo — dar un margen breve antes de
  // consultar, aunque en la práctica ya corrió dentro de cada await de arriba.
  await new Promise((r) => setTimeout(r, 500));

  const resultado = await fraudeService.consultarFraude();
  console.log(`Advertencias: ${JSON.stringify(resultado.advertencias)}`);

  console.log(`Reseñas coordinadas encontradas: ${resultado.resenasCoordinadas.length}`);
  const parEsperado = resultado.resenasCoordinadas.find(
    (r) =>
      (r.usuario1.id === test1.id_usuario && r.usuario2.id === test2.id_usuario) ||
      (r.usuario1.id === test2.id_usuario && r.usuario2.id === test1.id_usuario)
  );
  if (!parEsperado) throw new Error('FALLO: no se encontró el par de reseñas coordinadas sembrado.');
  if (parEsperado.productosCompartidos < 3) throw new Error('FALLO: el par encontrado no comparte los 3 productos esperados.');
  console.log(`  OK: ${parEsperado.usuario1.nombre} / ${parEsperado.usuario2.nombre}, ${parEsperado.productosCompartidos} productos compartidos.`);

  console.log(`Desviaciones de patrón encontradas: ${resultado.desviacionPatron.length}`);
  // otrasCuentas es un array desde que se agregó el cruce con corroboradores
  // (mismo método de pago / Señal A, ver PLAN-NEO4J-DETECCION-FRAUDE.md §15)
  // — antes era un solo `otraCuenta`, un producto puede compartir dirección
  // con más de una cuenta a la vez.
  const desviacionEsperada = resultado.desviacionPatron.find(
    (d) => d.usuario.id === test3.id_usuario && d.otrasCuentas.some((o) => o.id === test1.id_usuario)
  );
  if (!desviacionEsperada) throw new Error('FALLO: no se encontró la desviación de patrón sembrada (test3 <-> test1, dirección compartida).');
  const otraCuentaEsperada = desviacionEsperada.otrasCuentas.find((o) => o.id === test1.id_usuario);
  console.log(`  OK: ${desviacionEsperada.usuario.nombre} comparte dirección con ${otraCuentaEsperada.nombre} en "${desviacionEsperada.producto.descripcion}".`);

  console.log('Todas las verificaciones de detección de fraude pasaron.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await mongoose.disconnect();
    await neo4j.cerrar();
  });
