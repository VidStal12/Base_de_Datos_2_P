// Días de Guatemala (UTC-6, sin cambio estacional), independientes de la zona
// horaria del equipo que ejecute Node. Los instantes se almacenan en UTC.
const DIA_MS = 86400000;
const ZONA_HORARIA = 'America/Guatemala';

function fechaGuatemala(fecha = new Date()) {
  return new Date(new Date(fecha).getTime() - 6 * 3600000).toISOString().slice(0, 10);
}

function desplazarDia(dia, cantidad) {
  return new Date(Date.parse(`${dia}T00:00:00Z`) + cantidad * DIA_MS).toISOString().slice(0, 10);
}

function inicioDia(dia) {
  return new Date(`${dia}T00:00:00-06:00`);
}

function errorFiltro(mensaje) {
  return Object.assign(new Error(mensaje), { status: 400 });
}

function validarDia(valor, nombre) {
  if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) {
    throw errorFiltro(`${nombre} debe tener formato AAAA-MM-DD`);
  }
  const fecha = new Date(`${valor}T00:00:00Z`);
  if (!Number.isFinite(fecha.getTime()) || fecha.toISOString().slice(0, 10) !== valor || valor < '1970-01-01') {
    throw errorFiltro(`${nombre} no es una fecha válida a partir de 1970`);
  }
  return valor;
}

function enteroFiltro(valor, nombre, maximo) {
  if (typeof valor !== 'string' || !/^\d+$/.test(valor) || Number(valor) < 1 || Number(valor) > maximo) {
    throw errorFiltro(`${nombre} debe ser un entero entre 1 y ${maximo}`);
  }
  return Number(valor);
}

// El formulario usa fechas inclusivas; las consultas usan [inicio, fin) para
// incluir todo el último día sin duplicar ventas justo a medianoche.
function validarFiltros(query = {}, ahora = new Date()) {
  const hoy = fechaGuatemala(ahora);
  const hasta = validarDia(query.hasta ?? desplazarDia(hoy, -1), 'hasta');
  const desde = validarDia(query.desde ?? desplazarDia(hasta, -6), 'desde');
  const dias = Math.round((Date.parse(hasta) - Date.parse(desde)) / DIA_MS) + 1;
  if (dias < 1 || dias > 90) throw errorFiltro('El rango debe abarcar entre 1 y 90 días');
  if (hasta > hoy) throw errorFiltro('No se pueden consultar fechas futuras');
  const intervalo = query.intervalo ?? 'dia';
  if (!['dia', 'semana', 'mes'].includes(intervalo)) throw errorFiltro('intervalo debe ser dia, semana o mes');
  const productoId = query.productoId === undefined || query.productoId === ''
    ? null : enteroFiltro(query.productoId, 'productoId', 2147483647);
  const minUnidades = enteroFiltro(query.minUnidades ?? '5', 'minUnidades', 1000000);
  const anteriorDesde = desplazarDia(desde, -dias);
  if (anteriorDesde < '1970-01-01') throw errorFiltro('El período de comparación debe comenzar a partir de 1970');
  return { desde, hasta, intervalo, productoId, minUnidades, zonaHoraria: ZONA_HORARIA,
    anteriorDesde, anteriorHasta: desplazarDia(desde, -1), dias, hoy };
}

function listarDias(desde, hasta) {
  const dias = [];
  for (let dia = desde; dia <= hasta; dia = desplazarDia(dia, 1)) dias.push(dia);
  return dias;
}

function periodoDeDia(dia, intervalo) {
  if (intervalo === 'mes') return `${dia.slice(0, 7)}-01`;
  if (intervalo === 'semana') {
    // Semanas de lunes a domingo: los extremos solo incluyen las ventas del
    // rango elegido, aunque la etiqueta de la semana empiece antes.
    const semana = new Date(`${dia}T00:00:00Z`).getUTCDay();
    return desplazarDia(dia, -((semana + 6) % 7));
  }
  return dia;
}

// Cassandra conserva DECIMAL; sumar centavos enteros evita el error binario
// de sumar importes Number (por ejemplo 0.10 + 0.20).
function aCentavos(importe) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(importe));
  if (!match) throw new Error('Importe de venta inválido');
  const valor = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(valor)) throw new Error('Importe de venta fuera de rango');
  return valor;
}

function porcentaje(actual, anterior) {
  return anterior === 0 ? null : Math.round(((actual - anterior) / anterior) * 10000) / 100;
}

// Cálculo puro: recibe ventas de Cassandra y se prueba sin bases. La demanda
// se aproxima con unidades; pedidos se cuentan DISTINCT, no por cada línea.
function construirReporte(filas, filtros, productos = []) {
  const nombres = new Map(productos.map((p) => [p.id, p.descripcion]));
  const serie = new Map();
  for (const dia of listarDias(filtros.desde, filtros.hasta)) {
    const periodo = periodoDeDia(dia, filtros.intervalo);
    if (!serie.has(periodo)) serie.set(periodo, { periodo, unidades: 0, centavos: 0, pedidos: new Set() });
  }
  let unidades = 0;
  let centavos = 0;
  let unidadesAnteriores = 0;
  const pedidos = new Set();
  const porProducto = new Map();
  for (const fila of filas) {
    if (filtros.productoId !== null && fila.producto_id !== filtros.productoId) continue;
    const dia = fechaGuatemala(fila.fecha_venta);
    if (dia < filtros.anteriorDesde || dia > filtros.hasta) continue;
    if (!Number.isSafeInteger(fila.cantidad) || fila.cantidad < 1) throw new Error('Cantidad de venta inválida');
    if (!nombres.has(fila.producto_id)) nombres.set(fila.producto_id, `Producto #${fila.producto_id}`);
    if (!porProducto.has(fila.producto_id)) {
      porProducto.set(fila.producto_id, { productoId: fila.producto_id, unidadesActuales: 0, unidadesAnteriores: 0 });
    }
    const producto = porProducto.get(fila.producto_id);
    if (dia < filtros.desde) {
      unidadesAnteriores += fila.cantidad;
      producto.unidadesAnteriores += fila.cantidad;
    } else {
      const importe = aCentavos(fila.importe);
      unidades += fila.cantidad;
      centavos += importe;
      pedidos.add(fila.compra_id);
      producto.unidadesActuales += fila.cantidad;
      const punto = serie.get(periodoDeDia(dia, filtros.intervalo));
      punto.unidades += fila.cantidad;
      punto.centavos += importe;
      punto.pedidos.add(fila.compra_id);
    }
  }
  if (![centavos, unidades, unidadesAnteriores].every(Number.isSafeInteger)) throw new Error('Totales fuera de rango');
  const tendencias = [...porProducto.values()]
    .filter((p) => p.unidadesActuales >= filtros.minUnidades && p.unidadesActuales > p.unidadesAnteriores)
    .map((p) => ({ ...p, descripcion: nombres.get(p.productoId),
      aumentoUnidades: p.unidadesActuales - p.unidadesAnteriores,
      crecimientoPorcentaje: porcentaje(p.unidadesActuales, p.unidadesAnteriores), sinBaseAnterior: p.unidadesAnteriores === 0 }))
    // Priorizar aumento absoluto evita que pasar de 1 a 2 opaque +50 unidades.
    .sort((a, b) => b.aumentoUnidades - a.aumentoUnidades || b.unidadesActuales - a.unidadesActuales || a.productoId - b.productoId);
  return {
    filtros: Object.fromEntries(['desde', 'hasta', 'intervalo', 'productoId', 'minUnidades', 'zonaHoraria'].map((k) => [k, filtros[k]])),
    comparacion: { desde: filtros.anteriorDesde, hasta: filtros.anteriorHasta },
    resumen: { unidades, ingresos: centavos / 100, pedidos: pedidos.size, unidadesAnteriores,
      crecimientoPorcentaje: porcentaje(unidades, unidadesAnteriores) },
    serie: [...serie.values()].map((p) => ({ periodo: p.periodo, unidades: p.unidades, ingresos: p.centavos / 100, pedidos: p.pedidos.size })),
    productos: [...nombres].map(([id, descripcion]) => ({ id, descripcion })).sort((a, b) => a.descripcion.localeCompare(b.descripcion, 'es')),
    tendencias,
  };
}

module.exports = { fechaGuatemala, desplazarDia, inicioDia, validarFiltros, listarDias, periodoDeDia, aCentavos, construirReporte };
