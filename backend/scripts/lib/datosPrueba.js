const bcrypt = require('bcryptjs');
const prisma = require('../../src/config/prisma');
const Subcategoria = require('../../src/models/mongo/Subcategoria');
const Producto = require('../../src/models/mongo/Producto');
const ProductoEvento = require('../../src/models/mongo/ProductoEvento');
const { conectar: conectarMongo } = require('../../src/config/mongo');

// Datos de prueba compartidos por los scripts de verificación (verificarFraudeNeo4j,
// verificarCompromisoReventa…): cuentas con dirección y método de pago, y productos
// sintéticos de un vendedor de prueba. Todo es idempotente — buscar antes de crear —
// para que re-correr un script no acumule filas. Las cuentas usan la contraseña de
// siempre de las cuentas de prueba (`Password123!`), así que también sirven para
// entrar a mano en el navegador.

function afirmar(condicion, mensaje) {
  if (!condicion) throw new Error(`FALLO: ${mensaje}`);
}

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

// Producto sintético de un vendedor de prueba — para la autocompra hace falta
// un vendedor que sea una de las cuentas del patrón, y los vendedores reales
// del catálogo no deben aparecer como autocompradores. Se crea directo (mismo
// criterio que verificarRecomendaciones.js con su producto competidor) y
// INACTIVO: no aparece en la tienda ni en el buscador, pero checkout() solo
// valida el inventario real, así que se puede comprar.
async function asegurarProducto(vendedor, nombre, precio, { subcategoria = 'Camisetas', atributos = [], cantidad = 20 } = {}) {
  await conectarMongo();
  // Nombre Y vendedor: la señal de reventa necesita DOS productos con la
  // mismo nombre de vendedores distintos (el original y la reventa), así que
  // el nombre solo ya no identifica un producto de prueba.
  const existente = await Producto.findOne({ nombre, vendedor_id: vendedor.id_usuario }).lean();
  if (existente) return { id: existente.producto_id, nombre, descripcion: existente.descripcion, precio };
  const descripcion = `Artículo de prueba de ${subcategoria}.`;

  const sub = await Subcategoria.findOne({ subcategoria });
  afirmar(sub, `no existe la subcategoría "${subcategoria}" en el catálogo`);
  const relacional = await prisma.producto.create({
    data: { id_vendedor: vendedor.id_usuario, inventario: { create: { precio, cantidad } } },
  });
  const doc = await Producto.create({
    producto_id: relacional.id,
    nombre,
    descripcion,
    estado: 'inactivo',
    subcategoria_id: sub._id,
    vendedor_id: vendedor.id_usuario,
    vendedor_nombre: `${vendedor.nombres} ${vendedor.apellidos}`,
    inventario: { precio, cantidad },
    atributos,
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
    snapshot: { nombre, descripcion, estado: 'inactivo', atributos, imagenes: [], inventario: { precio, cantidad } },
  });
  return { id: relacional.id, nombre, descripcion, precio };
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

module.exports = { afirmar, crearCuenta, crearDireccion, crearMetodoPago, prepararCuenta, asegurarProducto, conProductoActivo };
