require('dotenv').config();
const bcrypt = require('bcryptjs');
const prisma = require('../src/config/prisma');

async function main() {
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

  await prisma.usuarios.create({
    data: {
      rol_id: vendedor.id,
      nombres: 'Luis',
      apellidos: 'Ramírez',
      correo: 'luis.ramirez@example.com',
      contrasena: passwordHash,
      fecha_nacimiento: new Date('1990-09-03'),
    },
  });

  const categoriaRopa = await prisma.categoria.create({ data: { categoria: 'Ropa' } });
  const categoriaElectronica = await prisma.categoria.create({ data: { categoria: 'Electrónica' } });

  const subcatCamisetas = await prisma.subcategoria.create({
    data: { id_categoria: categoriaRopa.id, subcategoria: 'Camisetas' },
  });
  const subcatCelulares = await prisma.subcategoria.create({
    data: { id_categoria: categoriaElectronica.id, subcategoria: 'Celulares' },
  });

  const atribTalla = await prisma.atributo_categoria.create({
    data: { id_subcategoria: subcatCamisetas.id, atributo: 'Talla' },
  });
  const atribColorRopa = await prisma.atributo_categoria.create({
    data: { id_subcategoria: subcatCamisetas.id, atributo: 'Color' },
  });
  const atribAlmacenamiento = await prisma.atributo_categoria.create({
    data: { id_subcategoria: subcatCelulares.id, atributo: 'Almacenamiento' },
  });
  const atribColorTech = await prisma.atributo_categoria.create({
    data: { id_subcategoria: subcatCelulares.id, atributo: 'Color' },
  });

  const camiseta = await prisma.producto.create({
    data: {
      descripcion: 'Camiseta básica de algodón',
      imagen_url: 'https://picsum.photos/seed/camiseta/400',
      estado: 'activo',
      inventario: { create: { precio: 89.99, cantidad: 50 } },
      categoria_productos: { create: [{ id_subcategoria: subcatCamisetas.id }] },
      atributos_producto: {
        create: [
          { id_atributo_categoria: atribTalla.id, valor: 'M' },
          { id_atributo_categoria: atribColorRopa.id, valor: 'Azul' },
        ],
      },
    },
  });

  const smartphone = await prisma.producto.create({
    data: {
      descripcion: 'Smartphone X100',
      imagen_url: 'https://picsum.photos/seed/smartphone/400',
      estado: 'activo',
      inventario: { create: { precio: 2499.0, cantidad: 15 } },
      categoria_productos: { create: [{ id_subcategoria: subcatCelulares.id }] },
      atributos_producto: {
        create: [
          { id_atributo_categoria: atribAlmacenamiento.id, valor: '128GB' },
          { id_atributo_categoria: atribColorTech.id, valor: 'Negro' },
        ],
      },
    },
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
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
