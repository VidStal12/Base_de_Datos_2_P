const test = require('node:test');
const assert = require('node:assert/strict');
const { cargar } = require('./redisHelpers');
const resiliencia = require('../src/utils/resiliencia');
const { ServicioNoDisponible } = resiliencia;

// catalogoLecturaService.relacionados(): la cadena por significado → misma subcategoría → nada, con dobles de los
// servicios. Lo que se prueba es la DECISIÓN —a quién se le pregunta, cuándo se cae a la capa siguiente y cuándo
// NO— y las reglas de visibilidad; el motor y Mongo reales los cubre scripts/verificarSimilares.js.
const plano = (valor) => JSON.parse(JSON.stringify(valor));
const caidaMongo = () => new ServicioNoDisponible('mongo');
const caidaElastic = () => new ServicioNoDisponible('elasticsearch');
const noEncontrado = () => Object.assign(new Error('Producto no encontrado'), { status: 404 });

const CAMISETAS = 'sub-camisetas';
const subCamisetas = { id: CAMISETAS, subcategoria: 'Camisetas', categoria_id: 'cat-ropa', categoria: 'Ropa' };
const producto = (id, descripcion, vendedor_id, { cantidad = 5, total_vendido = 0 } = {}) => ({
  id, descripcion, vendedor_id, total_vendido, inventario: { precio: 50, cantidad }, subcategoria: subCamisetas,
});
// El producto que se está mirando, tal como lo entrega productoService.obtener().
const ORIGEN = { ...producto(1, 'Camiseta azul', 2), estado: 'activo' };

// `parecidos`: lo que devuelve busquedaService.similares() (o una función que lo calcula / lanza). `delMismoTipo`: lo que
// devuelve productoService.listar({ subcategoriaId }). `existencias`: el stock vigente de Mongo por producto.
function servicio({ parecidos, delMismoTipo = [], origen = ORIGEN, oculto = false, existencias = [], mongoCaido = false } = {}) {
  const llamadas = [];
  const registrar = (nombre, respuesta) => async (...args) => {
    llamadas.push(nombre);
    return typeof respuesta === 'function' ? respuesta(...args) : respuesta;
  };
  const Producto = {
    find: (filtro) => ({
      select: () => ({
        lean: async () => {
          llamadas.push('mongo.existencias');
          return existencias.filter((d) => filtro.producto_id.$in.includes(d.producto_id));
        },
      }),
    }),
  };
  const modulo = cargar('../src/services/catalogoLecturaService.js', {
    './busquedaService': { similares: registrar('es.similares', parecidos ?? { origen: { id: 1, descripcion: 'Camiseta azul' }, candidatos: [], sinVector: false }) },
    './productoService': {
      obtener: registrar('mongo.obtener', origen),
      listar: registrar('mongo.listar', delMismoTipo),
      vendedorOculto: registrar('mongo.vendedorOculto', oculto),
    },
    './categoriaService': {},
    './suspensionService': {},
    './tendenciaService': {},
    '../models/mongo/Producto': Producto,
    '../config/mongo': { conectar: async () => { if (mongoCaido) throw caidaMongo(); } },
    '../config/redis': { conectar: async () => ({}) },
    '../utils/resiliencia': { ...resiliencia, registrarFallo: () => {} },
  });
  return { ...modulo, llamadas };
}

const respuestaDeIndice = (candidatos, origen = { id: 1, descripcion: 'Camiseta azul' }) => ({ origen, candidatos, sinVector: false });
const ids = (r) => plano(r).productos.map((p) => p.id);

// ── Por significado ─────────────────────────────────────────────────────────

test('con el índice sano los relacionados salen del índice; Mongo solo se consulta para releer el stock', async () => {
  const s = servicio({ parecidos: respuestaDeIndice([producto(2, 'Camiseta roja', 2), producto(3, 'Camiseta polo', 5)]) });
  const r = plano(await s.relacionados(1));
  assert.equal(r.modo, 'semantico');
  assert.deepEqual(ids(r), [2, 3]);
  assert.equal(r.subcategoria, undefined);
  assert.deepEqual(s.llamadas, ['es.similares', 'mongo.existencias'], 'ni se lee el producto ni se lista la subcategoría');
});

test('lo agotado va al final con el stock de HOY (Mongo), no con el de la última edición del índice', async () => {
  const s = servicio({
    parecidos: respuestaDeIndice([producto(2, 'Camiseta roja', 2, { cantidad: 9 }), producto(3, 'Camiseta polo', 5, { cantidad: 4 }), producto(4, 'Camiseta lisa', 2, { cantidad: 1 })]),
    existencias: [{ producto_id: 2, inventario: { cantidad: 0 }, total_vendido: 50 }],
  });
  const r = plano(await s.relacionados(1));
  assert.deepEqual(ids(r), [3, 4, 2], 'el #2 se agotó después de indexarse: pasa al final aunque era el más parecido');
  assert.equal(r.productos[2].inventario.cantidad, 0);
});

test('sin Mongo igual hay relacionados: se usa el stock del índice y no se falla por un dato que solo hace falta pulir', async () => {
  const s = servicio({ parecidos: respuestaDeIndice([producto(2, 'Camiseta roja', 2), producto(3, 'Camiseta polo', 5)]), mongoCaido: true });
  const r = plano(await s.relacionados(1));
  assert.equal(r.modo, 'semantico');
  assert.deepEqual(ids(r), [2, 3]);
});

test('le pasa al índice quién pregunta, para que no le ofrezca sus propios productos', async () => {
  let opciones;
  const s = servicio({ parecidos: (id, o) => { opciones = o; return respuestaDeIndice([producto(2, 'A', 2), producto(3, 'B', 5)]); } });
  await s.relacionados(1, 7);
  assert.deepEqual(plano(opciones), { vendedorPropioId: 7 });
});

test('aplica las reglas de negocio: sin repetidos, sin el título del propio producto y un vendedor no llena la lista', async () => {
  const candidatos = [
    producto(2, 'Camiseta azul', 5), // mismo título que el producto que se mira
    ...[3, 4, 5, 6, 7].map((n) => producto(n, `Camiseta ${n}`, 2)), // cinco del mismo vendedor
    producto(8, 'camiseta 3', 5), // repetido (otro vendedor)
    producto(9, 'Camiseta nueve', 5),
  ];
  const r = await servicio({ parecidos: respuestaDeIndice(candidatos) }).relacionados(1);
  assert.deepEqual(ids(r), [3, 4, 5, 9], 'tres del vendedor 2 (tope de la mitad de 6) y el #9; el #2 y el #8 se descartan por título');
});

// ── Misma subcategoría ──────────────────────────────────────────────────────

const MISMA_SUBCATEGORIA = [
  producto(1, 'Camiseta azul', 2),
  producto(2, 'Camiseta roja', 2, { total_vendido: 3 }),
  producto(3, 'Camiseta polo', 5, { total_vendido: 9 }),
  producto(4, 'Camiseta lisa', 5, { total_vendido: 6 }),
];

test('con Elasticsearch apagado los relacionados son de la misma subcategoría (Mongo), los más vendidos primero, y lo dice', async () => {
  const s = servicio({ parecidos: () => { throw caidaElastic(); }, delMismoTipo: MISMA_SUBCATEGORIA });
  const r = plano(await s.relacionados(1));
  assert.equal(r.modo, 'subcategoria');
  assert.equal(r.subcategoria, 'Camisetas', 'la pantalla dice «Misma subcategoría: Camisetas»');
  assert.deepEqual(ids(r), [3, 4, 2], 'sin el propio producto, por ventas');
  assert.deepEqual(s.llamadas, ['es.similares', 'mongo.obtener', 'mongo.vendedorOculto', 'mongo.listar']);
});

test('a Mongo se le pide la subcategoría del producto, no el catálogo entero', async () => {
  let pedido;
  const s = servicio({ parecidos: () => { throw caidaElastic(); }, delMismoTipo: (o) => { pedido = o; return MISMA_SUBCATEGORIA; } });
  await s.relacionados(1);
  assert.deepEqual(plano(pedido), { subcategoriaId: CAMISETAS });
});

test('en el respaldo tampoco se le ofrecen a un vendedor sus propios productos', async () => {
  const delMismoTipo = [...MISMA_SUBCATEGORIA, producto(5, 'Camiseta larga', 9, { total_vendido: 1 })];
  const s = servicio({ parecidos: () => { throw caidaElastic(); }, delMismoTipo });
  assert.deepEqual(ids(await s.relacionados(1, 5)), [2, 5], 'el vendedor 5 pregunta: sus #3 y #4 no aparecen');
  assert.deepEqual(ids(await s.relacionados(1)), [3, 4, 2, 5], 'sin sesión sí');
});

test('con menos de 2 resultados la sección se oculta (mejor nada que algo sin relación), también en el respaldo', async () => {
  const s = servicio({ parecidos: () => { throw caidaElastic(); }, delMismoTipo: MISMA_SUBCATEGORIA });
  const r = plano(await s.relacionados(1, 5)); // sin lo suyo, queda un solo producto
  assert.equal(r.modo, 'ninguno');
  assert.deepEqual(r.productos, []);
});

test('un producto sin vector (se indexó sin el modelo) cae a la subcategoría aunque el índice esté sano', async () => {
  const s = servicio({ parecidos: { origen: { id: 1, descripcion: 'Camiseta azul' }, candidatos: [], sinVector: true }, delMismoTipo: MISMA_SUBCATEGORIA });
  const r = plano(await s.relacionados(1));
  assert.equal(r.modo, 'subcategoria');
  assert.deepEqual(ids(r), [3, 4, 2]);
});

test('si por significado no alcanzan 2 parecidos, se prueba con la subcategoría', async () => {
  const s = servicio({ parecidos: respuestaDeIndice([producto(2, 'Camiseta roja', 2)]), delMismoTipo: MISMA_SUBCATEGORIA });
  const r = plano(await s.relacionados(1));
  assert.equal(r.modo, 'subcategoria');
  assert.deepEqual(s.llamadas, ['es.similares', 'mongo.existencias', 'mongo.obtener', 'mongo.vendedorOculto', 'mongo.listar']);
});

test('si por significado tampoco alcanzan y la subcategoría no tiene más de 1, no se muestra nada', async () => {
  const s = servicio({ parecidos: respuestaDeIndice([]), delMismoTipo: [producto(1, 'Camiseta azul', 2), producto(2, 'Camiseta roja', 2)] });
  const r = plano(await s.relacionados(1));
  assert.deepEqual(r, { modo: 'ninguno', productos: [] });
});

test('con el índice sano pero Mongo apagado y sin parecidos suficientes la sección se oculta, sin error', async () => {
  const s = servicio({ parecidos: respuestaDeIndice([]), mongoCaido: true, origen: () => { throw caidaMongo(); } });
  assert.deepEqual(plano(await s.relacionados(1)), { modo: 'ninguno', productos: [] });
});

// ── Errores ─────────────────────────────────────────────────────────────────

test('con Elasticsearch Y Mongo apagados se informa la caída del buscador (el origen), no la del respaldo', async () => {
  const s = servicio({ parecidos: () => { throw caidaElastic(); }, mongoCaido: true, origen: () => { throw caidaMongo(); } });
  await assert.rejects(s.relacionados(1), (err) => err.componente === 'elasticsearch');
});

test('un error que NO es una caída del buscador no se esconde detrás de otra capa', async () => {
  const s = servicio({ parecidos: () => { throw new Error('consulta mal armada'); }, delMismoTipo: MISMA_SUBCATEGORIA });
  await assert.rejects(s.relacionados(1), /consulta mal armada/);
  assert.deepEqual(s.llamadas, ['es.similares'], 'no se consultó Mongo para taparlo');
});

test('un producto que el índice no conoce pero Mongo sí (se creó con el buscador apagado) se resuelve por subcategoría', async () => {
  const s = servicio({ parecidos: () => { throw noEncontrado(); }, delMismoTipo: MISMA_SUBCATEGORIA });
  const r = plano(await s.relacionados(1));
  assert.equal(r.modo, 'subcategoria');
  assert.deepEqual(ids(r), [3, 4, 2]);
});

test('un producto que no existe en ninguna parte es un 404 (no una sección vacía)', async () => {
  const s = servicio({
    parecidos: () => { throw noEncontrado(); },
    origen: () => { throw new Error('Producto no encontrado'); },
  });
  await assert.rejects(s.relacionados(99), /no encontrado/);
});

test('el producto de un vendedor suspendido no tiene relacionados: es un 404, como su detalle para el público', async () => {
  const sinVector = { origen: { id: 1, descripcion: 'Camiseta azul' }, candidatos: [], sinVector: true };
  const s = servicio({ parecidos: sinVector, oculto: true, delMismoTipo: MISMA_SUBCATEGORIA });
  await assert.rejects(s.relacionados(1), (err) => err.status === 404);
  assert.ok(!s.llamadas.includes('mongo.listar'), 'ni se listó la subcategoría');
});

test('un producto sin subcategoría no rompe el respaldo: no hay con qué compararlo', async () => {
  const sinSubcategoria = { ...ORIGEN, subcategoria: undefined };
  const s = servicio({ parecidos: () => { throw caidaElastic(); }, origen: sinSubcategoria, delMismoTipo: MISMA_SUBCATEGORIA });
  assert.deepEqual(plano(await s.relacionados(1)), { modo: 'ninguno', productos: [] });
  assert.ok(!s.llamadas.includes('mongo.listar'));
});
