const prisma = require('../config/prisma');
const { conectar } = require('../config/mongo');
const Producto = require('../models/mongo/Producto');
const Subcategoria = require('../models/mongo/Subcategoria');
const ProductoEvento = require('../models/mongo/ProductoEvento');
const { esEnteroPositivo } = require('../utils/validation');

// Contenido descriptivo (Mongo) + precio/cantidad (MySQL, sin tocar) — ver
// ADR-002 §3.2. Las dos bases se leen por separado y se combinan acá; no hace
// falta que sea una transacción porque son dos LECTURAS independientes.
function formatear(doc, inventario) {
  const principal = doc.imagenes?.find((img) => img.principal) || doc.imagenes?.[0];
  return {
    id: doc.producto_id,
    descripcion: doc.descripcion,
    estado: doc.estado,
    imagen_url: principal?.url || '',
    imagenes: doc.imagenes || [],
    atributos: doc.atributos || [],
    vendedor_id: doc.vendedor_id,
    vendedor_nombre: doc.vendedor_nombre,
    subcategoria: doc.subcategoria_id
      ? {
          id: String(doc.subcategoria_id._id || doc.subcategoria_id),
          subcategoria: doc.subcategoria_id.subcategoria,
          categoria_id: doc.subcategoria_id.categoria_id ? String(doc.subcategoria_id.categoria_id._id || doc.subcategoria_id.categoria_id) : undefined,
          categoria: doc.subcategoria_id.categoria_id?.categoria,
        }
      : undefined,
    version: doc.version,
    inventario: inventario
      ? { id: inventario.id, id_producto: inventario.id_producto, precio: inventario.precio, cantidad: inventario.cantidad }
      : null,
  };
}

async function combinarConInventario(documentos) {
  if (documentos.length === 0) return [];
  const ids = documentos.map((d) => d.producto_id);
  const inventarios = await prisma.inventario.findMany({ where: { id_producto: { in: ids } } });
  const mapaInventario = new Map(inventarios.map((inv) => [inv.id_producto, inv]));
  return documentos.map((doc) => formatear(doc, mapaInventario.get(doc.producto_id)));
}

// atributos: JSON de { [nombre]: valor } (ver productoRoutes.js) — filtrado
// facetado, un valor exacto por atributo, todos exigidos a la vez. Cada par
// necesita su propio $elemMatch porque tienen que coincidir con elementos
// distintos del array `atributos`; un solo $elemMatch con ambos campos exigiría
// que el MISMO elemento tuviera nombre Y valor de dos atributos diferentes a
// la vez, que nunca pasa.
function condicionesAtributos(atributos) {
  if (!atributos) return [];
  let pares;
  try {
    pares = typeof atributos === 'string' ? JSON.parse(atributos) : atributos;
  } catch {
    return []; // JSON inválido en un endpoint público de solo lectura: se ignora, no se rompe la página.
  }
  if (!pares || typeof pares !== 'object') return [];
  return Object.entries(pares)
    .filter(([nombre, valor]) => nombre && valor)
    .map(([nombre, valor]) => ({ atributos: { $elemMatch: { nombre, valor } } }));
}

// Filtro de texto simple (contains) — no confundir con el buscador de texto
// libre con tolerancia ortográfica que pide el PRD para Entrega 3 (Elasticsearch).
//
// precioMin/precioMax: precio vive en MySQL, no en Mongo (ver ADR-002 §3.2) —
// se resuelve el rango ahí primero (barato, `inventario` es una tabla chica)
// y el resultado se pasa a Mongo como un $in sobre producto_id. No hay forma
// de evitar la consulta cruzada acá porque el dato vive en la otra base.
//
// ordenarPor: 'masVendidos' usa total_vendido (caché, ver Producto.js) y el
// índice compuesto {subcategoria_id, total_vendido} — más preciso cuando se
// filtra por subcategoriaId (igualdad exacta sobre el primer campo del
// índice) que por categoriaId (que resuelve a un $in de varias subcategorías).
async function listar({ categoriaId, subcategoriaId, q, vendedorId, atributos, precioMin, precioMax, ordenarPor } = {}) {
  await conectar();
  const filtro = {};

  if (subcategoriaId) {
    filtro.subcategoria_id = subcategoriaId;
  } else if (categoriaId) {
    const subcategorias = await Subcategoria.find({ categoria_id: categoriaId }).select('_id');
    filtro.subcategoria_id = { $in: subcategorias.map((s) => s._id) };
  }
  if (q) {
    filtro.descripcion = { $regex: q, $options: 'i' };
  }
  if (vendedorId) {
    filtro.vendedor_id = Number(vendedorId);
  }
  const condiciones = condicionesAtributos(atributos);
  if (condiciones.length) {
    filtro.$and = condiciones;
  }
  if (precioMin !== undefined || precioMax !== undefined) {
    const rango = {};
    if (precioMin !== undefined) rango.gte = Number(precioMin);
    if (precioMax !== undefined) rango.lte = Number(precioMax);
    const enRango = await prisma.inventario.findMany({
      where: { precio: rango },
      select: { id_producto: true },
    });
    filtro.producto_id = { $in: enRango.map((i) => i.id_producto) };
  }

  let consulta = Producto.find(filtro).populate({ path: 'subcategoria_id', populate: { path: 'categoria_id' } });
  if (ordenarPor === 'masVendidos') {
    consulta = consulta.sort({ total_vendido: -1 });
  }
  const documentos = await consulta.lean();
  return combinarConInventario(documentos);
}

async function obtener(id) {
  await conectar();
  const doc = await Producto.findOne({ producto_id: id })
    .populate({ path: 'subcategoria_id', populate: { path: 'categoria_id' } })
    .lean();
  if (!doc) throw new Error('Producto no encontrado');
  const inventario = await prisma.inventario.findUnique({ where: { id_producto: id } });
  return formatear(doc, inventario);
}

function construirImagenes(imagen_url, descripcion) {
  return imagen_url ? [{ url: imagen_url, alt: descripcion, orden: 1, principal: true }] : [];
}

// vendedor: { id_usuario, rol } — sale del token, nunca del body (ver requireAuth).
// atributos: [{ nombre, valor }] — valores concretos para los atributos que la
// subcategoría define (p. ej. Talla: "M").
//
// Escribe primero en MySQL (producto + inventario, igual que antes) y recién
// después en Mongo. Si el paso de Mongo falla, se intenta deshacer la fila de
// MySQL ya creada — no es una transacción distribuida real (eso es trabajo de
// Entrega 3), es una compensación de mejor esfuerzo. Ver ADR-002 §5.
async function crear(vendedor, { descripcion, imagen_url, estado, subcategoriaId, precio, cantidad, atributos }) {
  if (!descripcion) throw new Error('La descripción es obligatoria');
  if (!subcategoriaId) throw new Error('subcategoriaId es obligatorio');
  if (typeof precio !== 'number' || precio <= 0) throw new Error('El precio debe ser un número positivo');
  if (!Number.isInteger(cantidad) || cantidad < 0) throw new Error('La cantidad debe ser un entero mayor o igual a 0');

  await conectar();
  const subcategoria = await Subcategoria.findById(subcategoriaId);
  if (!subcategoria) throw new Error('Subcategoría no encontrada');

  const productoRelacional = await prisma.producto.create({
    data: {
      id_vendedor: vendedor.id_usuario,
      descripcion,
      imagen_url: imagen_url || '',
      estado: estado || 'activo',
      inventario: { create: { precio, cantidad } },
    },
    include: { vendedor: { select: { nombres: true, apellidos: true } } },
  });

  try {
    const doc = await Producto.create({
      producto_id: productoRelacional.id,
      descripcion,
      estado: estado || 'activo',
      subcategoria_id: subcategoria._id,
      vendedor_id: vendedor.id_usuario,
      vendedor_nombre: `${productoRelacional.vendedor.nombres} ${productoRelacional.vendedor.apellidos}`,
      atributos: atributos || [],
      imagenes: construirImagenes(imagen_url, descripcion),
      version: 1,
    });

    await ProductoEvento.create({
      producto_id: productoRelacional.id,
      version: 1,
      tipo: 'creacion',
      fecha: doc.actualizado_en,
      usuario_id: vendedor.id_usuario,
      campos_modificados: [],
      snapshot: {
        descripcion: doc.descripcion,
        estado: doc.estado,
        atributos: doc.atributos,
        imagenes: doc.imagenes,
        inventario: { precio, cantidad },
      },
    });

    return obtener(productoRelacional.id);
  } catch (err) {
    await prisma.inventario.deleteMany({ where: { id_producto: productoRelacional.id } });
    await prisma.producto.delete({ where: { id: productoRelacional.id } });
    throw err;
  }
}

// Un vendedor solo puede tocar su propio producto; un administrador puede tocar
// cualquiera. Se verifica contra MySQL (no Mongo) a propósito: id_vendedor se
// mantiene también ahí para que esto no dependa de una consulta cruzada — ver
// ADR-002 §3.2.
async function verificarPermiso(vendedor, productoId) {
  const producto = await prisma.producto.findUnique({ where: { id: productoId } });
  if (!producto) {
    const err = new Error('Producto no encontrado');
    err.status = 404;
    throw err;
  }
  if (producto.id_vendedor !== vendedor.id_usuario && vendedor.rol !== 'administrador') {
    const err = new Error('No podés modificar un producto que no te pertenece');
    err.status = 403;
    throw err;
  }
  return producto;
}

// Edición: cualquier campo que cambie (descriptivo O precio/cantidad) genera
// un evento — el historial reconstruye el producto completo, y precio/stock
// son parte de "el producto" tanto como la descripción (ver conversación de
// diseño, IA/ESTADO-PROYECTO.md). A propósito NO cubre los descuentos de
// inventario del checkout (ver checkoutService.js): esto es para ediciones
// deliberadas de vendedor/administrador, no para cada venta — si cada compra
// generara un evento acá, "historial de cambios" dejaría de ser un registro
// de catálogo y pasaría a ser un libro de ventas. Todo opcional, se actualiza
// solo lo que venga en el body.
async function actualizar(vendedor, productoId, { descripcion, imagen_url, estado, precio, cantidad, atributos }) {
  await verificarPermiso(vendedor, productoId);
  await conectar();

  const camposModificados = [];
  let inventarioActual = null;

  if (precio !== undefined || cantidad !== undefined) {
    const datosInventario = {};
    if (precio !== undefined) {
      if (typeof precio !== 'number' || precio <= 0) throw new Error('El precio debe ser un número positivo');
      datosInventario.precio = precio;
      camposModificados.push('precio');
    }
    if (cantidad !== undefined) {
      if (!Number.isInteger(cantidad) || cantidad < 0) throw new Error('La cantidad debe ser un entero mayor o igual a 0');
      datosInventario.cantidad = cantidad;
      camposModificados.push('cantidad');
    }
    inventarioActual = await prisma.inventario.update({ where: { id_producto: productoId }, data: datosInventario });
  }

  const cambiaDescriptivo = descripcion !== undefined || imagen_url !== undefined || estado !== undefined || atributos !== undefined;
  if (cambiaDescriptivo || camposModificados.length > 0) {
    const doc = await Producto.findOne({ producto_id: productoId });
    if (!doc) throw new Error('Producto no encontrado en el catálogo documental');

    if (descripcion !== undefined) {
      if (!descripcion) throw new Error('La descripción no puede estar vacía');
      doc.descripcion = descripcion;
      camposModificados.push('descripcion');
    }
    if (imagen_url !== undefined) {
      doc.imagenes = construirImagenes(imagen_url, doc.descripcion);
      camposModificados.push('imagenes');
    }
    if (estado !== undefined) {
      doc.estado = estado;
      camposModificados.push('estado');
    }
    if (atributos !== undefined) {
      // Reemplazo completo, no merge: lo que llega acá ya es el conjunto
      // completo de atributos vigentes según el formulario (ver
      // SellerProductFormPage.jsx), no un delta. Necesario para poder quitar
      // un atributo o cambiarlo por otro distinto en un producto puntual —
      // con un merge (update-or-push) nunca se podía borrar nada, solo agregar
      // o pisar un valor existente.
      for (const { nombre, valor } of atributos) {
        if (!nombre || !valor) throw new Error('Cada atributo necesita nombre y valor');
      }
      const nombres = atributos.map((a) => a.nombre);
      if (new Set(nombres).size !== nombres.length) {
        throw new Error('No puede haber dos atributos con el mismo nombre');
      }
      doc.atributos = atributos.map(({ nombre, valor }) => ({ nombre, valor }));
      camposModificados.push('atributos');
    }

    doc.version += 1;
    await doc.save();

    // Si esta llamada no tocó precio/cantidad, el snapshot igual necesita el
    // valor VIGENTE (no queda "vacío") para seguir siendo un snapshot
    // completo, no un delta — mismo principio que ya regía para lo descriptivo.
    if (!inventarioActual) {
      inventarioActual = await prisma.inventario.findUnique({ where: { id_producto: productoId } });
    }

    await ProductoEvento.create({
      producto_id: productoId,
      version: doc.version,
      tipo: 'edicion',
      fecha: doc.actualizado_en,
      usuario_id: vendedor.id_usuario,
      campos_modificados: camposModificados,
      snapshot: {
        descripcion: doc.descripcion,
        estado: doc.estado,
        atributos: doc.atributos,
        imagenes: doc.imagenes,
        inventario: { precio: Number(inventarioActual.precio), cantidad: inventarioActual.cantidad },
      },
    });

    // El MySQL producto.descripcion/imagen_url/estado ya no son la fuente de
    // verdad (Mongo lo es), pero se mantienen en sync para no dejarlos
    // silenciosamente desactualizados mientras no se hace la limpieza de
    // columnas pendiente (ver ADR-002 §7 / ESTADO-PROYECTO.md).
    await prisma.producto.update({
      where: { id: productoId },
      data: { descripcion: doc.descripcion, imagen_url: doc.imagenes[0]?.url || '', estado: doc.estado },
    });
  }

  return obtener(productoId);
}

async function historialEnFecha(productoId, fecha) {
  const evento = await ProductoEvento.findOne({ producto_id: productoId, fecha: { $lte: fecha } }).sort({ fecha: -1 });
  if (!evento) throw new Error('El producto no existía en esa fecha');
  return evento.snapshot;
}

async function historialCompleto(productoId) {
  return ProductoEvento.find({ producto_id: productoId }).sort({ fecha: -1 }).lean();
}

// Consulta de agregación (requerimiento técnico de Entrega 1, ver PRD §5 y
// ADR-003 §3.4): qué productos acumulan más ediciones (opcionalmente desde una
// fecha) — mapea al patrón "actividad de catálogo" que usaría un panel de
// vendedor/administrador para priorizar revisión. Corre sobre producto_eventos,
// la misma colección que ya tiene el índice compuesto {producto_id, fecha}
// (ver models/mongo/ProductoEvento.js), que es justamente lo que hace rápido
// el $match por fecha de acá.
async function estadisticasEdiciones({ desde } = {}) {
  await conectar();
  const pipeline = [];
  if (desde) pipeline.push({ $match: { fecha: { $gte: desde } } });
  pipeline.push(
    {
      $group: {
        _id: '$producto_id',
        total_eventos: { $sum: 1 },
        ultima_edicion: { $max: '$fecha' },
        version_actual: { $max: '$version' },
      },
    },
    { $sort: { total_eventos: -1, ultima_edicion: -1 } },
    {
      $project: {
        _id: 0,
        producto_id: '$_id',
        total_eventos: 1,
        ultima_edicion: 1,
        version_actual: 1,
      },
    }
  );
  return ProductoEvento.aggregate(pipeline);
}

module.exports = { listar, obtener, crear, actualizar, historialEnFecha, historialCompleto, estadisticasEdiciones };
