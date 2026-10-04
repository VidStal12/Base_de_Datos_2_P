require('dotenv/config');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const prisma = require('../src/config/prisma');
const { conectar: conectarMongo } = require('../src/config/mongo');
const { conectar: conectarRedis, cerrar } = require('../src/config/redis');
const Producto = require('../src/models/mongo/Producto');
require('../src/models/mongo/Categoria');
const neo4j = require('../src/config/neo4j');
const cart = require('../src/services/cartService');
const cache = require('../src/services/ofertaDatosService');
const oferta = require('../src/services/ofertaFlashService');
const { checkout } = require('../src/services/checkoutService');
const app = require('../src/app');
let servidor;

// Cuenta/producto exclusivos y sintéticos. Se conservan las compras de prueba
// para mantener pedidos/outbox/fraude consistentes. No se modifica a Ana.
async function main() {
  await conectarMongo();
  const base = await Producto.findOne({ estado: 'activo' }).lean();
  const rol = await prisma.rol_usuario.findFirst({ where: { tipo_rol: 'comprador' } });
  if (!base || !rol) throw new Error('Corré npm run seed primero.');
  const usuario = await prisma.usuarios.upsert({
    where: { correo: 'carrito.test@example.com' }, update: {},
    create: { rol_id: rol.id, nombres: 'Prueba sintética', apellidos: 'Carrito Redis MySQL', correo: 'carrito.test@example.com', contrasena: await bcrypt.hash('Password123!', 10), fecha_nacimiento: new Date('2000-01-01') },
    include: { direcciones: true, metodos_pago: true },
  });
  const usuarioId = usuario.id_usuario;
  servidor = await new Promise((resolve) => {
    const http = app.listen(0, '127.0.0.1', () => resolve(http));
  });
  const url = `http://127.0.0.1:${servidor.address().port}/api`;
  const token = jwt.sign({ id_usuario: usuarioId, rol: 'comprador' }, process.env.JWT_SECRET, { expiresIn: '5m' });
  async function peticion(ruta, { metodo = 'GET', body, estado = 200 } = {}) {
    const res = await fetch(`${url}${ruta}`, {
      method: metodo, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const datos = await res.json();
    assert.equal(res.status, estado, datos.error || ruta);
    return datos;
  }
  const direccion = usuario.direcciones[0] || await prisma.direcciones.create({ data: { id_usuario: usuarioId, pais: 'Guatemala', direccion: 'Dirección sintética carrito', codigo_postal: '00000' } });
  const metodo = usuario.metodos_pago[0] || await prisma.metodo_pago.create({ data: { id_usuario: usuarioId, titular: 'Prueba sintética', token_pasarela: 'carrito-test-sintetico', ultimos_4_digitos: '0000', marca: 'PRUEBA' } });
  const descripcion = '[PRUEBA SINTÉTICA] Persistencia carrito y caché flash';
  let doc = await Producto.findOne({ descripcion });
  if (!doc) {
    const sql = await prisma.producto.create({ data: { id_vendedor: base.vendedor_id, inventario: { create: { precio: 10, cantidad: 20 } } } });
    doc = await Producto.create({ producto_id: sql.id, descripcion, estado: 'activo', subcategoria_id: base.subcategoria_id, vendedor_id: base.vendedor_id, vendedor_nombre: base.vendedor_nombre, inventario: { precio: 10, cantidad: 20 }, imagenes: [], atributos: [] });
  }
  const productoId = doc.producto_id;
  await prisma.inventario.update({ where: { id_producto: productoId }, data: { precio: 10, cantidad: 20 } });
  await Producto.updateOne({ producto_id: productoId }, { $set: { inventario: { precio: 10, cantidad: 20 } } });
  await cache.invalidar(productoId);
  await cart.vaciar(usuarioId);
  const redis = conectarRedis();
  const clave = `carrito:${usuarioId}`;
  const compra = (precioEsperado) => checkout({ usuarioId, direccionId: direccion.id, metodoPagoId: metodo.id, items: [{ productoId, cantidad: 1, precioEsperado }] });

  await cart.agregar(usuarioId, productoId, 2);
  const snapshot = JSON.parse(await redis.hget(clave, String(productoId)));
  assert.equal(snapshot.producto.id, productoId);
  assert.equal(snapshot.producto.precio, 10);
  assert.equal('inventario' in snapshot.producto, false);
  assert.equal(snapshot.cantidad, 2);
  assert.equal(await prisma.carrito.count({ where: { id_usuario: usuarioId } }), 1);
  assert.ok(await redis.ttl(clave) > 0);
  console.log('OK: MySQL persistente, copia propia sin inventario en Redis y TTL de 450s.');
  const lecturaSQL = prisma.carrito.findMany;
  const lecturaInventario = prisma.inventario.findMany;
  const lecturaMongo = Producto.find;
  prisma.carrito.findMany = () => { throw new Error('Una lectura caliente no debe consultar MySQL'); };
  prisma.inventario.findMany = () => { throw new Error('Una lectura caliente no debe consultar inventario'); };
  Producto.find = () => { throw new Error('Una lectura caliente no debe consultar Mongo'); };
  try { assert.equal((await peticion('/carrito')).items[0].cantidad, 2); }
  finally { prisma.carrito.findMany = lecturaSQL; prisma.inventario.findMany = lecturaInventario; Producto.find = lecturaMongo; }
  console.log('OK: lectura caliente exclusivamente Redis, sin MySQL ni Mongo.');

  await redis.expire(clave, 1);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(await redis.exists(clave), 0);
  assert.equal((await cart.obtener(usuarioId)).items[0].cantidad, 2);
  assert.ok(await redis.ttl(clave) > 440);
  console.log('OK: expiración real reconstruye el carrito sin perderlo.');

  await prisma.inventario.update({ where: { id_producto: productoId }, data: { precio: 12.5, cantidad: 1 } });
  assert.equal((await cart.obtener(usuarioId)).total, 20, 'un cambio SQL directo no se consulta al abrir el carrito');
  await assert.rejects(compra(10), (err) => err.status === 409);
  const actualizado = await peticion('/carrito/revisar', { metodo: 'POST' });
  assert.equal(actualizado.total, 25);
  assert.equal('precioCambio' in actualizado.items[0], false);
  assert.equal('inventario' in actualizado.items[0].producto, false);
  assert.equal(actualizado.items[0].disponible, false);
  assert.equal(await prisma.carrito.count({ where: { id_usuario: usuarioId } }), 1);
  console.log('OK: checkout rechaza precio viejo y la revisión muestra solo datos actuales.');

  await prisma.inventario.update({ where: { id_producto: productoId }, data: { cantidad: 20 } });
  await cart.vaciar(usuarioId);
  await Promise.all([cart.agregar(usuarioId, productoId, 2), cart.agregar(usuarioId, productoId, 3)]);
  assert.equal((await cart.obtener(usuarioId)).items[0].cantidad, 5);
  await cart.agregar(usuarioId, productoId, 99999);
  assert.equal((await cart.obtener(usuarioId)).items[0].cantidad, 20);
  await cart.actualizarCantidad(usuarioId, productoId, 0);
  assert.equal(await redis.hget(clave, String(productoId)), null);
  assert.equal((await cart.obtener(usuarioId)).items.length, 0);
  console.log('OK: concurrencia, clamp SQL y cantidad cero sin fila fantasma.');

  await cart.agregar(usuarioId, productoId, 1);
  await compra(12.5);
  assert.equal(await prisma.carrito.count({ where: { id_usuario: usuarioId } }), 0);
  assert.equal(await redis.exists(clave), 0);
  assert.equal((await cart.obtener(usuarioId)).items.length, 0);
  console.log('OK: checkout confirmado vacía SQL y Redis.');

  const vendedor = { id_usuario: base.vendedor_id, rol: 'vendedor' };
  await oferta.actualizar(vendedor, productoId, { activo: true, precio_oferta: 8, stock_oferta: 5, vigente_desde: new Date(Date.now() - 1000), vigente_hasta: new Date(Date.now() + 60000) });
  const infoFlash = await peticion(`/ofertas/${productoId}/stock`);
  assert.equal(infoFlash.producto.descripcion, descripcion);
  const flash = JSON.parse(await redis.get(`oferta:${productoId}:datos`));
  assert.equal(flash.descripcion, descripcion);
  assert.equal(flash.oferta_flash.precio_oferta, 8);
  assert.equal('inventario' in flash, false);
  await peticion(`/ofertas/${productoId}/comprar`, { metodo: 'POST', estado: 409, body: { cantidad: 1, direccionId: direccion.id, metodoPagoId: metodo.id, precioEsperado: 7 } });
  assert.equal(await redis.get(`oferta:${productoId}:stock`), null, 'rechazar el precio no consume ni inicializa cupo');
  const respuestas = await Promise.allSettled(Array.from({ length: 15 }, () => peticion(`/ofertas/${productoId}/comprar`, {
    metodo: 'POST', estado: 201, body: { cantidad: 1, direccionId: direccion.id, metodoPagoId: metodo.id, precioEsperado: 8 },
  })));
  assert.equal(respuestas.filter((r) => r.status === 'fulfilled').length, 5);
  assert.equal(await redis.get(`oferta:${productoId}:stock`), '0');
  assert.equal((await prisma.inventario.findUnique({ where: { id_producto: productoId } })).cantidad, 14);
  await oferta.actualizar(vendedor, productoId, { activo: false });
  assert.equal((await peticion(`/ofertas/${productoId}/stock`)).activo, false);
  assert.equal(await redis.get(`oferta:${productoId}:stock`), '0', 'pausar no repone el contador');
  console.log('OK: flash caliente, 5 compras / 15 intentos, Redis=0 y SQL=14.');
  console.log('Todas las verificaciones pasaron. Los pedidos sintéticos se conservan.');
}

main().catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(async () => {
    if (servidor) {
      servidor.closeAllConnections();
      await new Promise((resolve) => servidor.close(resolve));
    }
    await prisma.$disconnect(); await mongoose.disconnect(); await neo4j.cerrar(); cerrar();
  });
