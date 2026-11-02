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
// - Productos: se busca por nombre exacto antes de crear; si ya existe,
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

// Catálogo a generar. `base` trae exactamente tantos pares [nombre, descripción] como
// `cantidad` pide — no hay dos productos de la misma subcategoría con el
// mismo nombre base, y cada nombre ya es descriptivo por sí solo (nunca
// "Producto 1/2/3"). Los valores de atributos se reparten por índice
// (determinista, no al azar) para que la corrida sea reproducible.
const CATALOGO = {
  Camisetas: {
    cantidad: 7,
    base: [
      ['Camiseta básica de manga corta', 'Prenda ligera de manga corta para vestir a diario.'],
      ['Camiseta oversize streetwear', 'Corte amplio y holgado para llevar con ropa urbana.'],
      ['Camiseta deportiva transpirable', 'Tejido ventilado para entrenar con mayor comodidad.'],
      ['Camiseta estampada retro', 'Estampado inspirado en los diseños de décadas pasadas.'],
      ['Camiseta de manga larga térmica', 'Mangas largas para abrigarse como primera capa en días fríos.'],
      ['Camiseta polo clásica', 'Cuello con solapa y abertura de botones para un estilo informal.'],
      ['Camiseta cuello redondo lisa', 'Cuello redondo y diseño sin estampados para combinar con otras prendas.'],
    ],
    atributos: { Talla: ['S', 'M', 'L', 'XL'], Color: ['Blanco', 'Negro', 'Azul', 'Gris', 'Rojo'], Material: ['Algodón', 'Poliéster', 'Lino'] },
    precio: [35, 90],
  },
  Celulares: {
    cantidad: 7,
    base: [
      ['Smartphone gama de entrada', 'Teléfono para llamadas, mensajes y aplicaciones cotidianas.'],
      ['Smartphone gama media', 'Móvil versátil para navegar, tomar fotos y trabajar en el día a día.'],
      ['Smartphone gama alta', 'Equipo orientado a aplicaciones exigentes y tareas simultáneas.'],
      ['Smartphone plegable', 'Pantalla que se dobla para guardar el teléfono en un espacio pequeño.'],
      ['Smartphone cámara triple', 'Tres cámaras traseras para alternar entre diferentes encuadres.'],
      ['Smartphone edición compacta', 'Formato compacto para manejarlo con una mano y llevarlo en el bolsillo.'],
      ['Smartphone batería extendida', 'Pensado para jornadas largas de llamadas y navegación entre cargas.'],
    ],
    atributos: { Almacenamiento: ['64GB', '128GB', '256GB', '512GB'], Color: ['Negro', 'Azul medianoche', 'Blanco perla', 'Verde'], RAM: ['4GB', '6GB', '8GB', '12GB'] },
    precio: [899, 12999],
  },
  Cocina: {
    cantidad: 7,
    base: [
      ['Sartén antiadherente', 'Superficie que facilita cocinar huevos o saltear verduras sin que se peguen.'],
      ['Olla de acero inoxidable', 'Recipiente profundo para hervir pasta o preparar caldos y guisos.'],
      ['Juego de cuchillos', 'Hojas de distintos tamaños para cortar, rebanar y trocear ingredientes.'],
      ['Tabla para picar', 'Superficie de apoyo para preparar alimentos sin marcar la encimera.'],
      ['Batidora de mano', 'Aparato de mano para mezclar ingredientes y emulsionar salsas.'],
      ['Licuadora de vaso', 'Vaso con cuchillas para triturar frutas y preparar batidos.'],
      ['Set de utensilios de cocina', 'Piezas para remover, voltear y servir los alimentos mientras se cocina.'],
    ],
    atributos: { Material: ['Aluminio', 'Acero inoxidable', 'Vidrio templado', 'Madera', 'Plástico BPA free'] },
    precio: [45, 899],
  },
  Bicicletas: {
    cantidad: 7,
    base: [
      ['Bicicleta de montaña', 'Para recorrer senderos y caminos de tierra con desniveles.'],
      ['Bicicleta urbana', 'Para desplazamientos cotidianos por calles y ciclovías.'],
      ['Bicicleta de ruta', 'Para recorridos largos y rápidos sobre asfalto.'],
      ['Bicicleta eléctrica', 'Asistencia al pedaleo para subir pendientes y recorrer más distancia.'],
      ['Bicicleta plegable', 'Cuadro que se pliega para facilitar el transporte y el guardado.'],
      ['Bicicleta infantil', 'Tamaño pensado para que los más pequeños aprendan a pedalear.'],
      ['Bicicleta BMX', 'Para practicar saltos y maniobras en pista.'],
    ],
    atributos: { 'Talla de cuadro': ['S (46cm)', 'M (52cm)', 'L (58cm)', 'XL (61cm)'] },
    precio: [899, 8999],
  },
  Pantalones: {
    cantidad: 6,
    base: [
      ['Pantalón jeans slim fit', 'Corte ajustado en la pierna para vestir a diario.'],
      ['Pantalón cargo', 'Bolsillos laterales para llevar objetos pequeños al alcance.'],
      ['Pantalón deportivo jogger', 'Piernas con puños para caminar, descansar o hacer ejercicio.'],
      ['Pantalón de vestir', 'Corte formal para combinar con camisa en la oficina.'],
      ['Pantalón corto (short)', 'Diseño por encima de la rodilla para días cálidos.'],
      ['Pantalón térmico', 'Capa de abrigo para mantener las piernas calientes.'],
    ],
    atributos: { Talla: ['28', '30', '32', '34', '36'], Color: ['Azul', 'Negro', 'Caqui', 'Gris'], Material: ['Denim', 'Algodón', 'Poliéster'] },
    precio: [79, 249],
  },
  Zapatos: {
    cantidad: 6,
    base: [
      ['Zapato deportivo running', 'Calzado para carreras y entrenamientos a pie.'],
      ['Zapato casual de cuero', 'Para uso diario con un acabado de estilo casual.'],
      ['Bota de trabajo', 'Caña alta para cubrir el tobillo durante la jornada.'],
      ['Sandalia deportiva', 'Diseño abierto para caminar en clima cálido.'],
      ['Zapato formal', 'Calzado para vestir con traje en reuniones y eventos.'],
      ['Tenis urbano', 'Calzado informal para caminar por la ciudad.'],
    ],
    atributos: { Talla: ['37', '38', '39', '40', '41', '42'], Color: ['Negro', 'Blanco', 'Café', 'Gris'] },
    precio: [99, 599],
  },
  Chaquetas: {
    cantidad: 6,
    base: [
      ['Chaqueta impermeable', 'Capa exterior para protegerse de la lluvia.'],
      ['Chaqueta de cuero', 'Prenda de estilo motero para combinar con ropa informal.'],
      ['Chaqueta deportiva', 'Capa ligera para usar antes o después del entrenamiento.'],
      ['Chaqueta acolchada de invierno', 'Relleno acolchado para conservar el calor en días fríos.'],
      ['Chaqueta cortavientos', 'Prenda exterior que reduce el paso del viento.'],
      ['Chaqueta de mezclilla', 'Diseño vaquero para usar sobre una camiseta.'],
    ],
    atributos: { Talla: ['S', 'M', 'L', 'XL'], Color: ['Negro', 'Azul', 'Verde olivo', 'Café'], Material: ['Poliéster', 'Cuero sintético', 'Denim'] },
    precio: [199, 699],
  },
  Laptops: {
    cantidad: 6,
    base: [
      ['Laptop ultradelgada', 'Computadora de perfil fino para llevar entre casa y oficina.'],
      ['Laptop para gaming', 'Portátil orientada a videojuegos y gráficos en movimiento.'],
      ['Laptop convertible 2 en 1', 'Pantalla abatible para alternar entre portátil y tableta.'],
      ['Laptop para oficina', 'Para redactar documentos, usar hojas de cálculo y hacer videollamadas.'],
      ['Laptop de alto rendimiento', 'Para edición de contenido y varias aplicaciones en paralelo.'],
      ['Laptop económica', 'Para estudiar, navegar y resolver tareas básicas.'],
    ],
    atributos: { Almacenamiento: ['256GB SSD', '512GB SSD', '1TB SSD'], RAM: ['8GB', '16GB', '32GB'], Color: ['Gris espacial', 'Plata', 'Negro'] },
    precio: [2999, 18999],
  },
  Audífonos: {
    cantidad: 6,
    base: [
      ['Audífonos inalámbricos con cancelación de ruido', 'Para escuchar música reduciendo el ruido ambiental.'],
      ['Audífonos deportivos resistentes al agua', 'Para escuchar audio mientras se hace ejercicio al aire libre.'],
      ['Audífonos over-ear de estudio', 'Copas que rodean las orejas para escuchar y mezclar grabaciones.'],
      ['Audífonos in-ear económicos', 'Formato pequeño que se coloca en el oído para escuchar a diario.'],
      ['Audífonos gamer con micrófono', 'Micrófono para conversar con el equipo durante una partida.'],
      ['Audífonos plegables de viaje', 'Diseño que se pliega para ocupar menos espacio en el equipaje.'],
    ],
    atributos: { Color: ['Negro', 'Blanco', 'Azul'], Conectividad: ['Bluetooth 5.0', 'Bluetooth 5.3', 'Cable 3.5mm'] },
    precio: [79, 1499],
  },
  Televisores: {
    cantidad: 6,
    base: [
      ['Televisor Smart TV LED', 'Pantalla conectada para ver series y usar aplicaciones de vídeo.'],
      ['Televisor OLED premium', 'Panel con píxeles de luz propia para reproducir escenas oscuras.'],
      ['Televisor 4K UHD', 'Pantalla de alta definición para ver cine y deportes.'],
      ['Televisor para exteriores', 'Diseñado para ver contenidos en terrazas y espacios abiertos.'],
      ['Televisor curvo', 'Pantalla con curvatura para una vista envolvente.'],
      ['Televisor económico HD', 'Pantalla sencilla para ver canales y programas habituales.'],
    ],
    atributos: { 'Tamaño de pantalla': ['32"', '43"', '50"', '55"', '65"', '75"'], Resolución: ['HD', 'Full HD', '4K UHD', '8K'] },
    precio: [1299, 15999],
  },
  Muebles: {
    cantidad: 6,
    base: [
      ['Sofá de tres plazas', 'Asiento con espacio para tres personas en la sala.'],
      ['Mesa de comedor', 'Superficie para reunir a varias personas a la hora de comer.'],
      ['Silla ergonómica de oficina', 'Asiento pensado para mantener una postura cómoda al trabajar.'],
      ['Estantería modular', 'Módulos para organizar libros u objetos según el espacio disponible.'],
      ['Cama matrimonial', 'Base de descanso para un colchón de dos plazas.'],
      ['Mueble para TV', 'Soporte para la pantalla y los equipos de entretenimiento.'],
    ],
    atributos: { Material: ['Madera de pino', 'MDF laminado', 'Metal', 'Tela'], Color: ['Café', 'Blanco', 'Gris', 'Negro'] },
    precio: [399, 3999],
  },
  Decoración: {
    cantidad: 6,
    base: [
      ['Espejo decorativo de pared', 'Para reflejar la luz y ampliar visualmente una habitación.'],
      ['Lámpara de mesa', 'Iluminación puntual para una mesa de noche o un escritorio.'],
      ['Cuadro decorativo', 'Pieza para dar color a una pared interior.'],
      ['Jarrón de cerámica', 'Recipiente decorativo para colocar flores o ramas.'],
      ['Set de velas aromáticas', 'Velas perfumadas para ambientar una estancia.'],
      ['Cortina blackout', 'Tela opaca para oscurecer el dormitorio y controlar la entrada de luz.'],
    ],
    atributos: { Material: ['Cerámica', 'Vidrio', 'Metal', 'Tela'], Color: ['Blanco', 'Dorado', 'Negro', 'Beige'] },
    precio: [59, 599],
  },
  Jardín: {
    cantidad: 6,
    base: [
      ['Maceta grande para exteriores', 'Recipiente amplio para cultivar plantas en el patio.'],
      ['Set de herramientas de jardinería', 'Implementos de mano para remover tierra y trasplantar.'],
      ['Manguera de riego extensible', 'Conducto flexible que se alarga al regar el jardín.'],
      ['Silla plegable de jardín', 'Asiento de exterior que se recoge para guardarlo.'],
      ['Sombrilla para patio', 'Cubierta de sombra para una mesa o zona de descanso al aire libre.'],
      ['Kit de semillas para huerto', 'Semillas para iniciar un pequeño cultivo en casa.'],
    ],
    atributos: { Material: ['Plástico resistente UV', 'Terracota', 'Aluminio', 'Madera tratada'] },
    precio: [49, 799],
  },
  Pesas: {
    cantidad: 6,
    base: [
      ['Mancuerna ajustable', 'Permite variar la carga durante ejercicios de fuerza con una mano.'],
      ['Kit de pesas rusas (kettlebell)', 'Pesos con asa para balanceos y entrenamiento funcional.'],
      ['Barra olímpica con discos', 'Barra larga con discos para ejercicios de levantamiento.'],
      ['Set de mancuernas hexagonales', 'Pesos de caras planas que permanecen estables en el suelo.'],
      ['Banda de resistencia', 'Cinta elástica para trabajar fuerza y movilidad.'],
      ['Disco de peso olímpico', 'Carga adicional para montar en una barra de levantamiento.'],
    ],
    atributos: { Peso: ['5kg', '10kg', '15kg', '20kg', '25kg'] },
    precio: [99, 1299],
  },
  'Ropa deportiva': {
    cantidad: 6,
    base: [
      ['Short deportivo', 'Pantalón corto para entrenar con libertad de movimiento.'],
      ['Legging de compresión', 'Prenda ceñida para correr y realizar ejercicios de piernas.'],
      ['Top deportivo', 'Prenda de sujeción para la parte superior del cuerpo al entrenar.'],
      ['Conjunto deportivo completo', 'Piezas coordinadas para vestir durante la actividad física.'],
      ['Sudadera con capucha', 'Prenda de abrigo con capucha para usar antes o después del ejercicio.'],
      ['Chaleco deportivo', 'Capa sin mangas para abrigar el torso dejando libres los brazos.'],
    ],
    atributos: { Talla: ['S', 'M', 'L', 'XL'], Color: ['Negro', 'Gris', 'Azul', 'Rosado'] },
    precio: [69, 349],
  },
  Balones: {
    cantidad: 6,
    base: [
      ['Balón de fútbol profesional', 'Pelota para entrenar pases, centros y tiros a portería.'],
      ['Balón de baloncesto', 'Pelota para practicar el bote y el lanzamiento a canasta.'],
      ['Balón de voleibol', 'Pelota para saques y remates sobre la red.'],
      ['Balón de fútbol infantil', 'Pelota para que niños y niñas practiquen tiros y pases.'],
      ['Balón medicinal', 'Carga esférica para ejercicios de fuerza y lanzamientos.'],
      ['Balón de rugby', 'Pelota ovalada para pases con las manos y patadas en el campo.'],
    ],
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

async function crearProducto(vendedor, { nombre, descripcion, subcategoriaId, precio, cantidad, atributos, imagenSeed }) {
  const yaExiste = await Producto.findOne({ nombre }).select('_id').lean();
  if (yaExiste) return { creado: false };

  await productoService.crear(vendedor, {
    nombre,
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
      const [nombre, descripcion] = config.base[i];
      const atributos = nombresAtributos.map((nombre) => ({ nombre, valor: valorPorIndice(config.atributos[nombre], i) }));
      const precio = precioPorIndice(config.precio, i, config.cantidad);
      const cantidadStock = 15 + ((i * 7 + contadorGlobal) % 46); // 15–60, determinista

      const vendedorDb = vendedores[indiceVendedor % vendedores.length];
      indiceVendedor += 1;
      contadorGlobal += 1;

      try {
        const { creado } = await crearProducto(
          { id_usuario: vendedorDb.id_usuario, rol: 'vendedor' },
          { nombre, descripcion, subcategoriaId, precio, cantidad: cantidadStock, atributos, imagenSeed: slug(nombre) }
        );
        if (creado) {
          creados += 1;
          console.log(`  [${contadorGlobal}/100] OK: ${nombre} (${subcategoriaNombre}) — Q${precio}, stock ${cantidadStock}`);
        } else {
          omitidos += 1;
          console.log(`  [${contadorGlobal}/100] omitido (ya existía): ${nombre}`);
        }
      } catch (err) {
        fallidos += 1;
        console.error(`  [${contadorGlobal}/100] FALLÓ: ${nombre} — ${err.message}`);
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
