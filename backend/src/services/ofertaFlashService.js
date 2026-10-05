const { conectar } = require('../config/redis');
const { conectar: conectarMongo } = require('../config/mongo');
const Producto = require('../models/mongo/Producto');
const productoService = require('./productoService');
const compromisoService = require('./compromisoService');
const checkoutService = require('./checkoutService');
const ofertaDatos = require('./ofertaDatosService');

// Oferta flash (Entrega 2, ver IA/ENTREGA-2-PLAN.md §4.2): cupo limitado a
// precio rebajado, con dos guardas independientes — Redis (acá, admisión
// rápida) y MySQL (checkoutService.checkoutOferta, autoridad final). Ganar
// acá no confirma la compra, solo el derecho a intentarla al precio de
// oferta.
const RECHAZADO = -1;

function clave(productoId) {
  return `oferta:${productoId}:stock`;
}

// Configura (o pausa) la oferta flash de un producto — solo el vendedor dueño
// o un administrador, misma regla que editar el producto en sí
// (productoService.verificarPermiso, reutilizada tal cual). `activo` es
// independiente de las fechas: permite pausar sin tocar la ventana, o dejar
// una oferta preparada de antemano con activo:false. Cualquier campo omitido
// conserva el valor que ya tenía.
async function actualizar(usuario, productoId, { activo, precio_oferta, stock_oferta, vigente_desde, vigente_hasta } = {}) {
  await productoService.verificarPermiso(usuario, productoId);
  await conectarMongo();

  const doc = await Producto.findOne({ producto_id: productoId });
  if (!doc) throw new Error('Producto no encontrado en el catálogo documental');

  if (precio_oferta !== undefined && (typeof precio_oferta !== 'number' || precio_oferta <= 0)) {
    throw new Error('precio_oferta debe ser un número positivo');
  }
  if (stock_oferta !== undefined && (!Number.isInteger(stock_oferta) || stock_oferta <= 0)) {
    throw new Error('stock_oferta debe ser un entero positivo');
  }

  const desde = vigente_desde !== undefined ? new Date(vigente_desde) : doc.oferta_flash?.vigente_desde;
  const hasta = vigente_hasta !== undefined ? new Date(vigente_hasta) : doc.oferta_flash?.vigente_hasta;
  const nuevoActivo = activo ?? doc.oferta_flash?.activo ?? false;
  const precioFinal = precio_oferta ?? doc.oferta_flash?.precio_oferta;
  const stockFinal = stock_oferta ?? doc.oferta_flash?.stock_oferta;

  if (nuevoActivo) {
    if (typeof precioFinal !== 'number') throw new Error('precio_oferta es obligatorio para activar la oferta');
    if (!Number.isInteger(stockFinal)) throw new Error('stock_oferta es obligatorio para activar la oferta');
    if (!desde || !hasta || Number.isNaN(desde.getTime()) || Number.isNaN(hasta.getTime())) {
      throw new Error('vigente_desde y vigente_hasta son obligatorios para activar la oferta');
    }
    if (desde >= hasta) throw new Error('vigente_hasta debe ser posterior a vigente_desde');
  }

  doc.oferta_flash = { activo: nuevoActivo, precio_oferta: precioFinal, stock_oferta: stockFinal, vigente_desde: desde, vigente_hasta: hasta };
  await doc.save();
  await ofertaDatos.actualizar(doc);

  // Reinicia el contador en Redis para que el próximo intento lo re-inicialice
  // desde el stock_oferta (posiblemente nuevo) y con el TTL (atado a
  // vigente_hasta, posiblemente extendido) recién guardados. Da igual si
  // quedó desactivada: el gate corta en el chequeo de `activo` antes de
  // siquiera tocar Redis, así que una clave vieja ahí no molesta a nadie.
  if (nuevoActivo) {
    const redis = conectar();
    await redis.del(clave(productoId));
  }

  return productoService.obtener(productoId);
}

// Remanente EN VIVO para mostrar en el catálogo/detalle — no confundir con
// stock_oferta (el tamaño ORIGINAL del pool, en Mongo). Antes del primer
// intento de compra desde el último reinicio, la clave de Redis todavía no
// existe: el remanente en ese caso es el pool completo, nadie lo tocó
// todavía. Pública, sin auth — mismo criterio que ver el precio normal.
async function consultarStock(productoId) {
  const producto = await ofertaDatos.obtener(productoId);
  // Un vendedor suspendido deja de mostrarse (ver productoService.listar): su oferta
  // "no existe" mientras dure la suspensión, y vuelve sola al levantarse.
  if (await productoService.vendedorOculto(producto.vendedor_id)) throw new Error('Producto no encontrado');
  const oferta = producto.oferta_flash;
  const ahora = new Date();

  if (producto.estado !== 'activo' || !oferta?.activo || !oferta.vigente_desde || !oferta.vigente_hasta) {
    return { activo: false, producto };
  }
  if (ahora < new Date(oferta.vigente_desde)) {
    return { activo: false, producto, motivo: 'todavia_no_empieza', vigente_desde: oferta.vigente_desde };
  }
  if (ahora >= new Date(oferta.vigente_hasta)) {
    return { activo: false, producto, motivo: 'vencida' };
  }

  const redis = conectar();
  const crudo = await redis.get(clave(productoId));
  const restante = crudo === null ? oferta.stock_oferta : Number(crudo);

  return { activo: true, producto, precio_oferta: oferta.precio_oferta, restante: Math.max(restante, 0), vigente_hasta: oferta.vigente_hasta };
}

// Guardia 1 — admisión rápida en Redis, un solo EVAL atómico (ver
// config/redis.js). Devuelve también `producto` para que comprar() no tenga
// que volver a leerlo de Mongo. El chequeo de activo/ventana de fechas pasa
// ACÁ, antes de tocar Redis para nada — más barato que un round-trip, y dos
// de los tres motivos de rechazo (todavía no empieza / ya venció) no son algo
// que Redis pueda decidir por sí solo.
async function intentarComprar(productoId, cantidad, precioEsperado) {
  if (!Number.isInteger(cantidad) || cantidad <= 0) throw new Error('cantidad debe ser un entero positivo');

  const producto = await ofertaDatos.obtener(productoId);
  const oferta = producto.oferta_flash;
  const ahora = new Date();

  // Como un producto inactivo o una oferta pausada: no se puede comprar mientras su
  // vendedor esté suspendido (la oferta y su cupo siguen ahí; vuelven al levantarse).
  if (producto.estado !== 'activo' || !oferta?.activo || (await productoService.vendedorOculto(producto.vendedor_id))) {
    const err = new Error('Este producto no tiene una oferta flash activa');
    err.status = 409;
    throw err;
  }
  const desde = new Date(oferta.vigente_desde);
  const hasta = new Date(oferta.vigente_hasta);
  if (!oferta.vigente_desde || !oferta.vigente_hasta || !Number.isFinite(desde.getTime()) || !Number.isFinite(hasta.getTime())) {
    const err = new Error('La oferta no tiene una vigencia válida');
    err.status = 409;
    throw err;
  }
  if (precioEsperado !== undefined && Number(precioEsperado) !== Number(oferta.precio_oferta)) {
    const err = new Error('Revisá el precio vigente de la oferta antes de confirmar.');
    err.status = 409;
    throw err;
  }
  const ttlSegundos = Math.ceil((hasta.getTime() - ahora.getTime()) / 1000);

  if (ahora < desde) {
    const err = new Error('La oferta todavía no empieza');
    err.status = 409;
    throw err;
  }
  if (ttlSegundos <= 0) {
    const err = new Error('La oferta ya venció');
    err.status = 409;
    throw err;
  }

  const redis = conectar();
  const restante = await redis.decrementarOferta(clave(productoId), oferta.stock_oferta, ttlSegundos, cantidad);

  if (Number(restante) === RECHAZADO) {
    const err = new Error('No quedan unidades en oferta');
    err.status = 409;
    throw err;
  }

  return { restante: Number(restante), producto };
}

// Reversión de la guardia 1 si la guardia 2 (MySQL, checkoutOferta) termina
// rechazando la compra DESPUÉS de que Redis ya la admitió — sin esto, un
// fallo del lado de MySQL (p. ej. el inventario real ya no alcanza) quemaría
// igual una unidad del pool de oferta que nadie efectivamente se llevó.
// Mejor esfuerzo, mismo criterio que el resto de los reenvíos del proyecto
// (ver ADR-002 §5): si esto también falla, queda un desajuste menor a favor
// de la oferta (un cupo de menos disponible), no un dato incorrecto.
async function refundStock(productoId, cantidad) {
  const redis = conectar();
  // Si el pool ya venció, no recrear un contador sin TTL.
  await redis.reintegrarOferta(clave(productoId), cantidad);
}

// Punto de entrada único: guardia 1 (Redis) → guardia 2 (MySQL, autoridad
// final) → si la 2 falla habiendo pasado la 1, revierte el contador de Redis.
// Deliberadamente separado de checkoutService.checkout() (el carrito normal)
// — no pasa por Redis del carrito ni por CartContext, siempre es este único
// producto. Ver ENTREGA-2-PLAN.md §4.2, "no reemplaza el checkout normal".
async function comprar(usuarioId, productoId, { cantidad, direccionId, metodoPagoId, precioEsperado, aceptaNoReventa, montoMaximo } = {}) {
  // Antes de tocar Redis: si el dueño intenta comprar su propia oferta, que se
  // rechace sin gastar (ni tener que devolver) una unidad del pool.
  // checkoutOferta() lo vuelve a verificar como autoridad final.
  await productoService.verificarNoEsPropio(usuarioId, [productoId]);
  // Igual con el compromiso de no reventa: una cuenta que puede vender y no lo
  // aceptó se rechaza antes de gastar cupo (checkoutOferta lo vuelve a exigir
  // y es quien deja la constancia en el pedido).
  await compromisoService.exigirCompromiso(usuarioId, aceptaNoReventa);
  const admision = await intentarComprar(productoId, cantidad, precioEsperado);

  try {
    return await checkoutService.checkoutOferta({
      usuarioId,
      productoId,
      cantidad,
      precioUnitario: admision.producto.oferta_flash.precio_oferta,
      direccionId,
      metodoPagoId,
      aceptaNoReventa,
      montoMaximo,
    });
  } catch (err) {
    try {
      await refundStock(productoId, cantidad);
    } catch (refundErr) {
      console.error('No se pudo revertir el contador de Redis tras un fallo en MySQL:', refundErr.message);
    }
    throw err;
  }
}

module.exports = { actualizar, consultarStock, intentarComprar, comprar };
