require('dotenv').config();
const mongoose = require('mongoose');
const prisma = require('../src/config/prisma');
const elasticsearch = require('../src/config/elasticsearch');
const { conectar: conectarMongo } = require('../src/config/mongo');
const Subcategoria = require('../src/models/mongo/Subcategoria');
const Producto = require('../src/models/mongo/Producto');
const categoriaService = require('../src/services/categoriaService');
const productoService = require('../src/services/productoService');

// Siembra 100 productos reales, repartidos en categorías/subcategorías
// distintas, para llenar el catálogo. Pasa TODO por productoService.crear()
// (nunca un insert directo a Mongo) porque es el único camino que dispara
// los tres efectos que un producto real necesita: fila en MySQL
// (producto+inventario), documento en Mongo, evento en ProductoEvento, Y
// AHORA TAMBIÉN indexado en Elasticsearch (ver busquedaSyncService.js) —
// saltarse el servicio dejaría el catálogo y el buscador desincronizados
// desde el primer producto.
//
// Idempotente en dos niveles, para poder correr esto más de una vez sin
// romper nada:
// - Subcategorías/atributos: se busca por nombre antes de crear (nunca se
//   editan/borran una vez creados, ver ESTADO-PROYECTO.md §5 — así que la
//   estructura de abajo es deliberada y final, no generada al azar).
// - Productos: se busca por descripción exacta antes de crear; si ya existe,
//   se omite en vez de duplicar.

// Categorías YA existentes (ver Categoria.js) — nunca se vuelven a crear:
// Categoria no tiene índice único por nombre, así que categoriaService.crear()
// generaría un duplicado silencioso si se le pasa "Ropa" otra vez.
const CATEGORIA_IDS = {
  Ropa: '6a8aa3e599d4a899583bc863',
  Electrónica: '6a8aa3e599d4a899583bc864',
  Hogar: '6a8aa3e599d4a899583bc865',
  Deportes: '6a8aa3e599d4a899583bc866',
};

// Subcategorías nuevas a agregar, además de las 4 que ya existen (Camisetas,
// Celulares, Cocina, Bicicletas) — dan variedad real para facetas/búsqueda.
const NUEVAS_SUBCATEGORIAS = {
  Ropa: [
    { nombre: 'Pantalones', atributos: ['Talla', 'Color', 'Material'] },
    { nombre: 'Zapatos', atributos: ['Talla', 'Color'] },
    { nombre: 'Chaquetas', atributos: ['Talla', 'Color', 'Material'] },
  ],
  Electrónica: [
    { nombre: 'Laptops', atributos: ['Almacenamiento', 'RAM', 'Color'] },
    { nombre: 'Audífonos', atributos: ['Color', 'Conectividad'] },
    { nombre: 'Televisores', atributos: ['Tamaño de pantalla', 'Resolución'] },
  ],
  Hogar: [
    { nombre: 'Muebles', atributos: ['Material', 'Color'] },
    { nombre: 'Decoración', atributos: ['Material', 'Color'] },
    { nombre: 'Jardín', atributos: ['Material'] },
  ],
  Deportes: [
    { nombre: 'Pesas', atributos: ['Peso'] },
    { nombre: 'Ropa deportiva', atributos: ['Talla', 'Color'] },
    { nombre: 'Balones', atributos: ['Tamaño', 'Material'] },
  ],
};

// Catálogo a generar. `base` trae exactamente tantos nombres reales como
// `cantidad` pide — no hay dos productos de la misma subcategoría con el
// mismo nombre base, y cada nombre ya es descriptivo por sí solo (nunca
// "Producto 1/2/3"). Los valores de atributos se reparten por índice
// (determinista, no al azar) para que la corrida sea reproducible.
const CATALOGO = {
  Camisetas: {
    cantidad: 7,
    base: [
      'Camiseta básica de manga corta', 'Camiseta oversize streetwear', 'Camiseta deportiva transpirable',
      'Camiseta estampada retro', 'Camiseta de manga larga térmica', 'Camiseta polo clásica', 'Camiseta cuello redondo lisa',
    ],
    atributos: { Talla: ['S', 'M', 'L', 'XL'], Color: ['Blanco', 'Negro', 'Azul', 'Gris', 'Rojo'], Material: ['Algodón', 'Poliéster', 'Lino'] },
    precio: [35, 90],
  },
  Celulares: {
    cantidad: 7,
    base: [
      'Smartphone gama de entrada', 'Smartphone gama media', 'Smartphone gama alta', 'Smartphone plegable',
      'Smartphone cámara triple', 'Smartphone edición compacta', 'Smartphone batería extendida',
    ],
    atributos: { Almacenamiento: ['64GB', '128GB', '256GB', '512GB'], Color: ['Negro', 'Azul medianoche', 'Blanco perla', 'Verde'], RAM: ['4GB', '6GB', '8GB', '12GB'] },
    precio: [899, 12999],
  },
  Cocina: {
    cantidad: 7,
    base: [
      'Sartén antiadherente', 'Olla de acero inoxidable', 'Juego de cuchillos', 'Tabla para picar',
      'Batidora de mano', 'Licuadora de vaso', 'Set de utensilios de cocina',
    ],
    atributos: { Material: ['Aluminio', 'Acero inoxidable', 'Vidrio templado', 'Madera', 'Plástico BPA free'] },
    precio: [45, 899],
  },
  Bicicletas: {
    cantidad: 7,
    base: [
      'Bicicleta de montaña', 'Bicicleta urbana', 'Bicicleta de ruta', 'Bicicleta eléctrica',
      'Bicicleta plegable', 'Bicicleta infantil', 'Bicicleta BMX',
    ],
    atributos: { 'Talla de cuadro': ['S (46cm)', 'M (52cm)', 'L (58cm)', 'XL (61cm)'] },
    precio: [899, 8999],
  },
  Pantalones: {
    cantidad: 6,
    base: ['Pantalón jeans slim fit', 'Pantalón cargo', 'Pantalón deportivo jogger', 'Pantalón de vestir', 'Pantalón corto (short)', 'Pantalón térmico'],
    atributos: { Talla: ['28', '30', '32', '34', '36'], Color: ['Azul', 'Negro', 'Caqui', 'Gris'], Material: ['Denim', 'Algodón', 'Poliéster'] },
    precio: [79, 249],
  },
  Zapatos: {
    cantidad: 6,
    base: ['Zapato deportivo running', 'Zapato casual de cuero', 'Bota de trabajo', 'Sandalia deportiva', 'Zapato formal', 'Tenis urbano'],
    atributos: { Talla: ['37', '38', '39', '40', '41', '42'], Color: ['Negro', 'Blanco', 'Café', 'Gris'] },
    precio: [99, 599],
  },
  Chaquetas: {
    cantidad: 6,
    base: ['Chaqueta impermeable', 'Chaqueta de cuero', 'Chaqueta deportiva', 'Chaqueta acolchada de invierno', 'Chaqueta cortavientos', 'Chaqueta de mezclilla'],
    atributos: { Talla: ['S', 'M', 'L', 'XL'], Color: ['Negro', 'Azul', 'Verde olivo', 'Café'], Material: ['Poliéster', 'Cuero sintético', 'Denim'] },
    precio: [199, 699],
  },
  Laptops: {
    cantidad: 6,
    base: ['Laptop ultradelgada', 'Laptop para gaming', 'Laptop convertible 2 en 1', 'Laptop para oficina', 'Laptop de alto rendimiento', 'Laptop económica'],
    atributos: { Almacenamiento: ['256GB SSD', '512GB SSD', '1TB SSD'], RAM: ['8GB', '16GB', '32GB'], Color: ['Gris espacial', 'Plata', 'Negro'] },
    precio: [2999, 18999],
  },
  Audífonos: {
    cantidad: 6,
    base: [
      'Audífonos inalámbricos con cancelación de ruido', 'Audífonos deportivos resistentes al agua', 'Audífonos over-ear de estudio',
      'Audífonos in-ear económicos', 'Audífonos gamer con micrófono', 'Audífonos plegables de viaje',
    ],
    atributos: { Color: ['Negro', 'Blanco', 'Azul'], Conectividad: ['Bluetooth 5.0', 'Bluetooth 5.3', 'Cable 3.5mm'] },
    precio: [79, 1499],
  },
  Televisores: {
    cantidad: 6,
    base: ['Televisor Smart TV LED', 'Televisor OLED premium', 'Televisor 4K UHD', 'Televisor para exteriores', 'Televisor curvo', 'Televisor económico HD'],
    atributos: { 'Tamaño de pantalla': ['32"', '43"', '50"', '55"', '65"', '75"'], Resolución: ['HD', 'Full HD', '4K UHD', '8K'] },
    precio: [1299, 15999],
  },
  Muebles: {
    cantidad: 6,
    base: ['Sofá de tres plazas', 'Mesa de comedor', 'Silla ergonómica de oficina', 'Estantería modular', 'Cama matrimonial', 'Mueble para TV'],
    atributos: { Material: ['Madera de pino', 'MDF laminado', 'Metal', 'Tela'], Color: ['Café', 'Blanco', 'Gris', 'Negro'] },
    precio: [399, 3999],
  },
  Decoración: {
    cantidad: 6,
    base: ['Espejo decorativo de pared', 'Lámpara de mesa', 'Cuadro decorativo', 'Jarrón de cerámica', 'Set de velas aromáticas', 'Cortina blackout'],
    atributos: { Material: ['Cerámica', 'Vidrio', 'Metal', 'Tela'], Color: ['Blanco', 'Dorado', 'Negro', 'Beige'] },
    precio: [59, 599],
  },
  Jardín: {
    cantidad: 6,
    base: ['Maceta grande para exteriores', 'Set de herramientas de jardinería', 'Manguera de riego extensible', 'Silla plegable de jardín', 'Sombrilla para patio', 'Kit de semillas para huerto'],
    atributos: { Material: ['Plástico resistente UV', 'Terracota', 'Aluminio', 'Madera tratada'] },
    precio: [49, 799],
  },
  Pesas: {
    cantidad: 6,
    base: ['Mancuerna ajustable', 'Kit de pesas rusas (kettlebell)', 'Barra olímpica con discos', 'Set de mancuernas hexagonales', 'Banda de resistencia', 'Disco de peso olímpico'],
    atributos: { Peso: ['5kg', '10kg', '15kg', '20kg', '25kg'] },
    precio: [99, 1299],
  },
  'Ropa deportiva': {
    cantidad: 6,
    base: ['Short deportivo', 'Legging de compresión', 'Top deportivo', 'Conjunto deportivo completo', 'Sudadera con capucha', 'Chaleco deportivo'],
    atributos: { Talla: ['S', 'M', 'L', 'XL'], Color: ['Negro', 'Gris', 'Azul', 'Rosado'] },
    precio: [69, 349],
  },
  Balones: {
    cantidad: 6,
    base: ['Balón de fútbol profesional', 'Balón de baloncesto', 'Balón de voleibol', 'Balón de fútbol infantil', 'Balón medicinal', 'Balón de rugby'],
    atributos: { Tamaño: ['3', '4', '5', '7'], Material: ['Cuero sintético', 'PVC', 'Caucho'] },
    precio: [59, 349],
  },
};

function slug(texto) {
  return texto.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function valorPorIndice(valores, i) {
  return valores[i % valores.length];
}

function precioPorIndice([min, max], i, total) {
  const paso = total > 1 ? (max - min) * (i / (total - 1)) : 0;
  const bruto = min + paso;
  return Math.round(bruto * 100) / 100;
}

// Subcategoría existente si ya hay una con ese nombre bajo esa categoría
// (idempotente); si no, la crea Y agrega cada atributo definido — ambos
// pasos son permanentes (no se pueden editar/borrar después), por eso la
// estructura vive completa y deliberada en NUEVAS_SUBCATEGORIAS arriba.
async function asegurarSubcategoria(categoriaId, nombre, atributos) {
  const existente = await Subcategoria.findOne({ categoria_id: categoriaId, subcategoria: nombre });
  if (existente) return String(existente._id);

  const creada = await categoriaService.crearSubcategoria(categoriaId, { subcategoria: nombre });
  for (const atributo of atributos) {
    await categoriaService.crearAtributo(creada.id, { atributo });
  }
  console.log(`  + Subcategoría creada: ${nombre} (${atributos.join(', ')})`);
  return creada.id;
}

async function crearProducto(vendedor, { descripcion, subcategoriaId, precio, cantidad, atributos, imagenSeed }) {
  const yaExiste = await Producto.findOne({ descripcion }).select('_id').lean();
  if (yaExiste) return { creado: false };

  await productoService.crear(vendedor, {
    descripcion,
    imagen_url: `https://picsum.photos/seed/${imagenSeed}/400`,
    estado: 'activo',
    subcategoriaId,
    precio,
    cantidad,
    atributos,
  });
  return { creado: true };
}

async function main() {
  await conectarMongo();

  const vendedores = await prisma.usuarios.findMany({
    where: { rol: { tipo_rol: 'vendedor' } },
    select: { id_usuario: true, nombres: true, apellidos: true },
  });
  if (vendedores.length === 0) throw new Error('No hay ninguna cuenta vendedor en la base — hace falta al menos una para crear productos.');
  console.log(`Vendedores disponibles: ${vendedores.map((v) => `${v.nombres} ${v.apellidos}`).join(', ')}`);

  console.log('\nAsegurando subcategorías nuevas...');
  const subcategoriaIds = {
    Camisetas: '6a8aa3e599d4a899583bc867',
    Celulares: '6a8aa3e599d4a899583bc868',
    Cocina: '6a8aa3e599d4a899583bc869',
    Bicicletas: '6a8aa3e599d4a899583bc86a',
  };
  for (const [categoria, lista] of Object.entries(NUEVAS_SUBCATEGORIAS)) {
    for (const { nombre, atributos } of lista) {
      subcategoriaIds[nombre] = await asegurarSubcategoria(CATEGORIA_IDS[categoria], nombre, atributos);
    }
  }

  console.log('\nCreando productos...');
  let creados = 0;
  let omitidos = 0;
  let fallidos = 0;
  let indiceVendedor = 0;
  let contadorGlobal = 0;

  for (const [subcategoriaNombre, config] of Object.entries(CATALOGO)) {
    const subcategoriaId = subcategoriaIds[subcategoriaNombre];
    const nombresAtributos = Object.keys(config.atributos);

    for (let i = 0; i < config.cantidad; i += 1) {
      const descripcion = config.base[i];
      const atributos = nombresAtributos.map((nombre) => ({ nombre, valor: valorPorIndice(config.atributos[nombre], i) }));
      const precio = precioPorIndice(config.precio, i, config.cantidad);
      const cantidadStock = 15 + ((i * 7 + contadorGlobal) % 46); // 15–60, determinista

      const vendedorDb = vendedores[indiceVendedor % vendedores.length];
      indiceVendedor += 1;
      contadorGlobal += 1;

      try {
        const { creado } = await crearProducto(
          { id_usuario: vendedorDb.id_usuario, rol: 'vendedor' },
          { descripcion, subcategoriaId, precio, cantidad: cantidadStock, atributos, imagenSeed: slug(descripcion) }
        );
        if (creado) {
          creados += 1;
          console.log(`  [${contadorGlobal}/100] OK: ${descripcion} (${subcategoriaNombre}) — Q${precio}, stock ${cantidadStock}`);
        } else {
          omitidos += 1;
          console.log(`  [${contadorGlobal}/100] omitido (ya existía): ${descripcion}`);
        }
      } catch (err) {
        fallidos += 1;
        console.error(`  [${contadorGlobal}/100] FALLÓ: ${descripcion} — ${err.message}`);
      }
    }
  }

  console.log(`\nListo: ${creados} creados, ${omitidos} omitidos (ya existían), ${fallidos} fallidos.`);
  if (fallidos > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await mongoose.disconnect();
    await elasticsearch.cerrar();
  });
