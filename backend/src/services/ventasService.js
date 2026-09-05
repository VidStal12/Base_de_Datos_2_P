const { validarFiltros, listarDias, desplazarDia, inicioDia, construirReporte } = require('../utils/ventas');

const COLUMNAS = 'detalle_id, compra_id, producto_id, fecha_venta, cantidad, importe';
const MAX_FILAS = 100000;

// Toda lectura fija la partición, sin ALLOW FILTERING ni escaneo global. La
// segunda tabla permite consultar un producto por meses, sin leer los demás.
async function leerVentas(cliente, filtros) {
  const { types } = require('cassandra-driver');
  const dias = listarDias(filtros.anteriorDesde, filtros.hasta);
  const particiones = filtros.productoId === null ? dias : [...new Set(dias.map((dia) => `${dia.slice(0, 7)}-01`))];
  const filas = [];
  let siguiente = 0;
  let fallo;
  async function leerParticiones() {
    while (!fallo && siguiente < particiones.length) {
      const particion = particiones[siguiente++];
      const porProducto = filtros.productoId !== null;
      const consulta = porProducto
        ? `SELECT ${COLUMNAS} FROM ventas_por_producto_mes WHERE producto_id = ? AND mes = ? AND fecha_venta >= ? AND fecha_venta < ?`
        : `SELECT ${COLUMNAS} FROM ventas_por_dia WHERE dia = ?`;
      const parametros = porProducto
        ? [filtros.productoId, types.LocalDate.fromString(particion), inicioDia(filtros.anteriorDesde), inicioDia(desplazarDia(filtros.hasta, 1))]
        : [types.LocalDate.fromString(particion)];
      let pageState;
      do {
        const resultado = await cliente.execute(consulta, parametros, { prepare: true, fetchSize: 1000, pageState, isIdempotent: true });
        filas.push(...resultado.rows);
        if (filas.length > MAX_FILAS) {
          throw Object.assign(new Error('El rango contiene demasiadas ventas. Reduce las fechas o selecciona un producto.'), { status: 422 });
        }
        // execute devuelve una página: seguir pageState evita reportar solo
        // las primeras 1000 ventas como si fueran el total del período.
        pageState = resultado.pageState;
      } while (pageState && !fallo);
    }
  }
  // Pocas consultas paralelas; esperamos todas incluso ante un fallo para no
  // abandonar peticiones todavía activas en el driver.
  await Promise.all(Array.from({ length: Math.min(4, particiones.length) }, async () => {
    try { await leerParticiones(); } catch (err) { fallo ||= err; }
  }));
  if (fallo) throw fallo;
  return filas;
}

async function resolverProductos() {
  const { conectar } = require('../config/mongo');
  const Producto = require('../models/mongo/Producto');
  await conectar();
  const productos = await Producto.find().select('producto_id descripcion').maxTimeMS(3000).lean();
  // Incluye inactivos: desactivar un producto no borra sus ventas pasadas.
  return productos.map((p) => ({ id: p.producto_id, descripcion: p.descripcion }));
}

// Inyectar dependencias permite probar fallos sin escribir en las bases reales.
function crearVentasService(deps) {
  return async function consultarVentas(query, ahora = new Date()) {
    const filtros = validarFiltros(query, ahora);
    const cliente = await deps.obtenerCliente();
    const filas = await leerVentas(cliente, filtros);
    const advertencias = [];
    let productos = [];
    try { productos = await deps.resolverProductos(); } catch {
      advertencias.push('No se pudieron cargar los nombres del catálogo. Se muestran los identificadores de producto.');
    }
    let sincronizacion = { pendientes: null, ultimaSincronizacion: null, consultadoEn: ahora.toISOString() };
    try {
      const [pendientes, ultima] = await Promise.all([
        deps.prisma.venta_outbox.count({ where: { procesado_en: null } }),
        deps.prisma.venta_outbox.aggregate({ _max: { procesado_en: true } }),
      ]);
      sincronizacion = { ...sincronizacion, pendientes, ultimaSincronizacion: ultima._max.procesado_en?.toISOString() ?? null };
      if (pendientes > 0) advertencias.push(`Hay ${pendientes} líneas de venta pendientes de sincronización.`);
      if (!sincronizacion.ultimaSincronizacion) advertencias.push('Todavía no hay una sincronización registrada. El historial puede estar pendiente de cargar.');
    } catch {
      advertencias.push('No se pudo comprobar el estado de sincronización; los datos podrían estar desactualizados.');
    }
    if (filtros.hasta === filtros.hoy) advertencias.push('El período incluye hoy, que aún está en curso; su comparación es provisional.');
    return { ...construirReporte(filas, filtros, productos), sincronizacion, advertencias };
  };
}

async function consultarVentas(query) {
  return crearVentasService({ obtenerCliente: require('../config/cassandra').obtenerCliente,
    prisma: require('../config/prisma'), resolverProductos })(query);
}

module.exports = { consultarVentas, crearVentasService, leerVentas };
