require('dotenv').config();
const { textosParaGrafo } = require('../src/utils/textosProducto');
const mongoose = require('mongoose');
const prisma = require('../src/config/prisma');
const neo4j = require('../src/config/neo4j');
const redis = require('../src/config/redis');
const Categoria = require('../src/models/mongo/Categoria');
const Subcategoria = require('../src/models/mongo/Subcategoria');
const Producto = require('../src/models/mongo/Producto');
const Resena = require('../src/models/mongo/Resena');
const { conectar: conectarMongo } = require('../src/config/mongo');
const { checkout } = require('../src/services/checkoutService');
const resenaService = require('../src/services/resenaService');
const productoService = require('../src/services/productoService');
const fraudeService = require('../src/services/fraudeService');
const fraudeSyncService = require('../src/services/fraudeSyncService');
const { afirmar, prepararCuenta, asegurarProducto, conProductoActivo } = require('./lib/datosPrueba');

// Evidencia de funcionamiento de las siete señales de fraude (Entrega 2, ver
// IA/PLAN-NEO4J-DETECCION-FRAUDE.md §17-§19): A reseñas coordinadas, B gasto
// anómalo, C categoría inusual, D cuentas de una misma persona (mismo nombre o
// mismo buzón de correo), E ráfaga de gasto, F autocompra, G reventa de lo
// comprado. Con el catálogo y las cuentas de prueba reales casi ninguna consulta
// encuentra nada (ver plan §8): siembra los patrones, documentados como
// sintéticos, corriendo checkout()/resenaService.crear()/productoService.crear()
// REALES (no MERGE directo a Neo4j) para probar el camino en vivo de punta a
// punta, no solo las consultas de lectura.
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

// Cuentas, direcciones, métodos de pago y productos sintéticos (`afirmar`,
// `prepararCuenta`, `asegurarProducto`, `conProductoActivo`) viven en
// scripts/lib/datosPrueba.js: los comparte verificarCompromisoReventa.js.

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
    if (inventario && inventario.cantidad >= unidades) return { id: c.producto_id, nombre: c.nombre, descripcion: c.descripcion, precio: Number(inventario.precio) };
  }
  throw new Error(`No hay un producto de "${categoria}" entre Q${precioMin} y Q${precioMax} con ${unidades}+ unidades de stock real.`);
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
      .select('nombre descripcion subcategoria_id vendedor_id vendedor_nombre')
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
      ...textosParaGrafo(producto),
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
// Siempre acepta el compromiso de no reventa, como lo haría el aviso del
// frontend: a un comprador no le cambia nada (el servidor lo ignora) y a una
// cuenta que puede vender se lo exige y lo deja asentado en el pedido.
async function comprar(cuenta, productos, fecha = null) {
  const { compra } = await checkout({
    usuarioId: cuenta.usuario.id_usuario,
    direccionId: cuenta.direccion.id,
    metodoPagoId: cuenta.metodoPago.id,
    items: [].concat(productos).map((p) => ({ productoId: p.id, cantidad: 1 })),
    aceptaNoReventa: true,
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

// Cambia el estado de una publicación SOLO mientras dura una comprobación, y lo
// restaura siempre. Va directo a Mongo, sin pasar por el historial de ediciones:
// re-correr el script no acumula versiones del producto de prueba.
async function conEstado(productoId, estado, accion) {
  const antes = (await Producto.findOne({ producto_id: productoId }).select('estado').lean()).estado;
  await Producto.updateOne({ producto_id: productoId }, { $set: { estado } });
  try {
    return await accion();
  } finally {
    await Producto.updateOne({ producto_id: productoId }, { $set: { estado: antes } });
  }
}

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

  // --- Clave canónica de un artículo (también pura): decide cuándo dos
  // productos son "el mismo artículo" para la señal de reventa ---
  const { claveArticulo } = fraudeSyncService;
  afirmar(
    claveArticulo('Camiseta premium de algodón orgánico') === claveArticulo('ALGODÓN orgánico, camiseta PREMIUM'),
    'mayúsculas, tildes, puntuación y el orden de las palabras no deben distinguir un artículo'
  );
  afirmar(claveArticulo('Taza de cerámica') === claveArticulo('Taza ceramica'), 'los artículos y preposiciones ("de") no cuentan');
  afirmar(claveArticulo('Smartphone X100') !== claveArticulo('Smartphone X200'), 'el modelo (los números) SÍ distingue un artículo');
  afirmar(claveArticulo('Sartén antiadherente') !== claveArticulo('Sarten antiadherente 26cm'), 'comparación exacta: una medida de más es otro producto');
  afirmar(claveArticulo('de la') !== '', 'una descripción hecha solo de palabras vacías no puede quedar con clave vacía');
  console.log('OK: clave de artículo (orden, tildes, mayúsculas y "de/la" no cuentan; el modelo y las medidas sí).');

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

  // --- Señal G: reventa. Un vendedor (mayorista) publica un producto; otro
  // vendedor (revendedor) se lo compra —aceptando el compromiso de no reventa— y
  // DESPUÉS publica uno con la misma descripción y los mismos atributos. Todo por
  // los servicios reales: checkout() para la compra y productoService.crear()/
  // actualizar() para la publicación (así se prueba el reenvío al grafo del alta).
  // Un segundo vendedor (competidor) ya vendía el suyo ANTES de comprar el del
  // mayorista y con atributos distintos: el mismo patrón, pero sin corroboración. ---
  const mayorista = await prepararCuenta('fraude.mayorista@example.com', 'Fraude Mayorista', 'tok_fraude_mayorista', { rol: 'vendedor', nacimiento: '1984-02-02' });
  const revendedor = await prepararCuenta('fraude.revendedor@example.com', 'Fraude Revendedor', 'tok_fraude_revendedor', { rol: 'vendedor', nacimiento: '1991-08-08' });
  const competidor = await prepararCuenta('fraude.competidor@example.com', 'Fraude Competidor', 'tok_fraude_competidor', { rol: 'vendedor', nacimiento: '1989-12-12' });
  const cocina = await Subcategoria.findOne({ subcategoria: 'Cocina' });
  afirmar(cocina, 'no existe la subcategoría "Cocina" en el catálogo');
  const TITULO_RELOJ = '[PRUEBA fraude] Reloj de pared reventa';
  const ATRIBUTOS_RELOJ = [{ nombre: 'Material', valor: 'Metal' }, { nombre: 'Color', valor: 'Negro' }];
  const TITULO_LAMPARA = '[PRUEBA fraude] Lámpara de mesa reventa';
  const relojOriginal = await asegurarProducto(mayorista.usuario, TITULO_RELOJ, 80, { subcategoria: 'Cocina', atributos: ATRIBUTOS_RELOJ, cantidad: 10 });
  const lamparaOriginal = await asegurarProducto(mayorista.usuario, TITULO_LAMPARA, 60, { subcategoria: 'Cocina', atributos: [{ nombre: 'Material', valor: 'Vidrio' }], cantidad: 10 });
  const comoVendedor = (cuenta) => ({ id_usuario: cuenta.usuario.id_usuario, rol: 'vendedor' });
  const compro = (cuenta, producto) =>
    prisma.compra_detalle.count({ where: { id_producto: producto.id, compra: { id_usuario: cuenta.usuario.id_usuario } } });
  let sembroReventa = false;

  // (1) Sin aceptar el compromiso, el servidor no deja comprar a una cuenta que
  // puede vender: se rechaza ANTES de tocar nada (ni stock ni pedido).
  const pedidosAntes = await prisma.compra.count({ where: { id_usuario: revendedor.usuario.id_usuario } });
  let sinCompromiso = null;
  try {
    await checkout({
      usuarioId: revendedor.usuario.id_usuario,
      direccionId: revendedor.direccion.id,
      metodoPagoId: revendedor.metodoPago.id,
      items: [{ productoId: relojOriginal.id, cantidad: 1 }],
    });
  } catch (err) {
    sinCompromiso = err;
  }
  afirmar(
    sinCompromiso?.status === 400 && sinCompromiso.codigo === 'COMPROMISO_NO_REVENTA',
    `un vendedor que no acepta el compromiso de no reventa debe recibir 400 COMPROMISO_NO_REVENTA (llegó: ${sinCompromiso?.status ?? 'ningún error'})`
  );
  afirmar((await prisma.compra.count({ where: { id_usuario: revendedor.usuario.id_usuario } })) === pedidosAntes, 'el rechazo por falta de compromiso no debe dejar ningún pedido');

  // (2) Con la aceptación sí compra, y el pedido guarda la constancia.
  if ((await compro(revendedor, relojOriginal)) === 0) {
    await conProductoActivo(relojOriginal, () => comprar(revendedor, relojOriginal));
    sembroReventa = true;
  }
  const pedidoReloj = await prisma.compra.findFirst({
    where: { id_usuario: revendedor.usuario.id_usuario, compra_detalles: { some: { id_producto: relojOriginal.id } } },
    orderBy: { id: 'asc' },
  });
  afirmar(pedidoReloj.no_reventa_aceptada_en instanceof Date, 'el pedido de un vendedor debe guardar la constancia del compromiso de no reventa');

  // (3) La publicación equivalente, DESPUÉS de comprar: por el alta real de
  // producto (nace pausada, así no aparece en la tienda hasta que se activa).
  let relojPropio = await Producto.findOne({ nombre: TITULO_RELOJ, vendedor_id: revendedor.usuario.id_usuario }).lean();
  if (!relojPropio) {
    const creado = await productoService.crear(comoVendedor(revendedor), {
      nombre: TITULO_RELOJ, descripcion: 'Reloj usado en la prueba de reventa.', subcategoriaId: cocina._id, precio: 110, cantidad: 2, estado: 'inactivo', atributos: ATRIBUTOS_RELOJ,
    });
    relojPropio = { producto_id: creado.id, estado: 'inactivo' };
    sembroReventa = true;
  }
  // El alta tiene que haber llegado al grafo (reenvío de mejor esfuerzo, así que se
  // comprueba en vez de suponerlo), ya enlazada a su artículo.
  const articuloDe = async (productoId) => {
    const [fila] = await neo4j.leer('MATCH (p:Producto {producto_id: $id})-[:ES_ARTICULO]->(a:Articulo) RETURN count(a) AS n, collect(a.clave)[0] AS clave', { id: productoId });
    return { n: fila.get('n').toNumber(), clave: fila.get('clave') };
  };
  const enlace = await articuloDe(relojPropio.producto_id);
  afirmar(enlace.n === 1 && enlace.clave === fraudeSyncService.claveArticulo(TITULO_RELOJ), 'el alta de un producto debe reenviarse al grafo, enlazado a UN solo artículo');
  // Lo "vende hoy" exige estado activo: la activa por la edición real del vendedor
  // (que además prueba el reenvío de la edición) y se queda activa.
  const estadoReloj = (await Producto.findOne({ producto_id: relojPropio.producto_id }).select('estado').lean()).estado;
  if (estadoReloj !== 'activo') {
    await productoService.actualizar(comoVendedor(revendedor), relojPropio.producto_id, { estado: 'activo' });
    sembroReventa = true;
  }

  // (4) El competidor: ya vendía su lámpara (atributos distintos) y después compra
  // la del mayorista, que se llama igual. La publicación nace ANTES de la compra.
  let lamparaPropia = await Producto.findOne({ nombre: TITULO_LAMPARA, vendedor_id: competidor.usuario.id_usuario }).lean();
  if (!lamparaPropia) {
    const creada = await productoService.crear(comoVendedor(competidor), {
      nombre: TITULO_LAMPARA, descripcion: 'Lámpara de cerámica para mesa.', subcategoriaId: cocina._id, precio: 75, cantidad: 2, estado: 'inactivo', atributos: [{ nombre: 'Material', valor: 'Cerámica' }],
    });
    lamparaPropia = { producto_id: creada.id };
    sembroReventa = true;
  }
  if ((await compro(competidor, lamparaOriginal)) === 0) {
    await conProductoActivo(lamparaOriginal, () => comprar(competidor, lamparaOriginal));
    sembroReventa = true;
  }
  console.log(`Señal G: un vendedor que le compra un producto a otro y publica uno equivalente después, y un competidor que ya vendía el suyo antes de comprarlo (${sembroReventa ? 'sembrada ahora' : 'ya sembrada'}).`);

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

  // --- G ---
  const reventa = resultado.reventa.find((h) => h.vendedor.id === id(revendedor) && h.publicacion.id === relojPropio.producto_id);
  afirmar(reventa, 'no se encontró la reventa sembrada (fraude.revendedor)');
  afirmar(
    reventa.originales.length === 1 && reventa.originales[0].producto.id === relojOriginal.id && reventa.originales[0].vendedor.id === id(mayorista),
    'el original comprado debe ser el reloj del mayorista'
  );
  afirmar(reventa.originales[0].unidades === 1 && Math.abs(reventa.originales[0].precioUnitario - 80) < 0.01, 'el hallazgo debe citar 1 unidad a Q80');
  afirmar(reventa.listadaDespues && reventa.corroboradores.some((c) => c.tipo === 'publicadaDespuesDeComprar'), 'publicar DESPUÉS de comprar debe corroborar');
  afirmar(reventa.mismosAtributos && reventa.corroboradores.some((c) => c.tipo === 'mismosAtributos'), 'atributos idénticos deben corroborar');
  afirmar(reventa.nivelConfianza === 'alta', 'misma descripción + publicada después + mismos atributos debe marcarse con confianza alta');
  afirmar(
    reventa.publicacion.estado === 'activo' && reventa.publicacion.cantidad === 2 && Math.abs(reventa.publicacion.precio - 110) < 0.01,
    'la publicación se resuelve EN VIVO del catálogo: activa, 2 en stock, Q110'
  );
  afirmar(Math.abs(reventa.variacionPrecio - (110 / 80 - 1)) < 0.001, 'la publica a Q110 contra los Q80 que pagó: +37.5%');
  afirmar(
    reventa.compromiso.pedidos === 1 && reventa.compromiso.aceptados === 1 && reventa.compromiso.primeraAceptacion,
    'el hallazgo debe citar la constancia del compromiso de no reventa del pedido'
  );
  afirmar(/aceptó expresamente el compromiso de no reventa/.test(reventa.motivo), 'el motivo debe citar el compromiso asentado');
  afirmar(!resultado.reventa.some((h) => h.vendedor.id === id(mayorista)), 'control negativo: el vendedor ORIGINAL no revende, vende lo suyo');
  afirmar(!resultado.reventa.some((h) => h.vendedor.id === id(vendedorA)), 'control negativo: fraude.autocompra.vendedor compró algo y vende otra cosa, no es reventa');
  afirmar(!resultado.reventa.some((h) => h.vendedor.id === id(compradorA)), 'control negativo: una cuenta que no vende nada no puede revender');

  // Sin otra evidencia, la misma coincidencia queda en "posible": la publicación
  // del competidor ya existía antes de la compra y sus atributos difieren.
  const competencia = await conEstado(lamparaPropia.producto_id, 'activo', async () => {
    const r = await fraudeService.consultarFraude();
    return r.reventa.find((h) => h.vendedor.id === id(competidor) && h.publicacion.id === lamparaPropia.producto_id);
  });
  afirmar(competencia, 'el competidor también compró algo equivalente a lo que vende: debe aparecer');
  afirmar(!competencia.listadaDespues && !competencia.mismosAtributos, 'su publicación es anterior a la compra y sus atributos difieren');
  afirmar(competencia.nivelConfianza === 'posible' && competencia.corroboradores.length === 0, 'sin corroboración, la reventa queda en "posible"');
  afirmar(/no llevan constancia|aceptó expresamente/.test(competencia.motivo), 'el motivo debe decir si hay o no un compromiso asentado');

  // "Hoy lo vende" se lee EN VIVO del catálogo: pausar la publicación hace
  // desaparecer el hallazgo (es lo que debe pasar: ya no lo está vendiendo).
  const sigueTrasPausar = await conEstado(relojPropio.producto_id, 'inactivo', async () =>
    (await fraudeService.consultarFraude()).reventa.some((h) => h.publicacion.id === relojPropio.producto_id)
  );
  afirmar(!sigueTrasPausar, 'una publicación pausada no está "vendiéndose hoy": el hallazgo debe desaparecer');

  // Un nombre editado se vuelve a enlazar al artículo que le toca: con otro
  // título deja de coincidir (y el enlace viejo se borra), y al volver, reaparece.
  const reenviarTitulo = (titulo) =>
    fraudeSyncService.registrarProducto({
      productoId: relojPropio.producto_id,
      productoNombre: titulo,
      productoDescripcion: relojPropio.descripcion,
      subcategoriaId: cocina._id,
      vendedorId: id(revendedor),
      vendedorNombre: `${revendedor.usuario.nombres} ${revendedor.usuario.apellidos}`,
    });
  let sigueConOtroTitulo;
  try {
    await reenviarTitulo('[PRUEBA fraude] Un título sin relación alguna');
    afirmar((await articuloDe(relojPropio.producto_id)).n === 1, 'tras editar la descripción el producto debe seguir enlazado a UN solo artículo (el viejo se desenlaza)');
    sigueConOtroTitulo = (await fraudeService.consultarFraude()).reventa.some((h) => h.publicacion.id === relojPropio.producto_id);
  } finally {
    await reenviarTitulo(TITULO_RELOJ);
  }
  afirmar(!sigueConOtroTitulo, 'con otra descripción ya no es el mismo artículo: el hallazgo debe desaparecer');
  afirmar(
    (await fraudeService.consultarFraude()).reventa.some((h) => h.publicacion.id === relojPropio.producto_id),
    'al restaurar la descripción el hallazgo debe reaparecer'
  );
  console.log(
    `G OK: ${reventa.vendedor.nombre} compró "${reventa.originales[0].producto.nombre}" a ${reventa.originales[0].vendedor.nombre} y hoy lo vende (alta: publicó después + mismos atributos, +${Math.round(reventa.variacionPrecio * 100)}%, compromiso asentado); ` +
      `${competencia.vendedor.nombre} → posible (sin corroboración); pausar la publicación o cambiar el título hace desaparecer el hallazgo.`
  );

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
  afirmar((await contar('MATCH ()-[r:VENDE]->() RETURN count(r) AS n')) > 0, 'el grafo debería tener relaciones VENDE (quién vende cada producto)');
  // Reventa: todo producto del grafo pertenece a UN solo artículo, y un artículo
  // es solo su clave canónica (nada personal).
  afirmar(
    (await contar('MATCH (p:Producto) WHERE size([(p)-[:ES_ARTICULO]->() | 1]) <> 1 RETURN count(p) AS n')) === 0,
    'todo Producto del grafo debe estar enlazado a exactamente UN Articulo'
  );
  afirmar((await contar('MATCH (a:Articulo) WHERE size(keys(a)) <> 1 OR a.clave IS NULL RETURN count(a) AS n')) === 0, 'un nodo Articulo debe tener únicamente su clave');
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
