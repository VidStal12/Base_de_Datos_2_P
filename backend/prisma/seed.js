require('dotenv').config();
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const prisma = require('../src/config/prisma');
const { conectar } = require('../src/config/mongo');
const Categoria = require('../src/models/mongo/Categoria');
const Subcategoria = require('../src/models/mongo/Subcategoria');
const Producto = require('../src/models/mongo/Producto');
const ProductoEvento = require('../src/models/mongo/ProductoEvento');

// Seed combinado MySQL + Mongo. Hasta el 2026-08-29 esto solo poblaba MySQL
// (incluido el catálogo relacional) y hacía falta correr aparte
// scripts/etlCatalogoAMongo.js para migrar ese catálogo a Mongo. Con el
// catálogo relacional borrado (ver IA/ADR-002 §3.4 — categoria, subcategoria,
// atributo_categoria, atributo_producto, categoria_producto ya no existen en
// MySQL), no queda nada de qué hacer ETL: este script asume directamente el
// trabajo de poblar Mongo, en un solo paso.
//
// Reproducible como el ETL que reemplaza: limpia las colecciones Mongo
// destino antes de escribir, así se puede correr de nuevo tantas veces como
// haga falta durante el desarrollo (MySQL ya se resetea solo al recrear el
// volumen/reaplicar migraciones).
async function main() {
  await conectar();
  console.log('Limpiando colecciones de Mongo...');
  await Promise.all([
    Categoria.deleteMany({}),
    Subcategoria.deleteMany({}),
    Producto.deleteMany({}),
    ProductoEvento.deleteMany({}),
  ]);

  const [comprador, vendedor] = await Promise.all([
    prisma.rol_usuario.create({ data: { tipo_rol: 'comprador' } }),
    prisma.rol_usuario.create({ data: { tipo_rol: 'vendedor' } }),
  ]);
  await prisma.rol_usuario.create({ data: { tipo_rol: 'administrador' } });

  const passwordHash = await bcrypt.hash('Password123!', 10);

  const usuario1 = await prisma.usuarios.create({
    data: {
      rol_id: comprador.id,
      nombres: 'Ana',
      apellidos: 'Gómez',
      correo: 'ana.gomez@example.com',
      contrasena: passwordHash,
      fecha_nacimiento: new Date('1998-04-12'),
      direcciones: {
        create: [{ pais: 'Guatemala', direccion: 'Zona 10, Ciudad de Guatemala', codigo_postal: '01010' }],
      },
      metodos_pago: {
        create: [{ titular: 'Ana Gómez', token_pasarela: 'tok_demo_ana', ultimos_4_digitos: '4242', marca: 'Visa' }],
      },
    },
    include: { direcciones: true, metodos_pago: true },
  });

  const luis = await prisma.usuarios.create({
    data: {
      rol_id: vendedor.id,
      nombres: 'Luis',
      apellidos: 'Ramírez',
      correo: 'luis.ramirez@example.com',
      contrasena: passwordHash,
      fecha_nacimiento: new Date('1990-09-03'),
    },
  });

  // --- catálogo (Mongo): categorías → subcategorías con sus atributos definidos embebidos ---
  const categoriaRopa = await Categoria.create({ categoria: 'Ropa' });
  const categoriaElectronica = await Categoria.create({ categoria: 'Electrónica' });

  const subcatCamisetas = await Subcategoria.create({
    categoria_id: categoriaRopa._id,
    subcategoria: 'Camisetas',
    atributos_definidos: ['Talla', 'Color'],
  });
  const subcatCelulares = await Subcategoria.create({
    categoria_id: categoriaElectronica._id,
    subcategoria: 'Celulares',
    atributos_definidos: ['Almacenamiento', 'Color'],
  });

  // --- productos: fila mínima en MySQL (ancla de FK + inventario) + documento
  // completo en Mongo (descripción/atributos/imágenes/precio/cantidad) + evento
  // inicial de creación — mismo trío que arma productoService.crear() en runtime.
  async function crearProducto({ vendedorId, vendedorNombre, descripcion, imagenUrl, subcategoriaId, precio, cantidad, atributos }) {
    const productoRelacional = await prisma.producto.create({
      data: { id_vendedor: vendedorId, inventario: { create: { precio, cantidad } } },
    });

    const doc = await Producto.create({
      producto_id: productoRelacional.id,
      descripcion,
      estado: 'activo',
      subcategoria_id: subcategoriaId,
      vendedor_id: vendedorId,
      vendedor_nombre: vendedorNombre,
      precio,
      cantidad,
      atributos,
      imagenes: imagenUrl ? [{ url: imagenUrl, alt: descripcion, orden: 1, principal: true }] : [],
      version: 1,
    });

    await ProductoEvento.create({
      producto_id: productoRelacional.id,
      version: 1,
      tipo: 'creacion',
      fecha: doc.actualizado_en,
      usuario_id: vendedorId,
      campos_modificados: [],
      snapshot: {
        descripcion: doc.descripcion,
        estado: doc.estado,
        atributos: doc.atributos,
        imagenes: doc.imagenes,
        inventario: { precio, cantidad },
      },
    });

    return { productoRelacional, doc };
  }

  const vendedorNombre = `${luis.nombres} ${luis.apellidos}`;

  const { doc: camiseta } = await crearProducto({
    vendedorId: luis.id_usuario,
    vendedorNombre,
    descripcion: 'Camiseta básica de algodón',
    imagenUrl: 'https://picsum.photos/seed/camiseta/400',
    subcategoriaId: subcatCamisetas._id,
    precio: 89.99,
    cantidad: 50,
    atributos: [
      { nombre: 'Talla', valor: 'M' },
      { nombre: 'Color', valor: 'Azul' },
    ],
  });

  const { doc: smartphone } = await crearProducto({
    vendedorId: luis.id_usuario,
    vendedorNombre,
    descripcion: 'Smartphone X100',
    imagenUrl: 'https://picsum.photos/seed/smartphone/400',
    subcategoriaId: subcatCelulares._id,
    precio: 2499.0,
    cantidad: 15,
    atributos: [
      { nombre: 'Almacenamiento', valor: '128GB' },
      { nombre: 'Color', valor: 'Negro' },
    ],
  });

  console.log('Seed completado:');
  console.log({
    usuarios: [usuario1.correo],
    productos: [camiseta.descripcion, smartphone.descripcion],
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await mongoose.disconnect();
  });
