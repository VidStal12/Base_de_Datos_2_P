const { textosParaGrafo } = require('../utils/textosProducto');
const prisma = require('../config/prisma');
const { esEnteroPositivo } = require('../utils/validation');
const { conectar } = require('../config/mongo');
const Producto = require('../models/mongo/Producto');
const cartService = require('./cartService');
const productoService = require('./productoService');
const compromisoService = require('./compromisoService');
const { encolarCompra } = require('./ventasOutboxService');
const fraudeSyncService = require('./fraudeSyncService');
const intentos = require('./checkoutIntentoService');
const reconciliacionMongo = require('./reconciliacionMongoService');
const demo = require('./checkoutDemoService');

// El tope por pedido de una cuenta con límites suaves: 403 con `codigo: LIMITE_MONTO`.
function verificarTopeDeMonto(total, montoMaximo) {
  if (!montoMaximo || total <= montoMaximo) return;
  const err = new Error(`Mientras tu cuenta está en revisión, cada pedido puede ser de hasta Q${Number(montoMaximo).toFixed(2)}. Este pedido suma Q${Number(total).toFixed(2)}.`);
  err.status = 403;
  err.codigo = 'LIMITE_MONTO';
  throw err;
}

// Checkout atómico: pedido + líneas + pago + descuento de inventario.
// Toda la función corre dentro de una única transacción de Prisma — si cualquier
// paso falla (p. ej. falta de stock), TODO se revierte, incluyendo los descuentos
// de inventario ya aplicados en iteraciones previas del loop.
//
// aceptaNoReventa: lo manda el aviso del frontend a las cuentas que pueden
// vender (ver compromisoService.js); se exige acá y queda registrado en el
// pedido.
//
// montoMaximo: el tope por pedido de una cuenta con límites suaves (ver
// restriccionService.js y middleware/controlPedidos.js, que lo decide por la ruta). Se
// hace cumplir ACÁ, dentro de la transacción, porque solo acá se conoce el total: si lo
// supera, se rechaza y TODO se revierte. Sin él (undefined/null) no hay tope.
async function checkout({ usuarioId, direccionId, metodoPagoId, items, aceptaNoReventa, montoMaximo, intentoId }) {
  const datos = { direccionId, metodoPagoId, items, aceptaNoReventa };
  if (intentoId) {
    const anterior = await intentos.recuperar(usuarioId, intentoId, datos);
    if (anterior) return anterior;
  }
  if (!items || items.length === 0) {
    throw Object.assign(new Error('El carrito no puede estar vacío'), { status: 400 });
  }
  if (!esEnteroPositivo(direccionId) || !esEnteroPositivo(metodoPagoId)) {
    throw Object.assign(new Error('direccionId y metodoPagoId deben ser enteros positivos'), { status: 400 });
  }
  // Sin esto, una cantidad negativa pasaba la validación de stock (cualquier
  // stock es "mayor" que un negativo) y luego el decrement de inventario con un
  // número negativo terminaba SUMANDO stock en vez de restarlo.
  for (const { productoId, cantidad } of items) {
    if (!esEnteroPositivo(productoId) || !esEnteroPositivo(cantidad)) {
      throw Object.assign(new Error('Cada item necesita productoId y cantidad como enteros positivos'), { status: 400 });
    }
  }

  // Antes que cualquier otra validación de disponibilidad: si el motivo del
  // rechazo es "es tuyo", el mensaje tiene que decir eso y no "no disponible".
  await productoService.verificarNoEsPropio(usuarioId, items.map((item) => item.productoId));
  // Una cuenta que puede vender tiene que haber aceptado el compromiso de no
  // reventa en el aviso de ESTA compra — se rechaza antes de tocar nada.
  const compromiso = await compromisoService.exigirCompromiso(usuarioId, aceptaNoReventa);

  // Los productos de un vendedor suspendido no se pueden comprar mientras dure la
  // suspensión (ver productoService.verificarVendedoresActivos).
  await productoService.verificarVendedoresActivos(items.map((item) => item.productoId));

  // ¿Están publicados? La fuente es Mongo; con Mongo apagado se le pregunta al índice de
  // búsqueda (productoService.estadoPublicacion). Si ninguno responde, el pedido se rechaza
  // ANTES de abrir la transacción: sin saber si se puede vender, no se vende.
  const publicados = await productoService.estadoPublicacion(items.map((item) => item.productoId));
  const activos = new Set([...publicados].filter(([, producto]) => producto.estado === 'activo').map(([id]) => id));
  if (items.some((item) => !activos.has(item.productoId))) {
    const err = new Error('Hay productos no disponibles. Revisá el carrito.');
    err.status = 409;
    throw err;
  }

  await demo.pausar('before_transaction', { usuarioId, intentoId });
  const ejecutar = intentoId
    ? (operacion) => intentos.transaccion({ usuarioId, intentoId, datos }, operacion)
    : (operacion) => prisma.$transaction(operacion);
  return ejecutar(async (tx) => {
    await cartService.bloquearUsuario(tx, usuarioId);
    // La dirección y el método de pago deben pertenecer a quien está pagando —
    // si no, cualquier usuario autenticado podría pasar el ID de otro y usar
    // su dirección o su tarjeta guardada.
    const [direccion, metodoPago] = await Promise.all([
      tx.direcciones.findUnique({ where: { id: direccionId } }),
      tx.metodo_pago.findUnique({ where: { id: metodoPagoId } }),
    ]);

    if (!direccion || direccion.id_usuario !== usuarioId) {
      throw Object.assign(new Error('La dirección indicada no pertenece al usuario'), { status: 400 });
    }
    if (!metodoPago || metodoPago.id_usuario !== usuarioId) {
      throw Object.assign(new Error('El método de pago indicado no pertenece al usuario'), { status: 400 });
    }

    let total = 0;
    const detalles = [];

    for (const { productoId, cantidad, precioEsperado } of items) {
      const inventario = await tx.inventario.findUnique({
        where: { id_producto: productoId },
      });

      if (!inventario || inventario.cantidad < cantidad) {
        const err = new Error(`Stock insuficiente para el producto ${productoId}`);
        err.status = 409;
        throw err;
      }

      if (precioEsperado !== undefined && Number(precioEsperado) !== Number(inventario.precio)) {
        const err = new Error(`El precio del producto ${productoId} cambió. Revisá el carrito antes de confirmar.`);
        err.status = 409;
        throw err;
      }

      const precioFinal = Number(inventario.precio) * cantidad;
      total += precioFinal;

      detalles.push({
        id_producto: productoId,
        cantidad,
        precio_final: precioFinal,
        descuento: 0,
        estado: 'pendiente',
      });

      const descontado = await tx.inventario.updateMany({
        where: { id_producto: productoId, cantidad: { gte: cantidad }, precio: inventario.precio },
        data: { cantidad: { decrement: cantidad } },
      });
      if (descontado.count !== 1) {
        const err = new Error(`Precio o stock cambió para el producto ${productoId}; revisá el carrito`);
        err.status = 409;
        throw err;
      }
    }

    verificarTopeDeMonto(total, montoMaximo);

    const compra = await tx.compra.create({
      data: {
        id_usuario: usuarioId,
        id_direccion: direccionId,
        total,
        no_reventa_aceptada_en: compromiso.aceptadoEn,
        compra_detalles: { create: detalles },
      },
      include: { compra_detalles: true },
    });

    const pago = await tx.pago.create({
      data: {
        id_compra: compra.id,
        id_metodo_pago: metodoPagoId,
        monto: total,
        estado: 'aprobado',
        referencia_transaccion: `TX-${compra.id}-${Date.now()}`,
      },
    });

    // El pendiente de analítica se confirma con el pago. Una caída posterior de
    // Cassandra no pierde esta venta ni requiere volver a ejecutar el checkout.
    await encolarCompra(tx, compra);

    // Durable y atómico con el pedido: una caída de Redis no recupera productos comprados.
    await tx.carrito.deleteMany({ where: { id_usuario: usuarioId } });
    await cartService.avanzarVersion(tx, usuarioId);

    return { compra, pago };
  }).then(async (resultado) => {
    if (intentos.reutilizado(resultado)) return resultado;
    await demo.pausar('after_commit_before_redis', { usuarioId, intentoId, compraId: resultado.compra.id });
    // Invalidar inmediatamente después del commit, antes de los reenvíos lentos.
    const cacheActualizada = await cartService.invalidarCache(usuarioId);
    if (cacheActualizada === false) {
      resultado.advertencias = [{
        codigo: 'CARRITO_CACHE_PENDIENTE',
        mensaje: 'Tu pedido quedó confirmado. Al confirmar la compra, no pudimos actualizar el carrito. No necesitás repetir la compra. Si todavía ves los productos comprados, entrá al checkout para actualizar el carrito.',
      }];
      await intentos.guardarAdvertencias(usuarioId, intentoId, resultado);
    }
    // Fuera de la transacción a propósito: la compra ya está confirmada y es
    // irreversible en MySQL en este punto, esto solo actualiza las cachés de
    // lectura en Mongo (total_vendido Y cantidad, ver Producto.js — MySQL
    // `inventario` ya se descontó arriba, DENTRO de la transacción; esto es
    // el reenvío de esa misma resta hacia la copia de Mongo). Mejor esfuerzo,
    // igual que el resto de las escrituras cruzadas de este proyecto (ver
    // ADR-002 §5) — si esto falla, la compra ya sucedió igual, no hay nada
    // que revertir; recalcularVentas()/recalcularInventario() lo corrigen
    // después si hace falta.
    try {
      await conectar();
      await Promise.all(
        items.map(({ productoId, cantidad }) =>
          Producto.updateOne({ producto_id: productoId }, { $inc: { total_vendido: cantidad, 'inventario.cantidad': -cantidad } })
        )
      );
    } catch (err) {
      console.error('No se pudo actualizar total_vendido/cantidad en Mongo:', err.message);
      // Con Mongo apagado la copia queda atrás: se anota para recalcularla desde MySQL en
      // cuanto responda (reconciliacionMongoService.js).
      reconciliacionMongo.encolar(items.map(({ productoId }) => productoId));
    }

    // Detección de fraude (Entrega 2, ver IA/PLAN-NEO4J-DETECCION-FRAUDE.md)
    // — mismo mejor esfuerzo que los dos de arriba, con su propio try/catch:
    // que esto falle no debe afectar el reenvío a Mongo ni el vaciado del
    // carrito, y viceversa. Sin garantía de reintento durable (a diferencia
    // del outbox de ventas) — si falla, el próximo backfillNeo4j.js lo
    // recupera; ver ENTREGA-3-CONSISTENCIA.md §3 para el porqué.
    try {
      // Primero se comprueba que Mongo responda: con Mongo apagado, Producto.findOne() esperaría
      // 2 s su cola de espera antes de fallar, y esa espera la paga la persona que acaba de pagar.
      await conectar();
      const usuarioDb = await prisma.usuarios.findUnique({ where: { id_usuario: usuarioId }, include: { rol: true } });
      for (const detalle of resultado.compra.compra_detalles) {
        const producto = await Producto.findOne({ producto_id: detalle.id_producto })
          .select('nombre descripcion subcategoria_id vendedor_id vendedor_nombre')
          .lean();
        if (!producto) continue;
        await fraudeSyncService.registrarCompra({
          detalleId: detalle.id,
          compraId: resultado.compra.id,
          usuarioId,
          usuarioNombre: `${usuarioDb.nombres} ${usuarioDb.apellidos}`,
          usuarioRol: usuarioDb.rol.tipo_rol,
          vendedorId: producto.vendedor_id,
          vendedorNombre: producto.vendedor_nombre,
          productoId: detalle.id_producto,
          ...textosParaGrafo(producto),
          subcategoriaId: producto.subcategoria_id,
          fecha: resultado.compra.fecha,
          monto: detalle.precio_final,
        });
      }
    } catch (err) {
      console.error('No se pudo reenviar la compra a Neo4j:', err.message);
    }

    return resultado;
  });
}

// Guardia 2 (autoridad final en MySQL) de la oferta flash — ver
// ofertaFlashService.js y ENTREGA-2-PLAN.md §4.2. Deliberadamente una función
// separada, NO una rama dentro de checkout() de arriba: "no reemplaza el
// checkout normal" (§4.2) significa también no arriesgar el que ya está
// verificado agregándole casos. Comparte el módulo (ambas son "compras que
// tocan MySQL en una transacción") pero ninguna línea de código.
//
// Único ítem, precio provisto por el llamador (precio_oferta de Mongo, no
// inventario.precio) — todo lo demás calca a checkout(): valida pertenencia
// de dirección/método de pago, exige stock REAL suficiente (Redis ya admitió
// del lado del pool de oferta, pero eso es solo la guardia 1; si el
// inventario real ya no alcanza, acá se rechaza igual, aunque Redis haya
// dicho que sí — ver §4.2, "dos guardas, no una"), y reenvía a Mongo después
// de confirmar. `descuento` en compra_detalle, que en el checkout normal
// siempre queda en 0, acá sí lleva el ahorro real.
async function checkoutOferta({ usuarioId, productoId, cantidad, precioUnitario, direccionId, metodoPagoId, aceptaNoReventa, montoMaximo, ejecutarTransaccion }) {
  if (!esEnteroPositivo(productoId) || !esEnteroPositivo(cantidad)) {
    throw Object.assign(new Error('productoId y cantidad deben ser enteros positivos'), { status: 400 });
  }
  if (!esEnteroPositivo(direccionId) || !esEnteroPositivo(metodoPagoId)) {
    throw Object.assign(new Error('direccionId y metodoPagoId deben ser enteros positivos'), { status: 400 });
  }
  if (typeof precioUnitario !== 'number' || precioUnitario <= 0) {
    throw Object.assign(new Error('precioUnitario debe ser un número positivo'), { status: 400 });
  }
  // Autoridad final de la regla "nadie compra lo suyo" para oferta flash y
  // recomendaciones (las dos pasan por acá) — ofertaFlashService/
  // tendenciaService la chequean antes también, para no gastar cupo en Redis.
  await productoService.verificarNoEsPropio(usuarioId, [productoId]);
  // Y que el vendedor no esté suspendido (autoridad final; oferta flash y
  // recomendaciones ya lo filtran antes).
  await productoService.verificarVendedoresActivos([productoId]);
  // Mismo compromiso de no reventa que checkout(), también acá como autoridad
  // final: ofertaFlashService/tendenciaService lo exigen antes de Redis.
  const compromiso = await compromisoService.exigirCompromiso(usuarioId, aceptaNoReventa);

  const ejecutar = ejecutarTransaccion || ((operacion) => prisma.$transaction(operacion));
  return ejecutar(async (tx) => {
    const [direccion, metodoPago] = await Promise.all([
      tx.direcciones.findUnique({ where: { id: direccionId } }),
      tx.metodo_pago.findUnique({ where: { id: metodoPagoId } }),
    ]);
    if (!direccion || direccion.id_usuario !== usuarioId) {
      throw Object.assign(new Error('La dirección indicada no pertenece al usuario'), { status: 400 });
    }
    if (!metodoPago || metodoPago.id_usuario !== usuarioId) {
      throw Object.assign(new Error('El método de pago indicado no pertenece al usuario'), { status: 400 });
    }

    const inventario = await tx.inventario.findUnique({ where: { id_producto: productoId } });
    if (!inventario || inventario.cantidad < cantidad) {
      // La guardia 1 (Redis) ya admitió esta compra dentro del pool de
      // oferta — esto es la guardia 2 rechazándola igual porque el
      // inventario REAL ya no alcanza. Es exactamente el caso que separa
      // "admisión rápida" de "autoridad final" (§4.2); el llamador
      // (ofertaFlashService.comprar) revierte el contador de Redis cuando
      // esto pasa, para no dejar quemada una unidad del pool que nadie
      // efectivamente se llevó.
      throw Object.assign(new Error(`Stock insuficiente para el producto ${productoId}`), { status: 409 });
    }

    const descontado = await tx.inventario.updateMany({
      where: { id_producto: productoId, cantidad: { gte: cantidad } },
      data: { cantidad: { decrement: cantidad } },
    });
    if (descontado.count !== 1) throw Object.assign(new Error(`Stock insuficiente para el producto ${productoId}`), { status: 409 });

    const precioFinal = precioUnitario * cantidad;
    // Mismo tope por pedido que checkout() (ver arriba): rechaza y revierte la reserva.
    verificarTopeDeMonto(precioFinal, montoMaximo);
    const descuentoUnitario = Math.max(Number(inventario.precio) - precioUnitario, 0);

    const compra = await tx.compra.create({
      data: {
        id_usuario: usuarioId,
        id_direccion: direccionId,
        total: precioFinal,
        no_reventa_aceptada_en: compromiso.aceptadoEn,
        compra_detalles: {
          create: [
            {
              id_producto: productoId,
              cantidad,
              precio_final: precioFinal,
              descuento: descuentoUnitario * cantidad,
              estado: 'pendiente',
            },
          ],
        },
      },
      include: { compra_detalles: true },
    });

    const pago = await tx.pago.create({
      data: {
        id_compra: compra.id,
        id_metodo_pago: metodoPagoId,
        monto: precioFinal,
        estado: 'aprobado',
        referencia_transaccion: `TX-OFERTA-${compra.id}-${Date.now()}`,
      },
    });

    // Oferta flash y compra por recomendación usan este checkout: ambas generan
    // el mismo snapshot con el importe neto que quedó guardado en MySQL.
    await encolarCompra(tx, compra);

    return { compra, pago };
  }).then(async (resultado) => {
    if (intentos.reutilizado(resultado)) return resultado;
    // Mismo reenvío de mejor esfuerzo que checkout() — ver el comentario de
    // arriba, es la misma copia de lectura en Mongo, actualizada por el mismo
    // motivo.
    try {
      await conectar();
      await Producto.updateOne(
        { producto_id: productoId },
        { $inc: { total_vendido: cantidad, 'inventario.cantidad': -cantidad } }
      );
    } catch (err) {
      console.error('No se pudo actualizar total_vendido/cantidad en Mongo (oferta flash):', err.message);
      reconciliacionMongo.encolar([productoId]);
    }

    // Detección de fraude — mismo criterio que checkout(), ver el comentario
    // de arriba. Cubre oferta flash Y recomendaciones, ambas pasan por acá.
    try {
      // Primero se comprueba que Mongo responda: con Mongo apagado, Producto.findOne() esperaría
      // 2 s su cola de espera antes de fallar, y esa espera la paga la persona que acaba de pagar.
      await conectar();
      const usuarioDb = await prisma.usuarios.findUnique({ where: { id_usuario: usuarioId }, include: { rol: true } });
      const producto = await Producto.findOne({ producto_id: productoId })
        .select('nombre descripcion subcategoria_id vendedor_id vendedor_nombre')
        .lean();
      const detalle = resultado.compra.compra_detalles[0];
      if (producto && detalle) {
        await fraudeSyncService.registrarCompra({
          detalleId: detalle.id,
          compraId: resultado.compra.id,
          usuarioId,
          usuarioNombre: `${usuarioDb.nombres} ${usuarioDb.apellidos}`,
          usuarioRol: usuarioDb.rol.tipo_rol,
          vendedorId: producto.vendedor_id,
          vendedorNombre: producto.vendedor_nombre,
          productoId,
          ...textosParaGrafo(producto),
          subcategoriaId: producto.subcategoria_id,
          fecha: resultado.compra.fecha,
          monto: detalle.precio_final,
        });
      }
    } catch (err) {
      console.error('No se pudo reenviar la compra a Neo4j (oferta flash):', err.message);
    }

    return resultado;
  });
}

module.exports = { checkout, checkoutOferta };
