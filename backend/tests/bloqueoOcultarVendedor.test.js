const test = require('node:test');
const assert = require('node:assert/strict');
const { cargar, redisFalso, productoFalso, compromisoFalso } = require('./redisHelpers');
const { suspensionReal } = require('./bloqueoHelpers');

const DIA = 24 * 3600 * 1000;

// Un vendedor suspendido deja de mostrarse y de poder comprarse mientras dure la
// suspensión, y vuelve solo cuando se levanta (PLAN §21). La visibilidad se DERIVA del
// candado de Redis: acá se usa el suspensionService REAL sobre un Redis en memoria, y
// los servicios que filtran (catálogo, buscador, recomendaciones) sobre dobles de sus
// bases. El carrito y la oferta flash se prueban en carrito.test.js y ofertaCache.test.js.
//
// Los servicios se cargan en un vm (ver redisHelpers.cargar), así que lo que devuelven
// viene de OTRO reino: se aplana a datos planos antes de comparar.
const plano = (valor) => JSON.parse(JSON.stringify(valor));
const ids = (lista) => Array.from(lista, (producto) => producto.id);

// ── Catálogo ────────────────────────────────────────────────────────────────

// El vendedor 11 tiene tres productos (uno inactivo) y el 12 uno.
const CATALOGO = [
  { producto_id: 1, vendedor_id: 11, descripcion: 'Camiseta azul', estado: 'activo', inventario: { precio: 50, cantidad: 9 } },
  { producto_id: 2, vendedor_id: 11, descripcion: 'Camiseta roja', estado: 'activo', inventario: { precio: 60, cantidad: 9 } },
  { producto_id: 3, vendedor_id: 12, descripcion: 'Pantalón negro', estado: 'activo', inventario: { precio: 90, cantidad: 9 } },
  { producto_id: 4, vendedor_id: 11, descripcion: 'Gorra vieja', estado: 'inactivo', inventario: { precio: 20, cantidad: 0 } },
];
const FILAS_MYSQL = CATALOGO.map(({ producto_id, vendedor_id }) => ({ id: producto_id, id_vendedor: vendedor_id }));

// Filtro de Mongo → predicado, SOLO con lo que usa productoService.listar(): cualquier
// otra condición lanza, para que un filtro nuevo obligue a actualizar este doble en vez
// de pasar en silencio.
function coincideMongo(doc, filtro) {
  return Object.entries(filtro).every(([campo, condicion]) => {
    if (campo === '$or') return condicion.some((opcion) => coincideMongo(doc, opcion));
    const valor = doc[campo];
    if (condicion !== null && typeof condicion === 'object') {
      if ('$nin' in condicion) return !condicion.$nin.includes(valor);
      if ('$regex' in condicion) return new RegExp(condicion.$regex, condicion.$options).test(valor);
      throw new Error(`Condición de Mongo no soportada por el doble: ${JSON.stringify(condicion)}`);
    }
    return valor === condicion;
  });
}

function escenario() {
  const base = suspensionReal();
  const prisma = {
    consultas: 0,
    producto: {
      async findMany({ where }) {
        prisma.consultas += 1;
        return FILAS_MYSQL.filter((fila) => where.id.in.includes(fila.id) && where.id_vendedor.in.includes(fila.id_vendedor)).map(({ id }) => ({ id }));
      },
    },
  };
  const Producto = {
    find(filtro) {
      const consulta = {
        populate: () => consulta,
        sort: () => consulta,
        lean: async () => CATALOGO.filter((doc) => coincideMongo(doc, filtro)).map((doc) => ({ ...doc })),
      };
      return consulta;
    },
  };
  const producto = cargar('../src/services/productoService.js', {
    '../config/prisma': prisma,
    '../config/mongo': { conectar: async () => {} },
    '../models/mongo/Producto': Producto,
    '../models/mongo/Subcategoria': {},
    '../models/mongo/ProductoEvento': {},
    './busquedaSyncService': {},
    './fraudeSyncService': {},
    './ofertaDatosService': {},
    './suspensionService': base.suspension,
  });
  return { ...base, prisma, producto };
}

// ── Catálogo y consulta de vendedores ───────────────────────────────────────

test('un vendedor suspendido deja de verse en el catálogo y vuelve al instante en que se libera la cuenta', async () => {
  const e = escenario();
  assert.deepEqual(ids(await e.producto.listar()), [1, 2, 3]);

  await e.suspension.bloquear(11, DIA);
  assert.deepEqual(ids(await e.producto.listar()), [3], 'sus productos activos desaparecen');
  assert.deepEqual(ids(await e.producto.listar({ q: 'camiseta' })), [], 'ni buscando su texto');
  assert.deepEqual(ids(await e.producto.listar({ vendedorId: 11 })), [], 'ni filtrando por él');
  assert.deepEqual(ids(await e.producto.listar({ vendedorId: 12 })), [3], 'los de otro vendedor no se tocan');

  await e.suspension.levantar(11); // un administrador la "perdona"
  assert.deepEqual(ids(await e.producto.listar()), [1, 2, 3], 'vuelven sin esperar nada: levantar invalida el memo');
  assert.deepEqual(ids(await e.producto.listar({ vendedorId: 11 })), [1, 2]);
});

test('el memo no retrasa la suspensión que empieza: bloquear lo invalida y el catálogo la ve en la siguiente consulta', async () => {
  const e = escenario();
  assert.deepEqual(ids(await e.producto.listar()), [1, 2, 3], 'esta lectura arma el memo (sin suspendidos)');
  await e.suspension.bloquear(11, DIA);
  assert.deepEqual(ids(await e.producto.listar()), [3]);
});

test('una suspensión que vence sola devuelve los productos a lo sumo 3 s después de vencer (el memo)', async () => {
  const e = escenario();
  await e.suspension.bloquear(11, DIA);
  assert.deepEqual(ids(await e.producto.listar()), [3], 'esta lectura arma el memo');

  e.redis.avanzar(DIA + 1000); // el TTL venció en Redis, pero no hay evento de "venció"
  assert.deepEqual(ids(await e.producto.listar()), [3], 'el memo todavía no se enteró');
  e.reloj.ahora += 2900;
  assert.deepEqual(ids(await e.producto.listar()), [3], 'sigue dentro de la ventana de 3 s');
  e.reloj.ahora += 200;
  assert.deepEqual(ids(await e.producto.listar()), [1, 2, 3], 'pasados los 3 s se relee Redis y vuelven solos');
});

test('un administrador sigue viendo los productos ocultos, marcados como de vendedor suspendido', async () => {
  const e = escenario();
  await e.suspension.bloquear(11, DIA);

  const vistos = plano(await e.producto.listar({ mostrarInactivos: true }));
  assert.deepEqual(vistos.map((p) => p.id), [1, 2, 3, 4], 'incluso el inactivo: es la vista completa');
  assert.deepEqual(vistos.filter((p) => p.vendedor_suspendido).map((p) => p.id), [1, 2, 4], 'marca los del vendedor suspendido, y solo esos');

  await e.suspension.levantar(11);
  assert.ok(plano(await e.producto.listar({ mostrarInactivos: true })).every((p) => !p.vendedor_suspendido), 'liberado: sin marca');
});

test('si Redis falla no se oculta a nadie: la consulta de suspendidos falla abierta', async () => {
  const e = escenario();
  await e.suspension.bloquear(11, DIA);
  e.reloj.ahora += 3100; // memo vencido: la próxima lectura va a Redis
  e.redis.scan = async () => {
    throw new Error('Redis caído');
  };
  assert.deepEqual(ids(await e.producto.listar()), [1, 2, 3], 'sin Redis el catálogo se muestra completo, como antes de existir la suspensión');
  assert.equal(await e.producto.vendedorOculto(11), false);
});

test('vendedorOculto / vendedoresOcultos responden con el candado vigente', async () => {
  const e = escenario();
  assert.equal(await e.producto.vendedorOculto(11), false);
  await e.suspension.bloquear(11, DIA);
  assert.equal(await e.producto.vendedorOculto(11), true);
  assert.equal(await e.producto.vendedorOculto('11'), true, 'el id puede llegar como texto');
  assert.equal(await e.producto.vendedorOculto(12), false);
  assert.equal(await e.producto.vendedorOculto(undefined), false);
  assert.deepEqual([...(await e.producto.vendedoresOcultos())], [11]);
  await e.suspension.levantar(11);
  assert.equal(await e.producto.vendedorOculto(11), false);
});

// ── Autoridad en los caminos de compra ──────────────────────────────────────

test('verificarVendedoresActivos: sin suspendidos no cuesta una consulta a MySQL', async () => {
  const e = escenario();
  await e.producto.verificarVendedoresActivos([1, 2, 3]);
  assert.equal(e.prisma.consultas, 0, 'el caso normal (nadie suspendido) no consulta nada');
});

test('verificarVendedoresActivos rechaza con 409 un pedido con productos de un vendedor suspendido, y lo acepta al levantarse', async () => {
  const e = escenario();
  await e.suspension.bloquear(11, DIA);

  await e.producto.verificarVendedoresActivos([3]); // solo de otro vendedor: pasa
  await assert.rejects(
    e.producto.verificarVendedoresActivos([3, 1]),
    (err) => err.status === 409 && /no disponibles/.test(err.message),
    'un solo producto del vendedor suspendido invalida el pedido',
  );
  await assert.rejects(e.producto.verificarVendedoresActivos([4]), (err) => err.status === 409, 'aunque el producto esté inactivo: la regla es por vendedor');

  await e.suspension.levantar(11);
  await e.producto.verificarVendedoresActivos([3, 1]);
});

// ── Buscador (Elasticsearch) ────────────────────────────────────────────────

function buscadorConElastic(suspension, opciones = []) {
  const pedidos = [];
  const cliente = {
    async search(pedido) {
      pedidos.push(pedido);
      // Igual que el real, devuelve a lo sumo `size` opciones. sugerir() pide dos suggesters
      // (exactas y aproximadas, ver busquedaService.js); aquí ambos responden lo mismo.
      if (pedido.suggest) {
        const opcionesDe = (nombre) => [{ options: opciones.slice(0, pedido.suggest[nombre].completion.size) }];
        return { suggest: { exactas: opcionesDe('exactas'), aproximadas: opcionesDe('aproximadas') } };
      }
      return { hits: { total: { value: 0 }, hits: [] }, aggregations: {} };
    },
  };
  const servicio = cargar('../src/services/busquedaService.js', {
    '../config/elasticsearch': { conectar: async () => cliente, conCircuito: async (operacion) => operacion(cliente), indice: () => 'tiendaya_productos' },
    './suspensionService': suspension,
  });
  return { servicio, pedidos };
}

test('buscar excluye a los vendedores suspendidos en la MISMA consulta que arma las facetas y el total', async () => {
  const e = escenario();
  const { servicio, pedidos } = buscadorConElastic(e.suspension);

  // Sin orden pedido, la consulta va envuelta en el puntaje de popularidad (rankingBusqueda.js).
  const consulta = (pedido) => pedido.query.function_score.query;
  await servicio.buscar({ q: 'camiseta' });
  assert.equal(consulta(pedidos[0]).bool.must_not, undefined, 'sin suspendidos no se agrega ninguna exclusión');

  await e.suspension.bloquear(11, DIA);
  await e.suspension.bloquear(13, DIA);
  await servicio.buscar({ q: 'camiseta' });
  assert.deepEqual(plano(consulta(pedidos[1]).bool.must_not), [{ terms: { vendedor_id: [11, 13] } }]);
  assert.ok(pedidos[1].aggs, 'las agregaciones (facetas, conteos) van en esa misma consulta: no pueden contar productos ocultos');
  assert.equal(pedidos.length, 2, 'una sola petición a Elasticsearch por búsqueda');

  await e.suspension.levantar(11);
  await e.suspension.levantar(13);
  await servicio.buscar({ q: 'camiseta' });
  assert.equal(consulta(pedidos[2]).bool.must_not, undefined, 'liberados: la búsqueda vuelve a verlos');
});

test('sugerir pide más opciones si hay suspendidos, descarta las de ese vendedor y devuelve a lo sumo 8', async () => {
  const e = escenario();
  // 24 opciones que alternan entre el vendedor 11 (pares) y el 12 (impares).
  const opciones = Array.from({ length: 24 }, (_, i) => ({ text: `Producto ${i}`, _source: { vendedor_id: i % 2 === 0 ? 11 : 12 } }));
  const { servicio, pedidos } = buscadorConElastic(e.suspension, opciones);

  const normales = plano(await servicio.sugerir('prod'));
  assert.equal(pedidos[0].suggest.exactas.completion.size, 8, 'sin suspendidos pide lo de siempre');
  assert.deepEqual(plano(pedidos[0]._source), ['vendedor_id'], 'el vendedor viaja en la opción para poder descartarla');
  assert.deepEqual(normales, ['Producto 0', 'Producto 1', 'Producto 2', 'Producto 3', 'Producto 4', 'Producto 5', 'Producto 6', 'Producto 7']);

  await e.suspension.bloquear(11, DIA);
  const filtradas = plano(await servicio.sugerir('prod'));
  assert.equal(pedidos[1].suggest.exactas.completion.size, 24, 'con suspendidos pide de más para poder descartar y aun así llenar 8');
  assert.deepEqual(filtradas, ['Producto 1', 'Producto 3', 'Producto 5', 'Producto 7', 'Producto 9', 'Producto 11', 'Producto 13', 'Producto 15'], 'ninguna es del vendedor 11, y sigue habiendo 8');

  await e.suspension.levantar(11);
  assert.deepEqual(plano(await servicio.sugerir('prod')), normales, 'liberado: las sugerencias vuelven');
  assert.deepEqual(plano(await servicio.sugerir('  ')), [], 'un texto vacío no consulta nada');
  assert.equal(pedidos.length, 3);
});

// ── Recomendaciones (caché de 1 h) ──────────────────────────────────────────

function recomendacionesConCache(suspendidos) {
  const redis = redisFalso();
  const cupo = { gastos: 0 };
  redis.decrementarOferta = async () => {
    cupo.gastos += 1;
    return 1;
  };
  // Una recomendación calculada ANTES de la suspensión y todavía dentro de su hora de caché.
  redis.valores.set('recomendaciones:7', JSON.stringify({
    tendencia: { subcategoriaId: 's1', atributosPreferidos: [], vendedorPreferidoId: 11 },
    productos: [
      { id: 1, nombre: 'Camiseta azul', vendedor_id: 11, precio_normal: 50, precio_recomendado: 42.5 },
      { id: 3, nombre: 'Pantalón', vendedor_id: 12, precio_normal: 90, precio_recomendado: 76.5 },
    ],
  }));
  const servicio = cargar('../src/services/tendenciaService.js', {
    '../config/prisma': {},
    '../config/mongo': { conectar: async () => {} },
    '../config/redis': { conectar: () => redis },
    '../models/mongo/Producto': {},
    './checkoutService': { checkoutOferta: async () => ({ id: 1 }) },
    './productoService': productoFalso({ suspendidos, obtener: async () => ({ inventario: { precio: 50 } }) }),
    './compromisoService': compromisoFalso(),
  });
  return { servicio, cupo };
}

test('una recomendación ya cacheada oculta al vendedor suspendido (se filtra al leer) y no se puede comprar; vuelve al levantarse', async () => {
  const suspendidos = new Set();
  const { servicio, cupo } = recomendacionesConCache(suspendidos);
  assert.deepEqual(ids(plano((await servicio.recomendar(7)).productos)), [1, 3]);

  suspendidos.add(11);
  assert.deepEqual(ids(plano((await servicio.recomendar(7)).productos)), [3], 'el caché sigue siendo de una hora, pero se filtra al leerlo');
  await assert.rejects(
    servicio.comprar(7, 1, { cantidad: 1 }),
    (err) => err.status === 403 && /recomendación vigente/.test(err.message),
    'comprar la ve como "ya no es una recomendación vigente"',
  );
  assert.equal(cupo.gastos, 0, 'no se gastó el cupo personal');

  suspendidos.delete(11);
  assert.deepEqual(ids(plano((await servicio.recomendar(7)).productos)), [1, 3], 'liberado: reaparece sin recalcular nada');
  await servicio.comprar(7, 1, { cantidad: 1 });
  assert.equal(cupo.gastos, 1);
});
