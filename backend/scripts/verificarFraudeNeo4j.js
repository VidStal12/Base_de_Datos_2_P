require('dotenv').config();
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const prisma = require('../src/config/prisma');
const neo4j = require('../src/config/neo4j');
const redis = require('../src/config/redis');
const Categoria = require('../src/models/mongo/Categoria');
const Subcategoria = require('../src/models/mongo/Subcategoria');
const Producto = require('../src/models/mongo/Producto');
const ProductoEvento = require('../src/models/mongo/ProductoEvento');
const Resena = require('../src/models/mongo/Resena');
const { conectar: conectarMongo } = require('../src/config/mongo');
const { checkout } = require('../src/services/checkoutService');
const resenaService = require('../src/services/resenaService');
const fraudeService = require('../src/services/fraudeService');
const fraudeSyncService = require('../src/services/fraudeSyncService');

// Evidencia de funcionamiento de las seis señales de fraude (Entrega 2, ver
// IA/PLAN-NEO4J-DETECCION-FRAUDE.md §17-§18): A reseñas coordinadas, B gasto
// anómalo, C categoría inusual, D cuentas de una misma persona (mismo nombre o
// mismo buzón de correo), E ráfaga de gasto, F autocompra. Con el catálogo y las
// cuentas de prueba reales casi ninguna consulta encuentra nada (ver plan §8):
// siembra los patrones, documentados como sintéticos, corriendo
// checkout()/resenaService.crear() REALES (no MERGE directo a Neo4j) para probar
// el camino en vivo de punta a punta, no solo las consultas de lectura.
//
// B, C y E dependen del TIEMPO, y el checkout siempre fecha la compra con el
// instante actual: después de cada checkout "histórico" se corrige la fecha en
// MySQL y se reenvía esa compra al grafo con la fecha vieja (MERGE por
// detalle_id la actualiza). Todo es idempotente — re-correr el script no
// acumula compras ni cuentas.
//
// Excepción: desde §18 checkout() RECHAZA que una cuenta compre su propio
// producto, así que ya no se puede sembrar una autocompra "viva" de una misma
// cuenta. La señal F sigue vigente para pedidos hechos ANTES de la regla, y para
// probarlo se inserta uno directo en MySQL (`sembrarCompraHistorica`); el script
// además comprueba que checkout() ya lo rechaza.

function afirmar(condicion, mensaje) {
  if (!condicion) throw new Error(`FALLO: ${mensaje}`);
}

// ---------- Cuentas y datos que el checkout exige ----------

async function crearCuenta(correo, nombres, { apellidos = 'Prueba', nacimiento = '1995-01-01', rol = 'comprador' } = {}) {
  const existente = await prisma.usuarios.findFirst({ where: { correo } });
  if (existente) return existente;
  const rolDb = await prisma.rol_usuario.findFirst({ where: { tipo_rol: rol } });
  const hash = await bcrypt.hash('Password123!', 10);
  return prisma.usuarios.create({
    data: { rol_id: rolDb.id, nombres, apellidos, correo, contrasena: hash, fecha_nacimiento: new Date(nacimiento) },
  });
}

// checkout() valida que la dirección y el método de pago sean del comprador —
// siguen haciendo falta para comprar, aunque ya no entren al grafo de fraude.
async function crearDireccion(usuarioId) {
  const datos = { direccion: 'Calle de prueba 1-23', codigo_postal: '01001' };
  const existente = await prisma.direcciones.findFirst({ where: { id_usuario: usuarioId, ...datos } });
  if (existente) return existente;
  return prisma.direcciones.create({ data: { id_usuario: usuarioId, pais: 'Guatemala', ...datos } });
}

async function crearMetodoPago(usuarioId, token) {
  const existente = await prisma.metodo_pago.findFirst({ where: { id_usuario: usuarioId, token_pasarela: token } });
  if (existente) return existente;
  return prisma.metodo_pago.create({
    data: { id_usuario: usuarioId, titular: 'Cuenta de prueba', token_pasarela: token, ultimos_4_digitos: '0000', marca: 'Visa' },
  });
}

async function prepararCuenta(correo, nombres, token, opciones) {
  const usuario = await crearCuenta(correo, nombres, opciones);
  return { usuario, direccion: await crearDireccion(usuario.id_usuario), metodoPago: await crearMetodoPago(usuario.id_usuario, token) };
}

// ---------- Productos ----------

async function elegirProducto({ categoria, precioMin = 0, precioMax = 1e12, unidades }) {
  await conectarMongo();
  const cat = await Categoria.findOne({ categoria }).lean();
  afirmar(cat, `no existe la categoría "${categoria}" en el catálogo`);
  const subs = await Subcategoria.find({ categoria_id: cat._id }).select('_id').lean();
  const candidatos = await Producto.find({
    subcategoria_id: { $in: subs.map((s) => s._id) },
    estado: 'activo',
    'inventario.precio': { $gte: precioMin, $lte: precioMax },
  })
    .sort({ 'inventario.cantidad': -1 })
    .limit(15)
    .lean();
  for (const c of candidatos) {
    const inventario = await prisma.inventario.findUnique({ where: { id_producto: c.producto_id } });
    if (inventario && inventario.cantidad >= unidades) return { id: c.producto_id, descripcion: c.descripcion, precio: Number(inventario.precio) };
  }
  throw new Error(`No hay un producto de "${categoria}" entre Q${precioMin} y Q${precioMax} con ${unidades}+ unidades de stock real.`);
}

// Producto sintético de un vendedor de prueba — para la autocompra hace falta
// un vendedor que sea una de las cuentas del patrón, y los vendedores reales
// del catálogo no deben aparecer como autocompradores. Se crea directo (mismo
// criterio que verificarRecomendaciones.js con su producto competidor) y
// INACTIVO: no aparece en la tienda ni en el buscador, pero checkout() solo
// valida el inventario real, así que se puede comprar.
async function asegurarProducto(vendedor, descripcion, precio) {
  await conectarMongo();
  const existente = await Producto.findOne({ descripcion }).lean();
  if (existente) return { id: existente.producto_id, descripcion, precio };

  const subcategoria = await Subcategoria.findOne({ subcategoria: 'Camisetas' });
  afirmar(subcategoria, 'no existe la subcategoría "Camisetas" en el catálogo');
  const cantidad = 20;
  const relacional = await prisma.producto.create({
    data: { id_vendedor: vendedor.id_usuario, inventario: { create: { precio, cantidad } } },
  });
  const doc = await Producto.create({
    producto_id: relacional.id,
    descripcion,
    estado: 'inactivo',
    subcategoria_id: subcategoria._id,
    vendedor_id: vendedor.id_usuario,
    vendedor_nombre: `${vendedor.nombres} ${vendedor.apellidos}`,
    inventario: { precio, cantidad },
    atributos: [],
    imagenes: [],
    version: 1,
  });
  await ProductoEvento.create({
    producto_id: relacional.id,
    version: 1,
    tipo: 'creacion',
    fecha: doc.actualizado_en,
    usuario_id: vendedor.id_usuario,
    campos_modificados: [],
    snapshot: { descripcion, estado: 'inactivo', atributos: [], imagenes: [], inventario: { precio, cantidad } },
  });
  return { id: relacional.id, descripcion, precio };
}

// checkout() rechaza productos que no estén "activos" (409 "productos no
// disponibles"), así que un producto sintético inactivo solo se activa durante
// el instante de su compra y se vuelve a ocultar siempre, aunque la compra falle.
async function conProductoActivo(producto, accion) {
  await Producto.updateOne({ producto_id: producto.id }, { $set: { estado: 'activo' } });
  try {
    return await accion();
  } finally {
    await Producto.updateOne({ producto_id: producto.id }, { $set: { estado: 'inactivo' } });
  }
}

// ---------- Compras (reales) y su corrección de fecha ----------

// Reenvía una compra YA hecha al grafo con la fecha de MySQL — mismos campos
// que arma checkoutService/backfillNeo4j, para que el MERGE por detalle_id
// reemplace la fecha de "ahora" por la del pasado simulado.
async function reenviarAlGrafo(compraId) {
  const compra = await prisma.compra.findUnique({ where: { id: compraId }, include: { compra_detalles: true } });
  const usuario = await prisma.usuarios.findUnique({ where: { id_usuario: compra.id_usuario }, include: { rol: true } });
  for (const detalle of compra.compra_detalles) {
    const producto = await Producto.findOne({ producto_id: detalle.id_producto })
      .select('descripcion subcategoria_id vendedor_id vendedor_nombre')
      .lean();
    await fraudeSyncService.registrarCompra({
      detalleId: detalle.id,
      compraId: compra.id,
      usuarioId: usuario.id_usuario,
      usuarioNombre: `${usuario.nombres} ${usuario.apellidos}`,
      usuarioRol: usuario.rol.tipo_rol,
      vendedorId: producto.vendedor_id,
      vendedorNombre: producto.vendedor_nombre,
      productoId: detalle.id_producto,
      productoDescripcion: producto.descripcion,
      subcategoriaId: producto.subcategoria_id,
      fecha: compra.fecha,
      monto: detalle.precio_final,
    });
  }
}

const haceDias = (dias) => new Date(Date.now() - dias * 86400000);

// Ayer a las 09:00 en Guatemala (15:00 UTC): una hora lejos de cualquier
// medianoche, para que una ráfaga sembrada de una sola vez no se parta en dos
// días de Guatemala.
function ayerEnLaManana() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  d.setUTCHours(15, 0, 0, 0);
  return d;
}

// `productos`: uno solo o un arreglo — una unidad de cada uno, en UN pedido.
// `fecha`: si se indica, la compra se reubica en ese instante (pasado).
async function comprar(cuenta, productos, fecha = null) {
  const { compra } = await checkout({
    usuarioId: cuenta.usuario.id_usuario,
    direccionId: cuenta.direccion.id,
    metodoPagoId: cuenta.metodoPago.id,
    items: [].concat(productos).map((p) => ({ productoId: p.id, cantidad: 1 })),
  });
  if (fecha) {
    await prisma.compra.update({ where: { id: compra.id }, data: { fecha } });
    await reenviarAlGrafo(compra.id);
  }
  return compra;
}

// Un pedido de antes de la regla "nadie compra lo que vende" (§18): solo lo que
// la señal necesita — pedido, línea y pago aprobado — sin tocar stock ni el
// outbox de ventas, porque no es una venta real sino un dato histórico de
// prueba. Se inserta en MySQL (la fuente de verdad) y de ahí se reenvía al grafo,
// de modo que un `fraude:backfill` posterior lo reconstruye igual.
async function sembrarCompraHistorica(cuenta, producto, fecha = haceDias(30)) {
  const compra = await prisma.compra.create({
    data: {
      id_usuario: cuenta.usuario.id_usuario,
      id_direccion: cuenta.direccion.id,
      total: producto.precio,
      fecha,
      compra_detalles: {
        create: [{ id_producto: producto.id, cantidad: 1, precio_final: producto.precio, descuento: 0, estado: 'pendiente' }],
      },
      pagos: {
        create: [{ id_metodo_pago: cuenta.metodoPago.id, monto: producto.precio, estado: 'aprobado', referencia_transaccion: `TX-HISTORICA-${Date.now()}` }],
      },
    },
  });
  await reenviarAlGrafo(compra.id);
  return compra;
}

const ordenesDe = (usuarioId) => prisma.compra.count({ where: { id_usuario: usuarioId, pagos: { some: { estado: 'aprobado' } } } });

// Historial establecido: 6 compras baratas repartidas en ~4 semanas y media
// más de lo exigido (mínimo 5 compras y 30 días) — idempotente.
const DIAS_HISTORIAL = [60, 52, 45, 40, 36, 33];

async function sembrarHistorial(cuenta, producto) {
  const existentes = await ordenesDe(cuenta.usuario.id_usuario);
  for (let i = existentes; i < DIAS_HISTORIAL.length; i += 1) {
    await comprar(cuenta, producto, haceDias(DIAS_HISTORIAL[i]));
  }
  return existentes;
}

const lazy = (fn) => {
  let promesa;
  return () => (promesa ||= fn());
};

async function main() {
  // --- Normalización del nombre (función pura, no depende de ninguna base) ---
  const { normalizarNombre } = fraudeSyncService;
  afirmar(normalizarNombre('José  Pérez') === 'jose perez', 'tildes de vocales y espacios repetidos deben colapsar');
  afirmar(normalizarNombre('JOSE PEREZ') === normalizarNombre('José Pérez'), 'mayúsculas y tildes no deben distinguir un nombre');
  afirmar(normalizarNombre('Ana-María  Gómez, ') === 'ana maria gomez', 'guiones, comas y espacios sobrantes deben colapsar');
  afirmar(normalizarNombre('Peña') !== normalizarNombre('Pena'), 'la ñ NO se colapsa: "Peña" y "Pena" son apellidos distintos');
  afirmar(normalizarNombre('Ana Gomez') !== normalizarNombre('Ana María Gomez'), 'la comparación es exacta, no aproximada: un segundo nombre distingue');
  console.log('OK: normalización de nombres (tildes, mayúsculas, espacios; la ñ y los segundos nombres distinguen).');

  // --- Normalización del buzón de correo (también pura) ---
  const { normalizarCorreo, hashCorreo } = fraudeSyncService;
  afirmar(normalizarCorreo('Ana+Compras@Example.com') === 'ana@example.com', 'mayúsculas y el alias "+etiqueta" no deben cambiar el buzón');
  afirmar(normalizarCorreo('a.n.a@gmail.com') === 'ana@gmail.com', 'Gmail ignora los puntos de la parte local');
  afirmar(normalizarCorreo('ana@googlemail.com') === 'ana@gmail.com', 'googlemail.com es el mismo buzón que gmail.com');
  afirmar(normalizarCorreo('ana.gomez@example.com') !== normalizarCorreo('anagomez@example.com'), 'fuera de Gmail, los puntos SÍ distinguen un buzón');
  afirmar(normalizarCorreo('ana@example.com') !== normalizarCorreo('ana@example.org'), 'otro dominio es otro buzón');
  afirmar(/^[0-9a-f]{64}$/.test(hashCorreo('ana@example.com')) && hashCorreo('ANA+x@Example.com') === hashCorreo('ana@example.com'), 'el grafo guarda el SHA-256 del buzón normalizado');
  console.log('OK: normalización de buzones (alias "+", puntos de Gmail, googlemail; el hash es de lo normalizado).');

  // --- Señal A: dos cuentas que reseñan los mismos 3 productos, en bloque ---
  const test1 = await prepararCuenta('fraude.test1@example.com', 'Fraude Test1', 'tok_fraude_test1');
  const test2 = await prepararCuenta('fraude.test2@example.com', 'Fraude Test2', 'tok_fraude_test2');
  const productos = await prisma.producto.findMany({ where: { inventario: { cantidad: { gte: 1 } } }, take: 3, select: { id: true } });
  afirmar(productos.length >= 3, 'hacen falta al menos 3 productos con stock');
  const productoIds = productos.map((p) => p.id);

  await conectarMongo();
  for (const cuenta of [test1, test2]) {
    const yaReseno = await Resena.countDocuments({ usuario_id: cuenta.usuario.id_usuario, producto_id: { $in: productoIds } });
    if (yaReseno === productoIds.length) continue; // idempotente: ya sembrado
    await comprar(cuenta, productoIds.map((id) => ({ id })));
    for (const productoId of productoIds) {
      try {
        await resenaService.crear({ id_usuario: cuenta.usuario.id_usuario, rol: 'comprador' }, productoId, {
          calificacion: 5,
          comentario: 'Excelente producto, lo recomiendo muchísimo.',
        });
      } catch (err) {
        if (err.status !== 409) throw err; // 409: ya existía de una corrida interrumpida
      }
    }
  }
  console.log(`Señal A sembrada: ${test1.usuario.correo} y ${test2.usuario.correo} con los productos ${productoIds.join(', ')}.`);

  // Los productos se eligen recién cuando hay algo que sembrar: en una
  // re-corrida (todo ya sembrado) no se exige stock que no se va a usar.
  const ropa = lazy(() => elegirProducto({ categoria: 'Ropa', precioMax: 100, unidades: 26 }));
  const ropaMedia = lazy(() => elegirProducto({ categoria: 'Ropa', precioMin: 170, precioMax: 250, unidades: 3 }));
  const electronica = lazy(() => elegirProducto({ categoria: 'Electrónica', precioMin: 1000, unidades: 2 }));
  // 10 unidades: lo compran la categoría inusual, y cada pareja/cadena de la
  // señal D (una unidad por cuenta).
  const hogar = lazy(() => elegirProducto({ categoria: 'Hogar', precioMax: 100, unidades: 10 }));

  // --- Señales B y C, juntas: cuenta con historial barato en Ropa que de
  // pronto hace UNA compra cara en Electrónica (el patrón clásico de cuenta
  // tomada). ---
  const gasto = await prepararCuenta('fraude.gasto@example.com', 'Fraude Gasto', 'tok_fraude_gasto');
  if ((await ordenesDe(gasto.usuario.id_usuario)) <= DIAS_HISTORIAL.length) {
    await sembrarHistorial(gasto, await ropa());
    await comprar(gasto, await electronica());
    console.log(`Señales B+C sembradas ahora: ${gasto.usuario.correo} (${DIAS_HISTORIAL.length} compras baratas en Ropa y una cara en Electrónica).`);
  } else {
    console.log(`Señales B+C: ${gasto.usuario.correo} ya estaba sembrada de una corrida anterior.`);
  }

  // --- Solo señal C: mismo historial, pero la compra nueva es barata (en
  // Hogar) — categoría ajena SIN salto de monto. ---
  const categoria = await prepararCuenta('fraude.categoria@example.com', 'Fraude Categoria', 'tok_fraude_categoria');
  if ((await ordenesDe(categoria.usuario.id_usuario)) <= DIAS_HISTORIAL.length) {
    await sembrarHistorial(categoria, await ropa());
    await comprar(categoria, await hogar());
    console.log(`Señal C sembrada ahora: ${categoria.usuario.correo} (${DIAS_HISTORIAL.length} compras en Ropa y una barata en Hogar).`);
  } else {
    console.log(`Señal C: ${categoria.usuario.correo} ya estaba sembrada de una corrida anterior.`);
  }

  // --- Señal D: cuentas de una misma persona, comprando por separado. Dos
  // vínculos posibles — el mismo NOMBRE y el mismo BUZÓN de correo (el correo
  // exacto es único, pero `ana+2@x.com` y `ana@x.com` llegan a la misma
  // bandeja) — y sus combinaciones:
  //   - gemelos: mismo nombre y misma fecha de nacimiento → "alta".
  //   - homónimos: mismo nombre, fechas distintas → "posible" (pueden ser dos
  //     personas que se llaman igual).
  //   - anillo: nombres DISTINTOS, mismo buzón → "alta" por sí solo.
  //   - dual: mismo nombre Y mismo buzón, nada más que lo respalde → "alta".
  //   - cadena: A y B se llaman igual, B y C comparten buzón → una sola
  //     persona con tres cuentas (unión transitiva). ---
  const gemeloA = await prepararCuenta('fraude.gemelo.a@example.com', 'Fraude Gemelo', 'tok_fraude_gemelo_a', { nacimiento: '1992-03-03' });
  const gemeloB = await prepararCuenta('fraude.gemelo.b@example.com', 'Fraude Gemelo', 'tok_fraude_gemelo_b', { nacimiento: '1992-03-03' });
  const homonimoA = await prepararCuenta('fraude.homonimo.a@example.com', 'Fraude Homonimo', 'tok_fraude_homonimo_a', { nacimiento: '1990-01-01' });
  const homonimoB = await prepararCuenta('fraude.homonimo.b@example.com', 'Fraude Homonimo', 'tok_fraude_homonimo_b', { nacimiento: '1991-02-02' });
  const anilloA = await prepararCuenta('fraude.anillo@example.com', 'Fraude AnilloA', 'tok_fraude_anillo_a');
  const anilloB = await prepararCuenta('fraude.anillo+segunda@example.com', 'Fraude AnilloB', 'tok_fraude_anillo_b');
  const dualA = await prepararCuenta('fraude.dual@example.com', 'Fraude Dual', 'tok_fraude_dual_a', { nacimiento: '1987-01-15' });
  const dualB = await prepararCuenta('fraude.dual+otra@example.com', 'Fraude Dual', 'tok_fraude_dual_b', { nacimiento: '1994-11-30' });
  const cadenaA = await prepararCuenta('fraude.cadena.a@example.com', 'Fraude Cadena', 'tok_fraude_cadena_a', { nacimiento: '1980-02-02' });
  const cadenaB = await prepararCuenta('fraude.cadena.b@example.com', 'Fraude Cadena', 'tok_fraude_cadena_b', { nacimiento: '1981-03-03' });
  const cadenaC = await prepararCuenta('fraude.cadena.b+c@example.com', 'Fraude CadenaC', 'tok_fraude_cadena_c', { nacimiento: '1982-04-04' });
  let sembroGrupos = false;
  for (const [cuenta, producto] of [
    [gemeloA, ropa],
    [gemeloB, hogar],
    [homonimoA, ropa],
    [homonimoB, hogar],
    [anilloA, ropa],
    [anilloB, hogar],
    [dualA, hogar],
    [dualB, hogar],
    [cadenaA, hogar],
    [cadenaB, hogar],
    [cadenaC, hogar],
  ]) {
    if ((await ordenesDe(cuenta.usuario.id_usuario)) === 0) {
      await comprar(cuenta, await producto());
      sembroGrupos = true;
    }
  }
  console.log(`Señal D: gemelos, homónimos, anillo por buzón, pareja nombre+buzón y cadena de tres cuentas, cada una comprando por separado (${sembroGrupos ? 'sembrada ahora' : 'ya sembrada'}).`);

  // --- Señal F: (1) un vendedor de prueba y un comprador que se llaman igual
  // — el comprador le compra al vendedor; (2) lo mismo con nombres DISTINTOS
  // pero el mismo buzón; (3) un vendedor que se compró a sí mismo ANTES de la
  // regla de §18 (checkout() ya no lo permite). ---
  const vendedorA = await prepararCuenta('fraude.autocompra.vendedor@example.com', 'Fraude Autocompra', 'tok_fraude_autocompra_v', { rol: 'vendedor', nacimiento: '1988-05-05' });
  const compradorA = await prepararCuenta('fraude.autocompra.comprador@example.com', 'Fraude Autocompra', 'tok_fraude_autocompra_c', { nacimiento: '1993-07-07' });
  const productoA = await asegurarProducto(vendedorA.usuario, '[PRUEBA fraude] Producto del vendedor Fraude Autocompra', 150);
  const vendedorM = await prepararCuenta('fraude.autobuzon+tienda@example.com', 'Fraude AutoBuzonV', 'tok_fraude_autobuzon_v', { rol: 'vendedor', nacimiento: '1986-06-06' });
  const compradorM = await prepararCuenta('fraude.autobuzon@example.com', 'Fraude AutoBuzonC', 'tok_fraude_autobuzon_c', { nacimiento: '1985-04-04' });
  const productoM = await asegurarProducto(vendedorM.usuario, '[PRUEBA fraude] Producto del vendedor Fraude AutoBuzon', 90);
  const vendedorB = await prepararCuenta('fraude.autoventa@example.com', 'Fraude Autoventa', 'tok_fraude_autoventa', { rol: 'vendedor' });
  const productoB = await asegurarProducto(vendedorB.usuario, '[PRUEBA fraude] Producto del vendedor Fraude Autoventa', 120);
  let sembroAutocompra = false;
  if ((await ordenesDe(compradorA.usuario.id_usuario)) === 0) {
    await conProductoActivo(productoA, () => comprar(compradorA, productoA));
    sembroAutocompra = true;
  }
  // Para que el vendedor A también cuente como cuenta que compra (el grupo de
  // personas exige ≥2 cuentas con compras), compra algo ajeno.
  if ((await ordenesDe(vendedorA.usuario.id_usuario)) === 0) {
    await comprar(vendedorA, await ropa());
    sembroAutocompra = true;
  }
  // El vendedor del par por buzón NO compra: solo vende. Que el grupo D no se
  // dispare (hace falta ≥2 cuentas COMPRANDO) y F sí, es justo lo que se prueba.
  if ((await ordenesDe(compradorM.usuario.id_usuario)) === 0) {
    await conProductoActivo(productoM, () => comprar(compradorM, productoM));
    sembroAutocompra = true;
  }
  // checkout() ya rechaza que una cuenta compre su propio producto (§18): se
  // comprueba el rechazo, y para tener una autocompra "de antes de la regla"
  // se siembra un pedido histórico directo en MySQL.
  let rechazoAutocompra = null;
  try {
    await comprar(vendedorB, productoB);
  } catch (err) {
    rechazoAutocompra = err;
  }
  afirmar(rechazoAutocompra?.status === 403, `checkout() debería rechazar con 403 que un vendedor compre su propio producto (llegó: ${rechazoAutocompra?.status ?? 'ningún error'})`);
  if ((await ordenesDe(vendedorB.usuario.id_usuario)) === 0) {
    await sembrarCompraHistorica(vendedorB, productoB);
    sembroAutocompra = true;
  }
  console.log(`Señal F: comprador a vendedor con el mismo nombre, con el mismo buzón, y vendedor que se compró a sí mismo antes de la regla (${sembroAutocompra ? 'sembrada ahora' : 'ya sembrada'}).`);

  // --- Señal E: (1) una cuenta nueva con 6 pedidos baratos en un mismo día
  // (volumen); (2) una cuenta con 4 días de compras chicas que un día hace 3
  // pedidos de ~Q180 — cada uno "normal", el día no. ---
  const rafagaA = await prepararCuenta('fraude.rafaga.a@example.com', 'Fraude RafagaA', 'tok_fraude_rafaga_a');
  const rafagaB = await prepararCuenta('fraude.rafaga.b@example.com', 'Fraude RafagaB', 'tok_fraude_rafaga_b');
  let sembroRafagas = false;
  if ((await ordenesDe(rafagaA.usuario.id_usuario)) === 0) {
    const barata = await ropa();
    const dia = ayerEnLaManana();
    for (let i = 0; i < 6; i += 1) await comprar(rafagaA, barata, new Date(dia.getTime() + i * 5 * 60000));
    sembroRafagas = true;
  }
  if ((await ordenesDe(rafagaB.usuario.id_usuario)) === 0) {
    const barata = await ropa();
    for (const dias of [12, 9, 6, 3]) await comprar(rafagaB, barata, haceDias(dias));
    const media = await ropaMedia();
    const dia = ayerEnLaManana();
    for (let i = 0; i < 3; i += 1) await comprar(rafagaB, media, new Date(dia.getTime() + i * 5 * 60000));
    sembroRafagas = true;
  }
  console.log(`Señal E: ráfaga de volumen (cuenta nueva) y ráfaga de gasto con pedidos normales (${sembroRafagas ? 'sembrada ahora' : 'ya sembrada'}).`);

  // El reenvío a Neo4j es de mejor esfuerzo — dar un margen breve antes de
  // consultar, aunque en la práctica ya corrió dentro de cada await de arriba.
  await new Promise((r) => setTimeout(r, 500));

  const resultado = await fraudeService.consultarFraude();
  console.log(`Advertencias: ${JSON.stringify(resultado.advertencias)}`);
  afirmar(resultado.advertencias.length === 0, 'alguna señal falló al evaluarse');
  const id = (cuenta) => cuenta.usuario.id_usuario;
  const ids = (...cuentas) => cuentas.map(id);
  const grupoCon = (...cuentas) =>
    resultado.cuentasRelacionadas.find((a) => ids(...cuentas).every((i) => a.miembros.some((m) => m.id === i)));
  // Qué vínculos forman un grupo, p. ej. "correo+nombre".
  const vinculos = (grupo) => [...new Set(grupo.vinculos.map((v) => v.tipo))].sort().join('+');

  // --- A ---
  const par = resultado.resenasCoordinadas.find(
    (r) => [r.usuario1.id, r.usuario2.id].includes(id(test1)) && [r.usuario1.id, r.usuario2.id].includes(id(test2))
  );
  afirmar(par, 'no se encontró el par de reseñas coordinadas sembrado');
  afirmar(par.productosCompartidos >= 3, 'el par no comparte los 3 productos esperados');
  console.log(`A OK: ${par.usuario1.nombre} / ${par.usuario2.nombre}, ${par.productosCompartidos} productos compartidos.`);

  // --- D ---
  const gemelos = grupoCon(gemeloA, gemeloB);
  afirmar(gemelos, 'no se encontró el grupo de cuentas con el mismo nombre (Fraude Gemelo)');
  afirmar(vinculos(gemelos) === 'nombre', `los gemelos solo comparten nombre (sus buzones son distintos), no "${vinculos(gemelos)}"`);
  afirmar(gemelos.mismaFechaNacimiento && gemelos.corroboradores.some((c) => c.tipo === 'fechaNacimiento'), 'la misma fecha de nacimiento debe corroborar al grupo');
  afirmar(gemelos.nivelConfianza === 'alta', 'mismo nombre + misma fecha de nacimiento debe marcarse con confianza alta');
  const homonimos = grupoCon(homonimoA, homonimoB);
  afirmar(homonimos, 'no se encontró el grupo de cuentas con el mismo nombre (Fraude Homonimo)');
  afirmar(vinculos(homonimos) === 'nombre', 'los homónimos solo comparten nombre');
  afirmar(homonimos.nivelConfianza === 'posible' && homonimos.corroboradores.length === 0 && !homonimos.mismaFechaNacimiento, 'el nombre solo, con fechas de nacimiento distintas, debe quedar en "posible" sin corroboradores');
  const conVendedor = grupoCon(vendedorA, compradorA);
  afirmar(conVendedor && conVendedor.corroboradores.some((c) => c.tipo === 'autocompra') && conVendedor.nivelConfianza === 'alta', 'un grupo con una autocompra entre sus miembros debe subir a confianza alta');

  // Por buzón: nombres distintos, así que lo único que las une es la bandeja.
  const anillo = grupoCon(anilloA, anilloB);
  afirmar(anillo, 'no se encontró el grupo por buzón compartido (fraude.anillo / fraude.anillo+segunda)');
  afirmar(vinculos(anillo) === 'correo', `las cuentas del anillo tienen nombres distintos: el único vínculo debe ser el buzón, no "${vinculos(anillo)}"`);
  afirmar(anillo.nivelConfianza === 'alta', 'compartir buzón es evidencia fuerte por sí sola: debe marcarse con confianza alta');
  afirmar(anillo.miembros.some((m) => m.ficha?.correo === 'fraude.anillo+segunda@example.com'), 'la ficha del administrador debe mostrar el correo legible (resuelto desde MySQL)');
  afirmar(
    !JSON.stringify(resultado).includes(fraudeSyncService.hashCorreo('fraude.anillo@example.com')),
    'la respuesta nunca debe traer el hash del buzón: es un detalle interno del grafo'
  );
  // Nombre Y buzón, sin fecha de nacimiento común ni otra señal: el buzón sostiene solo.
  const dual = grupoCon(dualA, dualB);
  afirmar(dual, 'no se encontró la pareja con el mismo nombre y el mismo buzón (fraude.dual)');
  afirmar(vinculos(dual) === 'correo+nombre', `la pareja comparte nombre Y buzón, y el grupo debe traer los dos vínculos, no "${vinculos(dual)}"`);
  afirmar(!dual.mismaFechaNacimiento && dual.corroboradores.length === 0, 'control: sin fecha de nacimiento común ni otra señal, el único respaldo de la pareja es el propio buzón');
  afirmar(dual.nivelConfianza === 'alta', 'nombre + buzón compartido debe marcarse con confianza alta aunque nada más lo corrobore');
  // A y B se llaman igual; B y C comparten buzón: UNA persona con tres cuentas.
  const cadena = grupoCon(cadenaA, cadenaB, cadenaC);
  afirmar(cadena && cadena.miembros.length === 3, 'A y B comparten nombre, B y C comparten buzón: las tres cuentas deben quedar en UN solo grupo (unión transitiva)');
  afirmar(vinculos(cadena) === 'correo+nombre' && cadena.vinculos.length === 2, 'la cadena debe conservar sus dos vínculos (uno por nombre, otro por buzón)');
  afirmar(cadena.nivelConfianza === 'alta', 'un grupo con un vínculo por buzón debe marcarse con confianza alta');
  afirmar(/mismo buzón de correo/.test(cadena.motivo) && /se llaman exactamente igual/.test(cadena.motivo), 'el motivo debe explicar los dos vínculos');

  afirmar(!grupoCon(test1, test2), 'control negativo: dos cuentas con nombres y buzones DISTINTOS no deben formar un grupo');
  afirmar(!grupoCon(gemeloA, homonimoA), 'control negativo: "Fraude Gemelo" y "Fraude Homonimo" son nombres distintos y no deben mezclarse');
  afirmar(!grupoCon(dualA, cadenaA) && !grupoCon(anilloA, dualA), 'control negativo: parejas distintas con buzones distintos no deben fundirse en un solo grupo');
  console.log(
    `D OK: "${gemelos.nombre}" → alta (misma fecha de nacimiento); "${homonimos.nombre}" → posible (sin corroboradores); ` +
      `anillo por buzón → alta; nombre+buzón → alta sin corroboradores; cadena de ${cadena.miembros.length} cuentas unida.`
  );

  // --- F ---
  const autocompraEntre = resultado.autocompra.find((f) => f.comprador.id === id(compradorA) && f.vendedor.id === id(vendedorA));
  afirmar(autocompraEntre && !autocompraEntre.mismaCuenta, 'no se encontró la autocompra entre el comprador y el vendedor que se llaman igual');
  afirmar(autocompraEntre.mismoNombre && !autocompraEntre.mismoBuzon, 'esta pareja se llama igual pero NO comparte buzón');
  afirmar(autocompraEntre.nivelConfianza === 'alta', 'autocompra entre cuentas con el mismo nombre debe marcarse con confianza alta');
  afirmar(autocompraEntre.pedidos === 1 && Math.abs(autocompraEntre.total - productoA.precio) < 0.01, 'la autocompra debe sumar el único pedido de Q150');
  const autocompraBuzon = resultado.autocompra.find((f) => f.comprador.id === id(compradorM) && f.vendedor.id === id(vendedorM));
  afirmar(autocompraBuzon && !autocompraBuzon.mismaCuenta, 'no se encontró la autocompra entre el comprador y el vendedor con el mismo buzón');
  afirmar(autocompraBuzon.mismoBuzon && !autocompraBuzon.mismoNombre, 'esta pareja tiene nombres distintos: lo único en común es el buzón');
  afirmar(autocompraBuzon.nivelConfianza === 'alta', 'autocompra entre cuentas con el mismo buzón debe marcarse con confianza alta');
  afirmar(/mismo buzón de correo/.test(autocompraBuzon.motivo), 'el motivo debe explicar que comparten buzón');
  afirmar(!grupoCon(compradorM, vendedorM), 'control: el vendedor nunca compró, así que no hay dos cuentas COMPRANDO — el grupo D no se dispara, la señal F sí');
  const autoventa = resultado.autocompra.find((f) => f.comprador.id === id(vendedorB) && f.mismaCuenta);
  afirmar(autoventa, 'no se encontró la autocompra de un vendedor consigo mismo (pedido histórico)');
  afirmar(autoventa.nivelConfianza === 'posible' && autoventa.corroboradores.length === 0, 'un vendedor que se compró a sí mismo, sin otra señal, debe quedar en "posible"');
  afirmar(
    !resultado.autocompra.some((f) => f.comprador.id === id(test1) || f.comprador.id === id(gasto)),
    'control negativo: comprar a un vendedor ajeno no es autocompra'
  );
  console.log(`F OK: ${autocompraEntre.comprador.nombre} → ${autocompraEntre.vendedor.nombre} (mismo nombre, alta); ${autocompraBuzon.comprador.nombre} → ${autocompraBuzon.vendedor.nombre} (mismo buzón, alta); autoventa histórica de ${autoventa.comprador.nombre} (posible).`);

  // --- E ---
  const rafagaVolumen = resultado.rafagaGasto.find((r) => r.usuario.id === id(rafagaA));
  afirmar(rafagaVolumen, 'no se encontró la ráfaga de volumen sembrada (fraude.rafaga.a)');
  afirmar(rafagaVolumen.reglas.muchosPedidos && rafagaVolumen.pedidos === 6 && rafagaVolumen.maxPedidos === 0, 'la ráfaga de volumen debe ser de 6 pedidos sobre una cuenta sin historial');
  afirmar(rafagaVolumen.nivelConfianza === 'posible', 'una ráfaga sin otra señal debe quedar en "posible"');
  const rafagaMonto = resultado.rafagaGasto.find((r) => r.usuario.id === id(rafagaB));
  afirmar(rafagaMonto, 'no se encontró la ráfaga de gasto sembrada (fraude.rafaga.b)');
  afirmar(rafagaMonto.reglas.muchoGasto && !rafagaMonto.reglas.muchosPedidos && rafagaMonto.pedidos === 3, 'la ráfaga de gasto debe ser de 3 pedidos que juntos superan lo habitual');
  afirmar(rafagaMonto.diasPrevios >= 3, 'la ráfaga de gasto exige al menos 3 días previos con compras');
  afirmar(
    !resultado.gastoAnomalo.some((g) => g.usuario.id === id(rafagaB)),
    'ningún pedido de fraude.rafaga.b debe ser un gasto anómalo por separado — la señal es el DÍA, no el pedido'
  );
  afirmar(!resultado.rafagaGasto.some((r) => r.usuario.id === id(gasto)), 'control negativo: un solo pedido grande es gasto anómalo (B), no una ráfaga');
  console.log(
    `E OK: ${rafagaVolumen.usuario.nombre} ${rafagaVolumen.pedidos} pedidos en un día (sin historial); ` +
      `${rafagaMonto.usuario.nombre} ${rafagaMonto.pedidos} pedidos = Q${rafagaMonto.gastado.toFixed(2)} vs. Q${rafagaMonto.promedioGasto.toFixed(2)} habitual.`
  );

  // --- B ---
  const gastoHallado = resultado.gastoAnomalo.find((g) => g.usuario.id === id(gasto));
  afirmar(gastoHallado, 'no se encontró el gasto anómalo sembrado (fraude.gasto)');
  afirmar(gastoHallado.lineas.some((l) => l.categoria === 'Electrónica') && gastoHallado.total >= 1000, `el hallazgo (Q${gastoHallado.total}) no corresponde a la compra cara en Electrónica`);
  afirmar(gastoHallado.ordenesPrevias === DIAS_HISTORIAL.length, `se esperaban ${DIAS_HISTORIAL.length} compras previas, hubo ${gastoHallado.ordenesPrevias}`);
  afirmar(gastoHallado.vecesPromedio >= 3, 'el gasto señalado debería ser al menos 3 veces el promedio previo');
  afirmar(gastoHallado.corroboradores.some((c) => c.tipo === 'categoriaInusual'), 'el gasto anómalo debería estar corroborado por la categoría inusual de la MISMA compra');
  afirmar(gastoHallado.nivelConfianza === 'alta', 'gasto anómalo corroborado debe marcarse con confianza alta');
  afirmar(!resultado.gastoAnomalo.some((g) => g.usuario.id === id(categoria)), 'control negativo: una compra barata no debe ser gasto anómalo');
  console.log(`B OK: ${gastoHallado.usuario.nombre} gastó Q${gastoHallado.total.toFixed(2)}, ${gastoHallado.vecesPromedio.toFixed(1)}× su promedio de Q${gastoHallado.promedio.toFixed(2)}, confianza ${gastoHallado.nivelConfianza}.`);

  // --- C ---
  const catGasto = resultado.categoriaInusual.find((c) => c.usuario.id === id(gasto));
  afirmar(catGasto, 'no se encontró la categoría inusual de fraude.gasto (Electrónica)');
  afirmar(catGasto.categoria === 'Electrónica', `se esperaba Electrónica, salió "${catGasto.categoria}"`);
  afirmar(catGasto.habituales[0]?.categoria === 'Ropa', 'la categoría habitual debería ser Ropa');
  afirmar(catGasto.corroboradores.some((c) => c.tipo === 'gastoAnomalo') && catGasto.nivelConfianza === 'alta', 'categoría + gasto en la misma compra debe marcarse con confianza alta');
  const catSola = resultado.categoriaInusual.find((c) => c.usuario.id === id(categoria));
  afirmar(catSola, 'no se encontró la categoría inusual de fraude.categoria (Hogar)');
  afirmar(catSola.categoria === 'Hogar', `se esperaba Hogar, salió "${catSola.categoria}"`);
  afirmar(catSola.nivelConfianza === 'posible' && catSola.corroboradores.length === 0, 'una categoría inusual SIN otra señal debe quedar en "posible"');
  afirmar(catSola.ordenesPrevias >= 5 && catSola.diasHistorial >= 30, 'el historial exigido (5 compras, 30 días) no se cumplió en el hallazgo');
  console.log(`C OK: ${catGasto.usuario.nombre} → ${catGasto.categoria} (${catGasto.nivelConfianza}); ${catSola.usuario.nombre} → ${catSola.categoria} (${catSola.nivelConfianza}).`);

  // --- Forma del grafo: nada de dirección ni método de pago; el buzón, solo como hash ---
  afirmar(resultado.desviacionPatron === undefined && resultado.anillosCorreo === undefined, 'la respuesta no debería traer las señales de dirección ni la vieja "anillo por correo"');
  const contar = async (consulta) => (await neo4j.leer(consulta))[0].get('n').toNumber();
  afirmar(
    (await contar('MATCH (n) WHERE n:Direccion OR n:MetodoPago RETURN count(n) AS n')) === 0 &&
      (await contar('MATCH ()-[r]->() WHERE type(r) IN ["ENVIÓ_A", "PAGÓ_CON"] RETURN count(r) AS n')) === 0,
    'el grafo todavía tiene nodos/relaciones de dirección o método de pago'
  );
  afirmar((await contar('MATCH ()-[r:VENDE]->() RETURN count(r) AS n')) > 0, 'el grafo debería tener relaciones VENDE (quién vende cada producto comprado)');
  afirmar((await contar('MATCH (u:Usuario) WHERE NOT (u)-[:USA_CORREO]->(:Correo) RETURN count(u) AS n')) === 0, 'todo Usuario del grafo debe tener su buzón (USA_CORREO)');
  afirmar(
    (await contar("MATCH (e:Correo) WHERE NOT e.hash =~ '[0-9a-f]{64}' OR size(keys(e)) <> 1 RETURN count(e) AS n")) === 0,
    'un nodo Correo debe tener únicamente el SHA-256 del buzón'
  );
  afirmar(
    (await contar("MATCH (n) WHERE any(k IN keys(n) WHERE toStringOrNull(properties(n)[k]) CONTAINS '@') RETURN count(n) AS n")) === 0,
    'ningún nodo del grafo debe guardar un correo en claro'
  );
  console.log('OK: el grafo no contiene direcciones ni métodos de pago, guarda quién vende cada producto y el buzón solo como hash (ningún correo en claro).');

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
    // checkout() invalida la caché del carrito en Redis: sin cerrarlo, esa
    // conexión mantiene vivo el proceso después de terminar.
    redis.cerrar();
  });
