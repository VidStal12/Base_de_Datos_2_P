const { randomUUID, createHash } = require('node:crypto');
const prisma = require('../config/prisma');
const { conectar } = require('../config/redis');
const { registrarFallo } = require('../utils/resiliencia');

const REUTILIZADO = Symbol('checkout_reutilizado');
const json = (valor) => JSON.parse(JSON.stringify(valor));
function error(mensaje, codigo = 'CHECKOUT_INVALIDO', status = 409) {
  return Object.assign(new Error(mensaje), { codigo, status });
}
const ordenarItems = (items) => items.map(({ productoId, cantidad, precioEsperado }) => ({
  productoId, cantidad, ...(precioEsperado !== undefined && { precioEsperado: Number(precioEsperado) }),
})).sort((a, b) => a.productoId - b.productoId);
function huella(datos) {
  // No se persiste la contraseña. La aceptación sí forma parte de esta compra.
  return createHash('sha256').update(JSON.stringify({
    direccionId: datos.direccionId, metodoPagoId: datos.metodoPagoId,
    aceptaNoReventa: datos.aceptaNoReventa === true,
    items: datos.items ? ordenarItems(datos.items) : undefined,
    productoId: datos.productoId, cantidad: datos.cantidad,
    precioEsperado: datos.precioEsperado === undefined ? undefined : Number(datos.precioEsperado),
  })).digest('hex');
}
async function bloquear(tx, usuarioId) {
  await tx.$queryRaw`SELECT id_usuario FROM usuarios WHERE id_usuario = ${usuarioId} FOR UPDATE`;
}
async function buscar(db, usuarioId, intentoId) {
  if (typeof intentoId !== 'string' || !/^[0-9a-f-]{36}$/.test(intentoId)) {
    throw error('Prepará el checkout antes de confirmar.', 'CHECKOUT_REQUERIDO', 400);
  }
  const intento = await db.checkout_intento.findUnique({ where: { id: intentoId } });
  if (!intento || intento.id_usuario !== usuarioId) throw error('No se encontró el intento de compra.', 'CHECKOUT_NO_ENCONTRADO', 404);
  return intento;
}
function comprobarDatos(intento, datos) {
  if (intento.datos_hash && intento.datos_hash !== huella(datos)) {
    throw error('Este intento ya tiene otros datos. Revisá su resultado antes de iniciar otra compra.', 'CHECKOUT_DATOS_DISTINTOS');
  }
}
function resultado(intento) {
  if (intento.estado === 'fallido') {
    throw error(intento.error?.mensaje || 'Este intento ya terminó. Prepará una nueva compra.', intento.error?.codigo || 'CHECKOUT_FALLIDO', intento.error?.status || 409);
  }
  if (intento.estado !== 'completado') return null;
  const respuesta = json(intento.respuesta);
  Object.defineProperty(respuesta, REUTILIZADO, { value: true });
  return respuesta;
}
async function recuperar(usuarioId, intentoId, datos) {
  const intento = await buscar(prisma, usuarioId, intentoId);
  comprobarDatos(intento, datos);
  return resultado(intento);
}
function vista(i) {
  return { intentoId: i.id, estado: i.estado, compraId: i.compra_id, items: i.items, versionCarrito: i.version_carrito,
    datos: i.reserva?.solicitud || null, advertencias: i.respuesta?.advertencias || [] };
}
// El pedido ya confirmó. Guardar el aviso permite recuperarlo al reenviar o recargar;
// un fallo al guardar este dato informativo nunca convierte la compra en un rechazo.
async function guardarAdvertencias(usuarioId, intentoId, respuesta) {
  if (!intentoId) return;
  try {
    await prisma.checkout_intento.updateMany({
      where: { id: intentoId, id_usuario: usuarioId, estado: 'completado', compra_id: respuesta.compra.id },
      data: { respuesta: json(respuesta) },
    });
  } catch (err) { registrarFallo('No se pudo guardar el aviso del checkout', err); }
}
async function preparar(usuarioId, { productoId, ofertaVersion, anteriorIntentoId } = {}) {
  return prisma.$transaction(async (tx) => {
    await bloquear(tx, usuarioId);
    let version = null;
    let items = null;
    let ambito;
    if (productoId) {
      ambito = `flash:${productoId}:${ofertaVersion}`;
    } else {
      const usuario = await tx.usuarios.findUnique({ where: { id_usuario: usuarioId } });
      version = usuario.carrito_version;
      ambito = `normal:${version}`;
      const filas = await tx.carrito.findMany({ where: { id_usuario: usuarioId }, orderBy: { id_producto: 'asc' } });
      if (!filas.length) throw error('El carrito está vacío.', 'CARRITO_VACIO');
      const inventarios = await tx.inventario.findMany({ where: { id_producto: { in: filas.map((f) => f.id_producto) } } });
      const precios = new Map(inventarios.map((i) => [i.id_producto, Number(i.precio)]));
      items = filas.map((f) => ({ productoId: f.id_producto, cantidad: f.cantidad, precioEsperado: precios.get(f.id_producto) }));
    }
    const clave = { id_usuario_ambito: { id_usuario: usuarioId, ambito } };
    const sesion = await tx.checkout_sesion.findUnique({ where: clave });
    if (sesion) {
      const actual = await buscar(tx, usuarioId, sesion.intento_id);
      // Una pantalla vieja no puede reemplazar el intento que otra ya renovó.
      if (!anteriorIntentoId || anteriorIntentoId !== actual.id) return vista(actual);
      if (actual.estado === 'pendiente') throw error('La compra sigue pendiente. Reintentá o consultá su resultado.', 'CHECKOUT_PENDIENTE');
    }
    const intento = await tx.checkout_intento.create({ data: {
      id: randomUUID(), id_usuario: usuarioId, ambito,
      version_carrito: version, ...(items && { items }),
    } });
    await tx.checkout_sesion.upsert({ where: clave,
      create: { id_usuario: usuarioId, ambito, intento_id: intento.id }, update: { intento_id: intento.id },
    });
    return vista(intento);
  });
}
async function consultar(usuarioId, intentoId) {
  return vista(await buscar(prisma, usuarioId, intentoId));
}
// El plan de reserva se guarda ANTES de tocar Redis. Si el proceso muere tras
// descontar, otro proceso sabe exactamente qué reserva recuperar/compensar.
async function registrarReserva(usuarioId, intentoId, datos, reserva) {
  return prisma.$transaction(async (tx) => {
    await bloquear(tx, usuarioId);
    const intento = await buscar(tx, usuarioId, intentoId);
    comprobarDatos(intento, datos);
    if (intento.estado !== 'pendiente') return intento;
    if (intento.ambito !== `flash:${datos.productoId}:${reserva.version}`) {
      throw error('La oferta cambió. Prepará nuevamente la compra.', 'CHECKOUT_OFERTA_CAMBIO');
    }
    if (intento.reserva) return intento;
    const solicitud = { productoId: datos.productoId, cantidad: datos.cantidad, direccionId: datos.direccionId,
      metodoPagoId: datos.metodoPagoId, precioEsperado: datos.precioEsperado, aceptaNoReventa: datos.aceptaNoReventa === true };
    return tx.checkout_intento.update({ where: { id: intentoId }, data: { datos_hash: huella(datos), reserva: { ...reserva, solicitud: json(solicitud) } } });
  });
}
async function transaccion({ usuarioId, intentoId, datos, reservar }, operacion) {
  return prisma.$transaction(async (tx) => {
    await bloquear(tx, usuarioId);
    const intento = await buscar(tx, usuarioId, intentoId);
    comprobarDatos(intento, datos);
    const anterior = resultado(intento);
    if (anterior) return anterior;
    if (intento.version_carrito !== null) {
      const usuario = await tx.usuarios.findUnique({ where: { id_usuario: usuarioId } });
      if (usuario.carrito_version !== intento.version_carrito) throw error('El carrito cambió. Revisalo antes de confirmar.', 'CHECKOUT_CARRITO_CAMBIO');
      if (JSON.stringify(ordenarItems(datos.items || [])) !== JSON.stringify(ordenarItems(intento.items))) {
        throw error('Los productos o precios cambiaron. Revisá el carrito.', 'CHECKOUT_CARRITO_CAMBIO');
      }
    } else if (!intento.reserva) {
      throw error('Falta la reserva de la oferta.', 'CHECKOUT_INVALIDO');
    }
    if (reservar) await reservar(intento);
    const respuesta = await operacion(tx);
    await tx.checkout_intento.update({ where: { id: intentoId }, data: {
      estado: 'completado', compra_id: respuesta.compra.id, respuesta: json(respuesta), datos_hash: huella(datos),
    } });
    return respuesta;
  }, { maxWait: 10000, timeout: 15000 });
}
async function compensar(intento) {
  if (intento.compensado) return;
  if (intento.reserva) await conectar().devolverReservaOferta(intento.reserva.claveStock, `checkout:reserva:${intento.id}`, intento.reserva.vence);
  await prisma.checkout_intento.update({ where: { id: intento.id }, data: { compensado: true } });
}
// Adquirir el mismo lock elimina la ambigüedad de un COMMIT cuya respuesta se
// perdió: nunca se compensa mientras otra transacción puede confirmar el pedido.
async function resolverFallo(usuarioId, intentoId, causa, antesDe) {
  const intento = await prisma.$transaction(async (tx) => {
    await bloquear(tx, usuarioId);
    const actual = await buscar(tx, usuarioId, intentoId);
    if (antesDe && actual.estado === 'pendiente' && actual.actualizado_en >= antesDe) return actual;
    if (actual.estado !== 'pendiente') return actual;
    return tx.checkout_intento.update({ where: { id: intentoId }, data: {
      estado: 'fallido', error: { mensaje: causa.message, codigo: 'CHECKOUT_FALLIDO', status: 409 },
    } });
  }, { maxWait: 10000, timeout: 15000 });
  if (intento.estado === 'completado') return resultado(intento);
  if (intento.estado === 'pendiente') return null;
  try { await compensar(intento); }
  catch (err) { console.error('Compensación flash pendiente:', err.message); }
  return null;
}
let temporizador;
let ejecucion;
function reconciliar() {
  if (ejecucion) return ejecucion;
  ejecucion = (async () => {
    const antesDe = new Date(Date.now() - 15 * 60000);
    const pendientes = await prisma.checkout_intento.findMany({ where: { OR: [
      { estado: 'fallido', compensado: false },
      { estado: 'pendiente', actualizado_en: { lt: antesDe } },
    ] }, take: 50, orderBy: { actualizado_en: 'asc' } });
    for (const i of pendientes) {
      try { await resolverFallo(i.id_usuario, i.id, error('El intento venció sin confirmarse. Prepará otra compra.'), antesDe); }
      catch (err) { console.error('Intento pendiente de recuperación:', i.id, err.message); }
    }
  })().finally(() => { ejecucion = undefined; });
  return ejecucion;
}
function iniciar() {
  if (temporizador) return;
  const ejecutar = () => reconciliar().catch((err) => registrarFallo('Recuperación de checkout', err));
  temporizador = setInterval(ejecutar, 30000);
  temporizador.unref();
  ejecutar();
}
async function detener() { clearInterval(temporizador); temporizador = undefined; await ejecucion; }
module.exports = { preparar, consultar, recuperar, registrarReserva, guardarAdvertencias, transaccion, resolverFallo, reconciliar, iniciar, detener,
  reutilizado: (respuesta) => !!respuesta[REUTILIZADO], error };
