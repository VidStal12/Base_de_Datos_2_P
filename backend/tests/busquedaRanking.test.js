const test = require('node:test');
const assert = require('node:assert/strict');
const { cargar } = require('./redisHelpers');
const ranking = require('../src/services/rankingBusqueda');
const facetas = require('../src/services/facetasBusqueda');

// Ranking de la búsqueda por popularidad y novedad (IA/PLAN-ELASTICSEARCH-BUSQUEDA.md §17), sin conexiones:
// la fórmula, el pedido que se le manda al motor, el mismo orden en JavaScript (el respaldo con Mongo) y el
// servicio que cuenta los clics y los vuelca al índice (con Mongo y Elasticsearch de mentira).
// Que el motor realmente ordene así lo comprueba, contra Elasticsearch real, la prueba en vivo de la sesión.
const plano = (valor) => JSON.parse(JSON.stringify(valor));
const DIA = 86400000;
const AHORA = Date.parse('2026-11-05T12:00:00Z');
const haceDias = (n) => new Date(AHORA - n * DIA).toISOString();
const producto = (id, extra = {}) => ({ id, total_vendido: 0, clics: 0, publicado_en: haceDias(400), ...extra });

// ── La fórmula ──────────────────────────────────────────────────────────────

test('function_score suma 1 + ventas + clics + novedad y MULTIPLICA el resultado por la relevancia del texto', () => {
  const consulta = { bool: { must: [{ match_all: {} }] } };
  const { function_score: fs } = ranking.conRanking(consulta);
  assert.equal(fs.query, consulta);
  assert.equal(fs.score_mode, 'sum');
  assert.equal(fs.boost_mode, 'multiply');
  assert.deepEqual(plano(fs.functions[0]), { weight: 1 }, 'la base de la suma: sin ella un producto sin ventas ni clics se iría a puntaje 0');
  const [, ventas, clics, novedad] = plano(fs.functions);
  assert.deepEqual(ventas, { field_value_factor: { field: 'total_vendido', modifier: 'log1p', factor: 1, missing: 0 }, weight: ranking.PESOS.ventas });
  assert.deepEqual(clics, { field_value_factor: { field: 'clics', modifier: 'log1p', factor: 1, missing: 0 }, weight: ranking.PESOS.clics });
  assert.deepEqual(novedad.filter, { exists: { field: 'publicado_en' } }, 'sin fecha la novedad no suma: una decay function sin valor devolvería 1');
  assert.deepEqual(novedad.gauss.publicado_en, { origin: 'now', offset: '14d', scale: '150d', decay: 0.5 });
  assert.equal(novedad.weight, ranking.PESOS.novedad);
});

test('las ventas y los clics pesan con logaritmo: del 0 al 10 se nota, del 150 al 160 casi nada', () => {
  const m = (total_vendido, clics = 0) => ranking.multiplicador(producto(1, { total_vendido, clics }), AHORA);
  assert.ok(Math.abs(m(0) - 1) < 0.01, 'sin ventas, sin clics y viejo (400 días), el multiplicador es ~1: la relevancia queda como está');
  assert.equal(ranking.multiplicador({ id: 1 }, AHORA), 1, 'sin ventas, sin clics y sin fecha, exactamente 1');
  assert.ok(m(10) - m(0) > 0.5, 'las primeras unidades suben mucho');
  assert.ok(m(160) - m(150) < 0.02, 'las últimas casi nada');
  assert.ok(m(159) > m(25) && m(25) > m(3) && m(3) > m(0));
  assert.ok(m(5, 100) > m(5, 0), 'los clics suman');
  assert.ok(ranking.PESOS.clics < ranking.PESOS.ventas, 'un clic es más barato de conseguir que una venta: pesa menos');
});

test('la novedad es una campana: 1 dentro del margen, la mitad pasada la escala, y 0 sin fecha', () => {
  const novedad = (dias) => ranking.novedadDe(producto(1, { publicado_en: haceDias(dias) }), AHORA);
  assert.equal(novedad(0), 1);
  assert.equal(novedad(ranking.NOVEDAD.margenDias), 1);
  assert.ok(Math.abs(novedad(ranking.NOVEDAD.margenDias + ranking.NOVEDAD.escalaDias) - ranking.NOVEDAD.decaimiento) < 1e-9, 'a margen + escala vale exactamente el decaimiento (0.5), igual que la gaussiana del motor');
  assert.ok(novedad(30) > novedad(90) && novedad(90) > novedad(365));
  assert.ok(novedad(1000) < 0.001, 'tiende a 0');
  assert.equal(ranking.novedadDe({ id: 1 }, AHORA), 0, 'sin fecha no se premia lo que no se sabe cuándo se publicó');
  assert.equal(ranking.novedadDe({ id: 1, publicado_en: 'no es una fecha' }, AHORA), 0);
});

test('con una palabra general los más vendidos suben, y con un texto específico una coincidencia mucho mejor no se la lleva un campeón de ventas', () => {
  // Relevancias (BM25) como las medidas en el índice real: «camiseta» da ~9–11 a todos; tres palabras exactas dan ~30.
  const campeon = ranking.multiplicador(producto(1, { total_vendido: 159, clics: 300, publicado_en: haceDias(300) }), AHORA);
  const sinVentas = ranking.multiplicador(producto(2, { total_vendido: 0, clics: 0, publicado_en: haceDias(300) }), AHORA);
  assert.ok(9.35 * campeon > 10.64 * sinVentas, 'palabra general: el campeón (relevancia 9.35) pasa al de 10.64 sin ventas');
  assert.ok(campeon < 4, 'el multiplicador está acotado');
  assert.ok(30 * sinVentas > 9.35 * campeon, 'texto específico: quien calza con tres palabras (30) le gana al campeón que solo calza con una');
});

// ── El orden en JavaScript (respaldo sin Elasticsearch) ─────────────────────

const ids = (lista) => lista.map((p) => p.id);
const ordenar = (lista, criterio) => ids([...lista].sort(ranking.comparadores(AHORA)[criterio]));

test('«más vendidos» desempata por el más reciente y después por el que más se abre; sin fecha va al final', () => {
  const lista = [
    producto(1, { total_vendido: 5, publicado_en: haceDias(500), clics: 900 }), // vendió igual, pero es viejo
    producto(2, { total_vendido: 5, publicado_en: haceDias(10), clics: 3 }),    // vendió igual y es nuevo → primero
    producto(3, { total_vendido: 9, publicado_en: haceDias(700) }),             // vendió más: gana a todos
    producto(4, { total_vendido: 5, publicado_en: haceDias(10), clics: 40 }),   // igual que el 2 en todo, con más clics
    producto(5, { total_vendido: 5, publicado_en: null }),                      // sin fecha: último de los empatados
  ];
  assert.deepEqual(ordenar(lista, 'masVendidos'), [3, 4, 2, 1, 5]);
});

test('«más recientes» ordena por fecha y desempata por ventas y clics', () => {
  const lista = [
    producto(1, { publicado_en: haceDias(30), total_vendido: 1 }),
    producto(2, { publicado_en: haceDias(2) }),
    producto(3, { publicado_en: haceDias(30), total_vendido: 8 }),
    producto(4, { publicado_en: null, total_vendido: 99 }),
  ];
  assert.deepEqual(ordenar(lista, 'masRecientes'), [2, 3, 1, 4]);
});

test('«relevancia» sin motor ordena por puntaje: el más vendido primero, y entre dos con las mismas ventas el más nuevo (no empujar un modelo viejo)', () => {
  const telefonos = [
    producto(1, { total_vendido: 20, clics: 50, publicado_en: haceDias(400) }), // modelo viejo, vendió 20
    producto(2, { total_vendido: 20, clics: 50, publicado_en: haceDias(20) }),  // modelo nuevo, vendió lo mismo
    producto(3, { total_vendido: 0, clics: 0, publicado_en: haceDias(400) }),
    producto(4, { total_vendido: 60, clics: 10, publicado_en: haceDias(60) }),
  ];
  assert.deepEqual(ordenar(telefonos, 'popularidad'), [4, 2, 1, 3]);
});

test('la fecha de publicación se guarda al día (UTC): los segundos no significan nada para ordenar por novedad, y los de un mismo día empatan EXACTO', () => {
  const dia = ranking.diaDePublicacion;
  assert.equal(dia('2026-09-23T03:46:56.000Z').toISOString(), '2026-09-23T00:00:00.000Z');
  assert.equal(dia(new Date('2026-09-23T23:59:59.999Z')).toISOString(), '2026-09-23T00:00:00.000Z');
  assert.equal(dia('2026-09-24T00:00:00.000Z').toISOString(), '2026-09-24T00:00:00.000Z', 'la medianoche exacta ya es del día siguiente');
  assert.equal(
    ranking.multiplicador({ id: 1, publicado_en: dia('2026-09-23T03:46:56Z') }, AHORA),
    ranking.multiplicador({ id: 2, publicado_en: dia('2026-09-23T21:00:00Z') }, AHORA),
    'dos productos del mismo día no se distinguen: ni el motor ni el respaldo tienen ruido de redondeo que los separe'
  );
  assert.ok(ranking.multiplicador({ id: 1, publicado_en: dia('2026-09-24T01:00:00Z') }, AHORA) !== ranking.multiplicador({ id: 2, publicado_en: dia('2026-09-23T01:00:00Z') }, AHORA), 'pero un día de diferencia sí');
  for (const invalida of [null, undefined, '', 'no es una fecha', NaN]) assert.equal(dia(invalida), null);
});

test('el puntaje se compara con la precisión del motor (float32): productos publicados con segundos de diferencia EMPATAN y se desempatan por id', () => {
  // Un lote sembrado de una vez: la novedad cambia ~2e-8 por segundo, menos de lo que distingue un float32.
  const mismoLote = (id, segundos) => producto(id, { publicado_en: new Date(AHORA - 100 * DIA - segundos * 1000).toISOString() });
  const viejo = mismoLote(1, 1); // un segundo MÁS viejo que el 2: en doubles tiene un puntaje apenas menor
  const nuevo = mismoLote(2, 0);
  assert.ok(ranking.multiplicador(nuevo, AHORA) > ranking.multiplicador(viejo, AHORA), 'en doubles el más reciente puntúa un poco más');
  assert.equal(Math.fround(ranking.multiplicador(nuevo, AHORA)), Math.fround(ranking.multiplicador(viejo, AHORA)), 'pero para el motor es el mismo puntaje');
  assert.deepEqual(ordenar([nuevo, viejo], 'popularidad'), [1, 2], 'empate: manda producto_id, igual que el motor');
  assert.deepEqual(ordenar([viejo, nuevo], 'popularidad'), [1, 2]);
  // Una diferencia que SÍ distingue (meses) sigue ordenando por novedad.
  assert.deepEqual(ordenar([producto(1, { publicado_en: haceDias(300) }), producto(2, { publicado_en: haceDias(30) })], 'popularidad'), [2, 1]);
});

test('desdeLista usa esos órdenes: sin ordenarPor, popularidad; masRecientes es un orden válido de la URL', () => {
  assert.equal(facetas.normalizarConsulta({ ordenarPor: 'masRecientes' }).ordenarPor, 'masRecientes');
  assert.equal(facetas.normalizarConsulta({ ordenarPor: 'popularidad' }).ordenarPor, undefined, 'solo valen los órdenes conocidos');
  const sub = { id: 's', subcategoria: 'Celulares', categoria_id: 'c', categoria: 'Electrónica' };
  const lista = [
    { ...producto(1, { total_vendido: 1 }), inventario: { precio: 10 }, subcategoria: sub, atributos: [] },
    { ...producto(2, { total_vendido: 30 }), inventario: { precio: 10 }, subcategoria: sub, atributos: [] },
    { ...producto(3, { total_vendido: 1, publicado_en: haceDias(1) }), inventario: { precio: 10 }, subcategoria: sub, atributos: [] },
  ];
  const resultados = (ordenarPor) => ids(facetas.desdeLista(lista, facetas.normalizarConsulta({ ordenarPor }), { ahoraMs: AHORA }).resultados);
  assert.deepEqual(resultados(undefined), [2, 3, 1], 'por defecto: popularidad (más vendido, luego el nuevo)');
  assert.deepEqual(resultados('masVendidos'), [2, 3, 1]);
  assert.deepEqual(resultados('masRecientes'), [3, 2, 1]);
});

// ── El servicio de clics ────────────────────────────────────────────────────

function servicio({ habilitado = true, mongoCaido = false, esCaido = false, docs = [], erroresDelBulk = [] } = {}) {
  const registro = { incs: [], bulks: [], fallos: [], consultas: [] };
  const Producto = {
    updateOne: async (filtro, cambio) => { if (mongoCaido) throw new Error('mongo apagado'); registro.incs.push({ id: filtro.producto_id, n: cambio.$inc.clics }); },
    find: (filtro) => { registro.consultas.push(filtro.producto_id.$in); return { select: () => ({ lean: async () => docs.filter((d) => filtro.producto_id.$in.includes(d.producto_id)) }) }; },
  };
  const es = { bulk: async ({ operations }) => {
    if (esCaido) throw new Error('elasticsearch apagado');
    registro.bulks.push(operations);
    return erroresDelBulk.length
      ? { errors: true, items: erroresDelBulk.map(({ id, status }) => ({ update: { _id: String(id), status, error: { reason: `falló ${id}` } } })) }
      : { errors: false, items: [] };
  } };
  const entorno = habilitado ? {} : { POPULARIDAD_ENABLED: 'false' };
  const modulo = cargar('../src/services/popularidadService.js', {
    '../models/mongo/Producto': Producto,
    '../config/mongo': { conectar: async () => { if (mongoCaido) throw new Error('mongo apagado'); } },
    '../config/elasticsearch': { conCircuito: async (operacion) => operacion(es), indice: () => 'indice_de_prueba' },
    '../utils/resiliencia': { registrarFallo: (contexto, err) => registro.fallos.push(`${contexto}: ${err.message}`) },
  }, entorno);
  modulo.reiniciar();
  return { ...modulo, registro, entorno };
}

const clic = (s, extra = {}) => s.registrarClic({ productoId: 7, vendedorId: 2, usuario: { id_usuario: 10, rol: 'comprador' }, ip: '1.1.1.1', userAgent: 'x', ahoraMs: AHORA, ...extra }, s.entorno);

test('un visitante cuenta UNA vez por ventana: recargar o volver atrás no suma, y pasada la ventana vuelve a contar', () => {
  const s = servicio();
  assert.equal(clic(s), true);
  assert.equal(clic(s, { ahoraMs: AHORA + 1000 }), false, 'recarga a los 1 s');
  assert.equal(clic(s, { ahoraMs: AHORA + 29 * 60000 }), false, 'a los 29 min sigue dentro de la ventana de 30');
  assert.equal(clic(s, { ahoraMs: AHORA + 31 * 60000 }), true, 'a los 31 min es otra visita');
  assert.equal(s.estado().clicsPendientes.get(7), 2);
});

test('cada persona y cada producto cuentan aparte; sin sesión el visitante es el hash de IP y navegador', () => {
  const s = servicio();
  assert.equal(clic(s), true);
  assert.equal(clic(s, { usuario: { id_usuario: 11, rol: 'comprador' } }), true, 'otra cuenta');
  assert.equal(clic(s, { productoId: 8 }), true, 'otro producto');
  assert.equal(clic(s, { usuario: undefined }), true, 'anónimo');
  assert.equal(clic(s, { usuario: undefined }), false, 'el mismo anónimo (misma IP y navegador) no vuelve a contar');
  assert.equal(clic(s, { usuario: undefined, ip: '2.2.2.2' }), true, 'otra IP');
  assert.equal(clic(s, { usuario: undefined, userAgent: 'otro navegador' }), true, 'otro navegador');
  assert.equal(s.estado().clicsPendientes.get(7), 5);
  assert.equal(s.estado().clicsPendientes.get(8), 1);
});

test('no cuentan el dueño del producto ni un administrador, ni un producto inválido, ni con el servicio apagado', () => {
  const s = servicio();
  assert.equal(clic(s, { usuario: { id_usuario: 2, rol: 'vendedor' }, vendedorId: 2 }), false, 'el vendedor mirando su propia ficha');
  assert.equal(clic(s, { usuario: { id_usuario: 1, rol: 'administrador' } }), false);
  assert.equal(clic(s, { productoId: 'x' }), false);
  assert.equal(clic(s, { productoId: 0 }), false);
  assert.equal(clic(s, { usuario: { id_usuario: 3, rol: 'vendedor' }, vendedorId: 2 }), true, 'otro vendedor sí: es un cliente más');
  assert.equal(clic(servicio({ habilitado: false })), false, 'POPULARIDAD_ENABLED=false');
});

test('la configuración rechaza un valor mal escrito en vez de caer en el defecto sin avisar', () => {
  const { configuracion } = servicio();
  assert.deepEqual(plano(configuracion({})), { habilitado: true, intervaloMs: 60000, ventanaMs: 1800000 });
  assert.equal(configuracion({ POPULARIDAD_ENABLED: 'false' }).habilitado, false);
  assert.throws(() => configuracion({ POPULARIDAD_INTERVALO_MS: '50' }), /POPULARIDAD_INTERVALO_MS/);
  assert.throws(() => configuracion({ POPULARIDAD_INTERVALO_MS: 'abc' }), /POPULARIDAD_INTERVALO_MS/);
  assert.throws(() => configuracion({ POPULARIDAD_VENTANA_CLIC_MS: '-1' }), /POPULARIDAD_VENTANA_CLIC_MS/);
});

test('el volcado suma los clics en Mongo (la fuente) y copia al índice los valores VIGENTES, en una sola petición', async () => {
  const s = servicio({ docs: [{ producto_id: 7, clics: 12, total_vendido: 30 }, { producto_id: 8, clics: 1, total_vendido: 2 }] });
  clic(s);
  clic(s, { usuario: { id_usuario: 11, rol: 'comprador' } });
  clic(s, { productoId: 8 });
  const resultado = await s.vaciar();
  assert.deepEqual(s.registro.incs, [{ id: 7, n: 2 }, { id: 8, n: 1 }]);
  assert.equal(s.registro.bulks.length, 1, 'una sola petición _bulk para todos');
  assert.deepEqual(plano(s.registro.bulks[0]), [
    { update: { _index: 'indice_de_prueba', _id: '7', retry_on_conflict: 3 } }, { doc: { clics: 12, total_vendido: 30 } },
    { update: { _index: 'indice_de_prueba', _id: '8', retry_on_conflict: 3 } }, { doc: { clics: 1, total_vendido: 2 } },
  ], 'valores absolutos tomados de Mongo después del $inc: repetir la escritura es inofensivo');
  assert.equal(resultado.clics, 3);
  assert.equal(s.estado().clicsPendientes.size, 0);
  assert.equal(s.estado().porRefrescar.size, 0);
});

test('una compra marca el producto: el índice recibe su total_vendido aunque nadie haya hecho clic', async () => {
  const s = servicio({ docs: [{ producto_id: 7, clics: 0, total_vendido: 31 }] });
  s.marcarVentas([7, '7', 'x', -1, null]);
  assert.deepEqual([...s.estado().porRefrescar], [7], 'solo ids válidos, sin repetir');
  await s.vaciar();
  assert.deepEqual(s.registro.incs, [], 'no hay clics que sumar en Mongo');
  assert.deepEqual(plano(s.registro.bulks[0]), [{ update: { _index: 'indice_de_prueba', _id: '7', retry_on_conflict: 3 } }, { doc: { clics: 0, total_vendido: 31 } }]);
});

test('sin nada pendiente el volcado no toca ninguna base', async () => {
  const s = servicio();
  assert.deepEqual(plano(await s.vaciar()), { productos: 0, clics: 0 });
  assert.equal(s.registro.consultas.length, 0);
  assert.equal(s.registro.bulks.length, 0);
});

test('con Mongo apagado lo pendiente vuelve al buffer (no se pierden clics) y se reintenta', async () => {
  const s = servicio({ mongoCaido: true });
  clic(s);
  s.marcarVentas([9]);
  const resultado = await s.vaciar();
  assert.match(resultado.error, /mongo apagado/);
  assert.equal(s.estado().clicsPendientes.get(7), 1);
  assert.deepEqual([...s.estado().porRefrescar].sort(), [7, 9]);
  assert.equal(s.registro.bulks.length, 0);
});

test('con Elasticsearch apagado Mongo ya tiene los clics; solo queda anotar que la copia del índice está atrasada', async () => {
  const s = servicio({ esCaido: true, docs: [{ producto_id: 7, clics: 5, total_vendido: 1 }] });
  clic(s);
  const resultado = await s.vaciar();
  assert.deepEqual(s.registro.incs, [{ id: 7, n: 1 }], 'Mongo sí se actualizó');
  assert.match(resultado.error, /elasticsearch apagado/);
  assert.equal(s.estado().clicsPendientes.size, 0, 'los clics ya no se suman dos veces');
  assert.deepEqual([...s.estado().porRefrescar], [7], 'pero el índice se iguala en el próximo volcado');
});

test('un producto que el índice no conoce (404) se ignora; cualquier otro error por producto se reintenta', async () => {
  const s = servicio({ docs: [{ producto_id: 7, clics: 1, total_vendido: 1 }, { producto_id: 8, clics: 1, total_vendido: 1 }], erroresDelBulk: [{ id: 7, status: 404 }, { id: 8, status: 500 }] });
  s.marcarVentas([7, 8]);
  await s.vaciar();
  assert.deepEqual([...s.estado().porRefrescar], [8], 'el 7 todavía no está indexado: lo llenará el backfill; el 8 falló de verdad');
  assert.equal(s.registro.fallos.length, 1);
});

test('dos volcados a la vez comparten la misma vuelta (no se suma dos veces)', async () => {
  const s = servicio({ docs: [{ producto_id: 7, clics: 1, total_vendido: 0 }] });
  clic(s);
  const [a, b] = [s.vaciar(), s.vaciar()];
  assert.equal(a, b);
  await a;
  assert.deepEqual(s.registro.incs, [{ id: 7, n: 1 }]);
});
