// Integración real: crea datos sintéticos propios y los elimina al terminar.
// No inicia workers ni modifica carritos, productos o pedidos preexistentes.
require('dotenv').config({ quiet: true });
process.env.VENTAS_OUTBOX_ENABLED = 'false';
process.env.LIMITE_PEDIDOS_HORA = '0';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const prisma = require('../src/config/prisma');
const mongo = require('../src/config/mongo');
const redisConfig = require('../src/config/redis');
const neo4j = require('../src/config/neo4j');
const Producto = require('../src/models/mongo/Producto');
const Subcategoria = require('../src/models/mongo/Subcategoria');
const cart = require('../src/services/cartService');
const intentos = require('../src/services/checkoutIntentoService');
const ofertaDatos = require('../src/services/ofertaDatosService');
const fraudeSync = require('../src/services/fraudeSyncService');
const app = require('../src/app');

const marca = randomUUID();
const usuarios = [];
const clavesRedis = [];
let productoId;
let servidor;
const evidencia = [];
async function main() {
  // Esta prueba elimina al terminar el producto sintético que creó, y el rol de la aplicación no puede borrar.
  await mongo.conectar('admin');
  const rol = await prisma.rol_usuario.findFirst({ where: { tipo_rol: 'comprador' } });
  const subcategoria = await Subcategoria.findOne().lean();
  assert.ok(rol && subcategoria, 'Se necesita el seed del proyecto (rol comprador y subcategoría).');
  for (const nombre of ['Comprador', 'Vendedor']) {
    const u = await prisma.usuarios.create({ data: {
      rol_id: rol.id, nombres: `[PRUEBA idempotencia ${marca}]`, apellidos: nombre,
      correo: `${marca}-${nombre}@example.invalid`, contrasena: 'cuenta-sintetica-sin-login', fecha_nacimiento: new Date('1990-01-01'),
    } });
    usuarios.push(u.id_usuario);
  }
  const [comprador, vendedor] = usuarios;
  const direccion = await prisma.direcciones.create({ data: { id_usuario: comprador, pais: 'Guatemala', direccion: 'Dirección sintética', codigo_postal: '00000' } });
  const metodo = await prisma.metodo_pago.create({ data: { id_usuario: comprador, titular: 'Prueba', token_pasarela: `prueba-${marca}`, ultimos_4_digitos: '0000', marca: 'PRUEBA' } });
  const producto = await prisma.producto.create({ data: { id_vendedor: vendedor, inventario: { create: { precio: 20, cantidad: 10 } } } });
  productoId = producto.id;
  await Producto.create({ producto_id: productoId, descripcion: `[PRUEBA idempotencia ${marca}]`, estado: 'activo',
    vendedor_id: vendedor, vendedor_nombre: 'Vendedor sintético', subcategoria_id: subcategoria._id, inventario: { precio: 20, cantidad: 10 } });
  const token = jwt.sign({ id_usuario: comprador, rol_id: rol.id, rol: 'comprador' }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const tokenAjeno = jwt.sign({ id_usuario: vendedor, rol_id: rol.id, rol: 'comprador' }, process.env.JWT_SECRET, { expiresIn: '10m' });
  servidor = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => servidor.once('listening', resolve));
  const base = `http://127.0.0.1:${servidor.address().port}/api`;
  async function peticion(ruta, datos, otroToken = token) {
    const res = await fetch(`${base}${ruta}`, { method: datos === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${otroToken}` },
      body: datos === undefined ? undefined : JSON.stringify(datos) });
    return { status: res.status, body: await res.json() };
  }
  const confirmar = (i) => ({ intentoId: i.intentoId, direccionId: direccion.id, metodoPagoId: metodo.id, items: i.items });
  const redis = redisConfig.conectar('admin');
  await cart.agregar(comprador, productoId, 1);
  const [a, b] = await Promise.all([peticion('/checkout/intentos', {}), peticion('/checkout/intentos', {})]);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.intentoId, b.body.intentoId);
  const [c, d] = await Promise.all([peticion('/checkout', confirmar(a.body)), peticion('/checkout', confirmar(b.body))]);
  assert.ok(c.status < 300 && d.status < 300, JSON.stringify([c, d]));
  assert.equal(c.body.compra.id, d.body.compra.id);
  assert.equal(await prisma.compra.count({ where: { id_usuario: comprador } }), 1);
  assert.equal((await prisma.inventario.findUnique({ where: { id_producto: productoId } })).cantidad, 9);
  assert.equal((await Producto.findOne({ producto_id: productoId })).total_vendido, 1);
  evidencia.push({ caso: 'normal: dos ventanas y dos confirmaciones simultáneas', pedidos: 1, stock: 9 });
  // Aunque el catálogo ya no permita comprar, repetir un pedido confirmado
  // devuelve el resultado previo sin depender de Mongo ni del carrito vacío.
  await Producto.updateOne({ producto_id: productoId }, { $set: { estado: 'inactivo' } });
  const repetida = await peticion('/checkout', confirmar(a.body));
  assert.equal(repetida.status, 200);
  assert.equal(repetida.body.compra.id, c.body.compra.id);
  await Producto.updateOne({ producto_id: productoId }, { $set: { estado: 'activo' } });
  await cart.agregar(comprador, productoId, 1);
  const viejo = await peticion('/checkout/intentos', {});
  await cart.actualizarCantidad(comprador, productoId, 2);
  const cambiado = await peticion('/checkout', confirmar(viejo.body));
  assert.equal(cambiado.body.codigo, 'CHECKOUT_CARRITO_CAMBIO');
  evidencia.push({ caso: 'carrito modificado invalida la pantalla anterior', status: cambiado.status });

  // Simular la pérdida de la respuesta del COMMIT, no un rollback.
  const perdido = await peticion('/checkout/intentos', {});
  const transaccionOriginal = prisma.$transaction.bind(prisma);
  let inyectado = false;
  prisma.$transaction = async (...args) => {
    const resultado = await transaccionOriginal(...args);
    if (!inyectado && resultado?.compra?.id) { inyectado = true; throw new Error('Respuesta de COMMIT perdida [prueba]'); }
    return resultado;
  };
  let sinRespuesta;
  try { sinRespuesta = await peticion('/checkout', confirmar(perdido.body)); }
  finally { prisma.$transaction = transaccionOriginal; }
  assert.equal(sinRespuesta.status, 503);
  const recuperado = await peticion('/checkout', confirmar(perdido.body));
  assert.equal(recuperado.status, 200);
  assert.equal(await prisma.compra.count({ where: { id_usuario: comprador } }), 2);
  evidencia.push({ caso: 'COMMIT real confirmado y respuesta perdida; reenvío recuperado', primeraRespuesta: 503, reintento: 200, pedidosAcumulados: 2 });

  const revision = randomUUID();
  const vence = Math.floor(Date.now() / 1000) + 300;
  const claveStock = `oferta:${productoId}:stock:${revision}`;
  clavesRedis.push(claveStock, `oferta:${productoId}:datos`, `oferta:${productoId}:revision`);
  await Producto.updateOne({ producto_id: productoId }, { $set: { oferta_flash: {
    activo: true, precio_oferta: 15, stock_oferta: 3, vigente_desde: new Date(Date.now() - 10000), vigente_hasta: new Date(vence * 1000), revision,
  } } });
  await ofertaDatos.invalidar(productoId);
  const rutaPreparar = `/ofertas/${productoId}/intentos`;
  const rutaComprar = `/ofertas/${productoId}/comprar`;
  const [f, g] = await Promise.all([peticion(rutaPreparar, {}), peticion(rutaPreparar, {})]);
  assert.equal(f.status, 200, JSON.stringify(f.body));
  assert.equal(f.body.intentoId, g.body.intentoId);
  const datosFlash = (i) => ({ intentoId: i.intentoId, direccionId: direccion.id, metodoPagoId: metodo.id, cantidad: 1, precioEsperado: 15 });
  const [h, j] = await Promise.all([peticion(rutaComprar, datosFlash(f.body)), peticion(rutaComprar, datosFlash(g.body))]);
  assert.ok(h.status < 300 && j.status < 300, JSON.stringify([h, j]));
  assert.equal(h.body.compra.id, j.body.compra.id);
  assert.equal(Number(await redis.get(claveStock)), 2);
  assert.equal(await prisma.compra.count({ where: { id_usuario: comprador } }), 3);
  evidencia.push({ caso: 'flash: dos ventanas y confirmaciones simultáneas', cupoRestante: 2, pedidosNuevos: 1 });

  const [k, l] = await Promise.all([peticion(rutaPreparar, { anteriorIntentoId: f.body.intentoId }), peticion(rutaPreparar, { anteriorIntentoId: f.body.intentoId })]);
  assert.equal(k.body.intentoId, l.body.intentoId);
  const stockAntes = (await prisma.inventario.findUnique({ where: { id_producto: productoId } })).cantidad;
  await prisma.inventario.update({ where: { id_producto: productoId }, data: { cantidad: 0 } });
  const fallo = await peticion(rutaComprar, datosFlash(k.body));
  assert.ok(fallo.status >= 400);
  assert.equal((await intentos.consultar(comprador, k.body.intentoId)).estado, 'fallido');
  await intentos.resolverFallo(comprador, k.body.intentoId, new Error('Repetir compensación [prueba]'));
  assert.equal(Number(await redis.get(claveStock)), 2);
  evidencia.push({ caso: 'flash: fallo de MySQL devuelve cupo; repetir compensación no lo duplica', cupoRestante: 2 });
  await prisma.inventario.update({ where: { id_producto: productoId }, data: { cantidad: stockAntes } });

  const m = await peticion(rutaPreparar, { anteriorIntentoId: k.body.intentoId });
  const solicitud = { ...datosFlash(m.body), productoId };
  await intentos.registrarReserva(comprador, m.body.intentoId, solicitud, { version: revision, claveStock, cantidad: 1, stockInicial: 3, vence, precioUnitario: 15 });
  const claveReserva = `checkout:reserva:${m.body.intentoId}`;
  await redis.reservarOfertaIdempotente(claveStock, claveReserva, 3, vence, 1);
  assert.equal(Number(await redis.get(claveStock)), 1);
  // Equivale a reiniciar Node tras reservar y antes de ejecutar la compra.
  const reanudada = await peticion(rutaComprar, datosFlash(m.body));
  assert.equal(reanudada.status, 201, JSON.stringify(reanudada.body));
  assert.equal(Number(await redis.get(claveStock)), 1);
  evidencia.push({ caso: 'flash: reanudar reserva tras interrupción no descuenta dos veces', cupoRestante: 1 });
  const ajena = await peticion(`/checkout/intentos/${m.body.intentoId}`, undefined, tokenAjeno);
  assert.equal(ajena.status, 404);
  const distintos = await peticion(rutaComprar, { ...datosFlash(m.body), cantidad: 2 });
  assert.equal(distintos.body.codigo, 'CHECKOUT_DATOS_DISTINTOS');
  assert.equal(await prisma.compra.count({ where: { id_usuario: comprador } }), 4);

  // Ejecutar el Lua real muchas veces con el mismo identificador.
  const pool = `prueba:checkout:${marca}:stock`;
  const reserva = `prueba:checkout:${marca}:reserva`;
  const cancelada = `prueba:checkout:${marca}:cancelada`;
  clavesRedis.push(pool, reserva, cancelada);
  const resultados = await Promise.all(Array.from({ length: 10 }, () => redis.reservarOfertaIdempotente(pool, reserva, 2, vence, 1)));
  assert.ok(resultados.every((r) => Number(r) === 1));
  assert.equal(Number(await redis.get(pool)), 1);
  await Promise.all(Array.from({ length: 10 }, () => redis.devolverReservaOferta(pool, reserva, vence)));
  assert.equal(Number(await redis.get(pool)), 2);
  await redis.devolverReservaOferta(pool, cancelada, vence);
  assert.equal(Number(await redis.reservarOfertaIdempotente(pool, cancelada, 2, vence, 1)), -2);
  await redis.del(pool);
  await redis.devolverReservaOferta(pool, reserva, vence);
  assert.equal(await redis.exists(pool), 0);
  evidencia.push({ caso: 'Lua real: diez reservas/devoluciones repetidas y cancelación anticipada', correcto: true });
  console.log(JSON.stringify({ resultado: 'OK', evidencia }, null, 2));
}

async function limpiar() {
  if (servidor) await new Promise((resolve) => servidor.close(resolve));
  if (usuarios.length) {
    const compras = await prisma.compra.findMany({ where: { id_usuario: { in: usuarios } }, select: { id: true } });
    const ids = compras.map((c) => c.id);
    const registros = await prisma.checkout_intento.findMany({ where: { id_usuario: { in: usuarios } }, select: { id: true } });
    clavesRedis.push(...registros.map((i) => `checkout:reserva:${i.id}`));
    for (const id of usuarios) clavesRedis.push(`carrito:${id}`, `carrito:${id}:revision`);
    await prisma.$transaction(async (tx) => {
      await tx.checkout_sesion.deleteMany({ where: { id_usuario: { in: usuarios } } });
      await tx.checkout_intento.deleteMany({ where: { id_usuario: { in: usuarios } } });
      await tx.pago.deleteMany({ where: { id_compra: { in: ids } } });
      await tx.compra_detalle.deleteMany({ where: { id_compra: { in: ids } } });
      await tx.compra.deleteMany({ where: { id: { in: ids } } });
      await tx.carrito.deleteMany({ where: { id_usuario: { in: usuarios } } });
      await tx.direcciones.deleteMany({ where: { id_usuario: { in: usuarios } } });
      await tx.metodo_pago.deleteMany({ where: { id_usuario: { in: usuarios } } });
      if (productoId) {
        await tx.inventario.deleteMany({ where: { id_producto: productoId } });
        await tx.producto.delete({ where: { id: productoId } });
      }
      await tx.usuarios.deleteMany({ where: { id_usuario: { in: usuarios } } });
    });
    try {
      await neo4j.escribir('MATCH (u:Usuario) WHERE u.id_usuario IN $ids DETACH DELETE u', { ids: usuarios });
      if (productoId) await neo4j.escribir('MATCH (p:Producto {producto_id: $id}) DETACH DELETE p', { id: productoId });
      await neo4j.escribir('MATCH (n:Nombre) WHERE n.clave IN $claves AND NOT (n)--() DELETE n', {
        claves: ['Comprador', 'Vendedor'].map((nombre) => fraudeSync.normalizarNombre(`[PRUEBA idempotencia ${marca}] ${nombre}`)).concat(fraudeSync.normalizarNombre('Vendedor sintético')),
      });
      await neo4j.escribir('MATCH (c:Correo) WHERE c.hash IN $hashes AND NOT (c)--() DELETE c', {
        hashes: ['Comprador', 'Vendedor'].map((nombre) => fraudeSync.hashCorreo(`${marca}-${nombre}@example.invalid`)),
      });
      await neo4j.escribir('MATCH (a:Articulo {clave: $clave}) WHERE NOT (a)--() DELETE a', { clave: fraudeSync.claveArticulo(`[PRUEBA idempotencia ${marca}]`) });
    } catch (err) { console.error('Limpieza del grafo sintético pendiente:', err.message); }
  }
  if (productoId) await Producto.deleteOne({ producto_id: productoId });
  if (clavesRedis.length) await redisConfig.conectar('admin').del(...clavesRedis);
}
main().catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(async () => {
    try { await limpiar(); } catch (err) { console.error('Limpieza de datos sintéticos:', err); process.exitCode = 1; }
    await Promise.allSettled([prisma.$disconnect(), mongoose.disconnect(), neo4j.cerrar()]);
    redisConfig.cerrar();
  });
