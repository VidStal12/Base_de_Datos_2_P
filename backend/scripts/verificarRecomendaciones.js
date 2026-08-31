require('dotenv').config();
const mongoose = require('mongoose');
const prisma = require('../src/config/prisma');
const { conectar: conectarRedis } = require('../src/config/redis');
const { conectar: conectarMongo } = require('../src/config/mongo');
const Categoria = require('../src/models/mongo/Categoria');
const Subcategoria = require('../src/models/mongo/Subcategoria');
const Producto = require('../src/models/mongo/Producto');
const ProductoEvento = require('../src/models/mongo/ProductoEvento');
const tendenciaService = require('../src/services/tendenciaService');

// Evidencia de funcionamiento de las recomendaciones por tendencia (Entrega
// 2, ver IA/ENTREGA-2-PLAN.md §4.5): usa el historial de compras REAL de Ana
// (acumulado por el resto de las verificaciones de este proyecto, no
// fabricado) para confirmar que el análisis encuentra su subcategoría/
// atributos/vendedor dominantes, que aparece un producto de OTRO vendedor
// con los mismos atributos, y que comprarlo respeta un cupo personal —
// atómico bajo concurrencia, mismo mecanismo que verificarOfertaFlash.js,
// ahora sobre una clave por (producto, usuario) en vez de una compartida.
//
// Antes de verificar nada, siembra (si todavía no existe) el producto
// competidor que hace posible la comparación entre vendedores — mismo
// espíritu que el punto "datos sembrados a propósito" de ENTREGA-2-PLAN.md
// §4.3: sin un segundo vendedor con los mismos atributos en la misma
// subcategoría, no hay nada que la consulta de tendencia pueda encontrar.
// También sembrado (permanente) en prisma/seed.js para que un clon nuevo
// tenga esto desde el principio.
async function asegurarProductoCompetidor({ vendedorCorreo, descripcion, subcategoriaNombre, precio, cantidad, atributos }) {
  const yaExiste = await Producto.findOne({ descripcion });
  if (yaExiste) return yaExiste;

  const vendedor = await prisma.usuarios.findFirst({ where: { correo: vendedorCorreo } });
  if (!vendedor) throw new Error(`No existe el vendedor de prueba ${vendedorCorreo} — corré "npm run seed" primero.`);

  const subcategoria = await Subcategoria.findOne({ subcategoria: subcategoriaNombre });
  if (!subcategoria) throw new Error(`No existe la subcategoría "${subcategoriaNombre}" en Mongo.`);

  const productoRelacional = await prisma.producto.create({
    data: { id_vendedor: vendedor.id_usuario, inventario: { create: { precio, cantidad } } },
  });
  const doc = await Producto.create({
    producto_id: productoRelacional.id,
    descripcion,
    estado: 'activo',
    subcategoria_id: subcategoria._id,
    vendedor_id: vendedor.id_usuario,
    vendedor_nombre: `${vendedor.nombres} ${vendedor.apellidos}`,
    inventario: { precio, cantidad },
    atributos,
    imagenes: [],
    version: 1,
  });
  await ProductoEvento.create({
    producto_id: productoRelacional.id,
    version: 1,
    tipo: 'creacion',
    fecha: doc.actualizado_en,
    usuario_id: vendedor.id_usuario,
    campos_modificados: [],
    snapshot: { descripcion: doc.descripcion, estado: doc.estado, atributos: doc.atributos, imagenes: doc.imagenes, inventario: { precio, cantidad } },
  });
  console.log(`Sembrado: "${descripcion}" (producto ${productoRelacional.id}, vendedor ${vendedor.nombres}).`);
  return doc;
}

async function main() {
  await conectarMongo();

  await Subcategoria.updateOne({ subcategoria: 'Celulares' }, { $addToSet: { atributos_definidos: 'RAM' } });

  await asegurarProductoCompetidor({
    vendedorCorreo: 'marta.diaz@example.com',
    descripcion: 'Camiseta de algodón pima',
    subcategoriaNombre: 'Camisetas',
    precio: 79.5,
    cantidad: 30,
    atributos: [
      { nombre: 'Talla', valor: 'M' },
      { nombre: 'Color', valor: 'Azul' },
    ],
  });

  const usuario = await prisma.usuarios.findFirst({
    where: { correo: 'ana.gomez@example.com' },
    include: { direcciones: true, metodos_pago: true },
  });
  if (!usuario || usuario.direcciones.length === 0 || usuario.metodos_pago.length === 0) {
    throw new Error('No hay datos de prueba de Ana. Corré "npm run seed" primero.');
  }

  // 1) El análisis encuentra la subcategoría/atributos/vendedor dominantes de
  // Ana a partir de su historial REAL de compras (no fabricado para este
  // script — es el que quedó de todas las pruebas anteriores del proyecto).
  const tendencia = await tendenciaService.analizarTendencia(usuario.id_usuario);
  console.log('Tendencia detectada:', JSON.stringify(tendencia));
  if (!tendencia) throw new Error('FALLO: no se detectó ninguna tendencia — ¿Ana no tiene compras?');
  const subcatCamisetas = await Subcategoria.findOne({ subcategoria: 'Camisetas' });
  if (String(tendencia.subcategoriaId) !== String(subcatCamisetas._id)) {
    throw new Error(`FALLO: se esperaba Camisetas como subcategoría dominante, salió ${tendencia.subcategoriaId}`);
  }
  const talla = tendencia.atributosPreferidos.find((a) => a.nombre === 'Talla');
  if (!talla || talla.valor !== 'M') {
    throw new Error(`FALLO: se esperaba Talla=M como atributo preferido, salió ${JSON.stringify(talla)}`);
  }

  // 2) La recomendación incluye un producto de OTRO vendedor (Marta), no
  // solo variantes de Luis — es el punto central de la funcionalidad.
  const redis = conectarRedis();
  await redis.del(`recomendaciones:${usuario.id_usuario}`); // estado limpio, por si quedó cacheado de una corrida anterior
  const { productos } = await tendenciaService.recomendar(usuario.id_usuario);
  console.log(
    `Recomendaciones (${productos.length}):`,
    productos.map((p) => `${p.descripcion} · ${p.vendedor_nombre} · Q${p.precio_recomendado} (antes Q${p.precio_normal})`)
  );
  const cruzada = productos.find((p) => p.vendedor_nombre?.includes('Marta') || p.descripcion === 'Camiseta de algodón pima');
  if (!cruzada) {
    throw new Error('FALLO: no apareció ningún producto de un vendedor distinto — la comparación entre vendedores no está funcionando');
  }
  if (cruzada.precio_recomendado >= cruzada.precio_normal) {
    throw new Error('FALLO: el precio recomendado no es un descuento real sobre el precio normal');
  }

  // 3) Comprar respeta el cupo PERSONAL bajo concurrencia — más intentos
  // simultáneos que CUPO_PERSONAL, exactamente esa cantidad admitida.
  const productoId = cruzada.id;
  const claveCupo = `oferta-recomendada:${productoId}:${usuario.id_usuario}:stock`;
  await redis.del(claveCupo); // estado limpio

  const inventarioAntes = await prisma.inventario.findUnique({ where: { id_producto: productoId } });

  const intentos = Array.from({ length: tendenciaService.CUPO_PERSONAL + 5 }, () =>
    tendenciaService.comprar(usuario.id_usuario, productoId, {
      cantidad: 1,
      direccionId: usuario.direcciones[0].id,
      metodoPagoId: usuario.metodos_pago[0].id,
    })
  );
  const resultados = await Promise.allSettled(intentos);
  const admitidos = resultados.filter((r) => r.status === 'fulfilled');
  const rechazados = resultados.filter((r) => r.status === 'rejected');
  console.log(
    `De ${intentos.length} intentos simultáneos sobre el cupo personal: ${admitidos.length} admitidos, ${rechazados.length} rechazados ` +
      `(esperado: ${tendenciaService.CUPO_PERSONAL} / ${intentos.length - tendenciaService.CUPO_PERSONAL})`
  );
  if (admitidos.length !== tendenciaService.CUPO_PERSONAL) {
    throw new Error(`FALLO: se esperaban exactamente ${tendenciaService.CUPO_PERSONAL} compras admitidas, hubo ${admitidos.length}`);
  }

  const restanteFinal = await redis.get(claveCupo);
  console.log(`Cupo personal final en Redis: ${restanteFinal} (esperado: 0)`);
  if (Number(restanteFinal) !== 0) {
    throw new Error('FALLO: el cupo personal no terminó en exactamente 0');
  }

  const inventarioDespues = await prisma.inventario.findUnique({ where: { id_producto: productoId } });
  const descontado = inventarioAntes.cantidad - inventarioDespues.cantidad;
  console.log(`Inventario real descontado en MySQL: ${descontado} unidades (esperado: ${tendenciaService.CUPO_PERSONAL})`);
  if (descontado !== tendenciaService.CUPO_PERSONAL) {
    throw new Error('FALLO: el inventario real en MySQL no se descontó en la cantidad esperada');
  }

  // 4) Un producto que NO es una recomendación vigente se rechaza — no se
  // puede pedir el descuento adivinando un productoId cualquiera.
  const otroProducto = await prisma.producto.findFirst({ where: { id: { notIn: productos.map((p) => p.id) } } });
  if (otroProducto) {
    try {
      await tendenciaService.comprar(usuario.id_usuario, otroProducto.id, {
        cantidad: 1,
        direccionId: usuario.direcciones[0].id,
        metodoPagoId: usuario.metodos_pago[0].id,
      });
      throw new Error('FALLO: se pudo comprar un producto que no era una recomendación vigente');
    } catch (err) {
      if (!/no es una recomendación vigente/i.test(err.message)) throw err;
      console.log('Comprar un producto no recomendado se rechazó correctamente:', err.message);
    }
  }

  console.log('Todas las verificaciones de recomendaciones por tendencia pasaron.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await mongoose.disconnect();
    conectarRedis().disconnect();
  });
