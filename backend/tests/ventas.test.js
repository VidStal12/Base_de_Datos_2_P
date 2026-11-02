const test = require('node:test');
const assert = require('node:assert/strict');
const { validarFiltros, construirReporte, fechaGuatemala, aCentavos } = require('../src/utils/ventas');
const { leerVentas, crearVentasService } = require('../src/services/ventasService');

const ahora = new Date('2026-09-05T03:00:00Z'); // En Guatemala todavía es 4/9.
const base = { desde: '2026-08-28', hasta: '2026-09-03', minUnidades: '5' };
function venta(id, producto, fecha, cantidad, importe = '10.00', compra = id) {
  return { detalle_id: id, producto_id: producto, fecha_venta: new Date(fecha), cantidad, importe, compra_id: compra };
}

test('fechas locales, default completo, comparación igual y validación estricta', () => {
  const f = validarFiltros({}, ahora);
  assert.equal(fechaGuatemala(ahora), '2026-09-04');
  assert.deepEqual([f.desde, f.hasta, f.anteriorDesde, f.anteriorHasta], ['2026-08-28', '2026-09-03', '2026-08-21', '2026-08-27']);
  const invalidos = [
    { desde: '2026-02-30' }, { hasta: '2026-09-05' }, { desde: '2026-01-01' },
    { desde: '2026-09-04' }, { productoId: '1 OR 1=1' }, { productoId: ['1', '2'] },
    { minUnidades: '0' }, { minUnidades: '1000001' }, { intervalo: 'hora' },
    { desde: '1970-01-01', hasta: '1970-01-02' }, { desde: '2026-8-28' },
  ];
  for (const cambio of invalidos) assert.throws(() => validarFiltros({ ...base, ...cambio }, ahora), { status: 400 });
});

test('ingresos netos exactos, pedido DISTINCT, días vacíos y bordes de medianoche', () => {
  const filas = [
    venta(1, 1, '2026-08-28T05:59:59.999Z', 4), // 27 local: anterior
    venta(2, 1, '2026-08-28T06:00:00Z', 6, '0.10', 7),
    venta(3, 2, '2026-08-28T08:00:00Z', 10, '0.20', 7),
    venta(4, 2, '2026-09-04T05:59:59.999Z', 1, '9.99', 8),
    venta(5, 2, '2026-09-04T06:00:00Z', 100, '100.00'), // Fuera: 4 local
  ];
  const reporte = construirReporte(filas, validarFiltros(base, ahora));
  assert.deepEqual(reporte.resumen, { unidades: 17, ingresos: 10.29, pedidos: 2, unidadesAnteriores: 4, crecimientoPorcentaje: 325 });
  assert.equal(reporte.serie.length, 7);
  assert.deepEqual(reporte.serie[0], { periodo: '2026-08-28', unidades: 16, ingresos: 0.3, pedidos: 1 });
  assert.equal(reporte.serie[1].unidades, 0);
  assert.equal(aCentavos('99999999.99'), 9999999999);
  assert.throws(() => aCentavos('10.001'));
});

test('ascenso exige mínimo, excluye estables/bajas y no divide entre cero', () => {
  const filas = [
    venta(1, 1, '2026-08-22T12:00:00Z', 40), venta(2, 1, '2026-08-29T12:00:00Z', 60),
    venta(3, 2, '2026-08-29T12:00:00Z', 8),
    venta(4, 3, '2026-08-22T12:00:00Z', 1), venta(5, 3, '2026-08-29T12:00:00Z', 2),
    venta(6, 4, '2026-08-22T12:00:00Z', 10), venta(7, 4, '2026-08-29T12:00:00Z', 10),
    venta(8, 5, '2026-08-22T12:00:00Z', 10), venta(9, 5, '2026-08-29T12:00:00Z', 5),
  ];
  const reporte = construirReporte(filas, validarFiltros(base, ahora), [{ id: 1, nombre: 'Café' }]);
  assert.deepEqual(reporte.tendencias.map((p) => p.productoId), [1, 2]);
  assert.equal(reporte.tendencias[0].crecimientoPorcentaje, 50);
  assert.equal(reporte.tendencias[1].crecimientoPorcentaje, null);
  assert.equal(reporte.tendencias[1].sinBaseAnterior, true);
  const filtrado = construirReporte(filas, validarFiltros({ ...base, productoId: '1' }, ahora));
  assert.equal(filtrado.resumen.unidades, 60);
  assert.equal(filtrado.resumen.unidadesAnteriores, 40);
});

test('semana y mes agrupan sin sumar filas fuera del rango; vacío tiene comparación null', () => {
  const filas = [venta(1, 1, '2026-08-31T12:00:00Z', 3), venta(2, 1, '2026-09-01T12:00:00Z', 2)];
  const semanal = construirReporte(filas, validarFiltros({ ...base, intervalo: 'semana' }, ahora));
  assert.deepEqual(semanal.serie.map((p) => [p.periodo, p.unidades]), [['2026-08-24', 0], ['2026-08-31', 5]]);
  const mensual = construirReporte(filas, validarFiltros({ ...base, intervalo: 'mes' }, ahora));
  assert.deepEqual(mensual.serie.map((p) => p.unidades), [3, 2]);
  const vacio = construirReporte([], validarFiltros(base, ahora));
  assert.equal(vacio.resumen.crecimientoPorcentaje, null);
  assert.deepEqual(vacio.tendencias, []);
});

test('Cassandra recorre todas las páginas y particiones necesarias con parámetros', async () => {
  const llamadas = [];
  const cliente = { execute: async (sql, params, options) => {
    llamadas.push({ sql, params, options });
    return { rows: [{ pagina: options.pageState ? 2 : 1 }], pageState: options.pageState ? null : 'pagina2' };
  } };
  const filtros = validarFiltros({ desde: '2026-09-03', hasta: '2026-09-03' }, ahora);
  assert.equal((await leerVentas(cliente, filtros)).length, 4);
  assert.equal(llamadas.length, 4);
  assert.ok(llamadas.every((c) => c.sql.includes('WHERE dia = ?') && c.options.prepare));
  assert.deepEqual([...new Set(llamadas.map((c) => c.params[0].toString()))].sort(), ['2026-09-02', '2026-09-03']);
  llamadas.length = 0;
  await leerVentas(cliente, validarFiltros({ ...base, productoId: '9' }, ahora));
  assert.ok(llamadas.every((c) => c.sql.includes('ventas_por_producto_mes') && c.params[0] === 9));
  assert.deepEqual([...new Set(llamadas.map((c) => c.params[1].toString()))].sort(), ['2026-08-01', '2026-09-01']);
  assert.equal(llamadas[0].params[2].toISOString(), '2026-08-21T06:00:00.000Z');
  assert.equal(llamadas[0].params[3].toISOString(), '2026-09-04T06:00:00.000Z');
});

test('un fallo de Cassandra rechaza el informe, no inventa ceros ni consulta finanzas MySQL', async () => {
  const consultar = crearVentasService({ obtenerCliente: async () => { throw new Error('caída'); } });
  await assert.rejects(() => consultar(base, ahora), /caída/);
  const cliente = { execute: async () => { throw new Error('lectura fallida'); } };
  await assert.rejects(() => leerVentas(cliente, validarFiltros(base, ahora)), /lectura fallida/);
});

test('la degradación de nombres/estado es explícita y hoy se marca provisional', async () => {
  const consultar = crearVentasService({
    obtenerCliente: async () => ({ execute: async () => ({ rows: [] }) }),
    resolverProductos: async () => { throw new Error('Mongo caído'); },
    prisma: { venta_outbox: { count: async () => 2, aggregate: async () => ({ _max: { procesado_en: null } }) } },
  });
  const resultado = await consultar({ desde: '2026-09-04', hasta: '2026-09-04' }, ahora);
  assert.equal(resultado.sincronizacion.pendientes, 2);
  assert.equal(resultado.advertencias.length, 4);
  assert.ok(resultado.advertencias.some((s) => s.includes('provisional')));
});

test('el límite de filas rechaza el informe completo y nunca entrega un total truncado', async () => {
  const cliente = { execute: async () => ({ rows: Array(1000).fill({}), pageState: 'otra' }) };
  await assert.rejects(() => leerVentas(cliente, validarFiltros({ ...base, productoId: '1' }, ahora)), { status: 422 });
});
