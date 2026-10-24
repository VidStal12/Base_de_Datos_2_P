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
  // Vacía el catálogo Y el historial de cambios: es una tarea de administración. El rol de la aplicación no puede
  // borrar (el historial es append-only), así que el seed entra con la cuenta de administración (IA/ADR-007).
  await conectar('admin');
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
    // RAM sumado para Entrega 2 (recomendaciones por tendencia, ver
    // ENTREGA-2-PLAN.md §4.5) — el ejemplo de referencia usa justo
    // almacenamiento + RAM como los atributos que definen la preferencia de
    // un comprador dentro de Celulares.
    atributos_definidos: ['Almacenamiento', 'RAM', 'Color'],
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
      inventario: { precio, cantidad },
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
      { nombre: 'RAM', valor: '8GB' },
      { nombre: 'Color', valor: 'Negro' },
    ],
  });

  // --- segundo vendedor + productos que compiten con los de Luis en las
  // mismas subcategorías, con los MISMOS atributos — sin esto, no hay nada
  // de qué "recomendaciones por tendencia" (Entrega 2, ver
  // ENTREGA-2-PLAN.md §4.5) pueda encontrar: un catálogo de un solo vendedor
  // por subcategoría no tiene comparación entre vendedores posible. Sembrado
  // a propósito, mismo criterio que ya se documentó para reseñas coordinadas
  // en §4.3 — es lo que le da a la consulta de tendencia algo real que
  // encontrar, no una decoración.
  const marta = await prisma.usuarios.create({
    data: {
      rol_id: vendedor.id,
      nombres: 'Marta',
      apellidos: 'Díaz',
      correo: 'marta.diaz@example.com',
      contrasena: passwordHash,
      fecha_nacimiento: new Date('1993-02-20'),
    },
  });
  const martaNombre = `${marta.nombres} ${marta.apellidos}`;

  await crearProducto({
    vendedorId: marta.id_usuario,
    vendedorNombre: martaNombre,
    descripcion: 'Camiseta de algodón pima',
    imagenUrl: 'https://picsum.photos/seed/camiseta-marta/400',
    subcategoriaId: subcatCamisetas._id,
    precio: 79.5,
    cantidad: 30,
    atributos: [
      { nombre: 'Talla', valor: 'M' },
      { nombre: 'Color', valor: 'Azul' },
    ],
  });

  await crearProducto({
    vendedorId: marta.id_usuario,
    vendedorNombre: martaNombre,
    descripcion: 'Smartphone Z9',
    imagenUrl: 'https://picsum.photos/seed/smartphone-marta/400',
    subcategoriaId: subcatCelulares._id,
    precio: 2299.0,
    cantidad: 10,
    atributos: [
      { nombre: 'Almacenamiento', valor: '128GB' },
      { nombre: 'RAM', valor: '8GB' },
      { nombre: 'Color', valor: 'Gris' },
    ],
  });

  console.log('Seed completado:');
  console.log({
    usuarios: [usuario1.correo, marta.correo],
    productos: [camiseta.descripcion, smartphone.descripcion, 'Camiseta de algodón pima', 'Smartphone Z9'],
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
