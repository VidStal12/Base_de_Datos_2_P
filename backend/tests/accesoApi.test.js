const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { cargar } = require('./redisHelpers');
const { manejarErrores } = require('../src/utils/http');

// Autorización de la API, de punta a punta con las piezas REALES: el middleware de autenticación (JWT + cuenta
// activa), las rutas y las reglas de dueño de productoService.verificarPermiso y de resenaService. Lo único que se
// reemplaza son las bases de datos y Redis. Se levanta un Express de verdad en un puerto libre y se le pregunta
// por HTTP como lo haría cada rol: la matriz de abajo es la evidencia de que nadie ve de más aunque encuentre un
// bug en la pantalla (IA/PLAN-ENTREGA-FINAL.md §4.1). Cada prueba nombra el hueco que cierra.

const SECRETO = 'secreto-solo-para-las-pruebas';
const firmar = (id_usuario, rol) => jwt.sign({ id_usuario, rol }, SECRETO, { expiresIn: '5m' });
const T = {
  comprador: firmar(1, 'comprador'),
  duenoDel1: firmar(2, 'vendedor'), // dueño del producto 1
  duenoDel3: firmar(5, 'vendedor'), // dueño del producto 3 (para el otro vendedor, el 1 es de la competencia)
  admin: firmar(9, 'administrador'),
  suspendido: firmar(2, 'vendedor'),
};

const suspendidas = new Set();
const auth = cargar('../src/middleware/auth.js', {
  '../services/suspensionService': {
    CODIGO_CUENTA_SUSPENDIDA: 'CUENTA_SUSPENDIDA',
    exigirCuentaActiva: async (id) => {
      if (suspendidas.has(id)) throw Object.assign(new Error('Cuenta suspendida'), { codigo: 'CUENTA_SUSPENDIDA' });
    },
  },
}, { JWT_SECRET: SECRETO });

// MySQL es la autoridad del dueño (verificarPermiso): el producto 1 es del vendedor 2 y el 3, del vendedor 5.
const PRODUCTOS_MYSQL = { 1: { id: 1, id_vendedor: 2 }, 3: { id: 3, id_vendedor: 5 } };
const consultasMysql = []; // ids por los que se le preguntó a MySQL
const real = cargar('../src/services/productoService.js', {
  '../config/prisma': {
    producto: {
      findUnique: async ({ where }) => {
        consultasMysql.push(where.id);
        // Como el Prisma de verdad: un id que no es un entero no devuelve «nada», lanza un error con la ruta del archivo.
        if (!Number.isInteger(where.id)) throw new Error('Invalid `prisma.producto.findUnique()` invocation in C:\\proyecto\\backend\\src\\services\\productoService.js');
        return PRODUCTOS_MYSQL[where.id] ?? null;
      },
      findMany: async () => [],
    },
  },
  '../config/mongo': { conectar: async () => {} },
  '../models/mongo/Producto': {},
  '../models/mongo/Subcategoria': {},
  '../models/mongo/ProductoEvento': {},
  './busquedaSyncService': {},
  './fraudeSyncService': {},
  './ofertaDatosService': {},
  './suspensionService': {},
});

// Lo que sí llegó a consultarse: cuando se niega un acceso, la lista no debe crecer.
const consultas = [];
const productoService = {
  ...real,
  historialCompleto: async (id) => {
    consultas.push(['historialCompleto', id]);
    return [{ version: 1, precio: 10, usuario_id: 2 }];
  },
  historialEnFecha: async (id, fecha) => {
    consultas.push(['historialEnFecha', id]);
    return { version: 1, precio: 10 };
  },
  estadisticasEdiciones: async () => {
    consultas.push(['estadisticasEdiciones']);
    return [{ producto_id: 1, total_eventos: 3 }];
  },
  vendedorOculto: async () => false,
};

const RESENAS = [
  { _id: 'r1', producto_id: 1, usuario_id: 1, usuario_nombre: 'Ana María Gómez López', calificacion: 5, comentario: 'Excelente', fecha: new Date('2026-10-01') },
  { _id: 'r2', producto_id: 1, usuario_id: 8, usuario_nombre: 'Luis Ramírez', calificacion: 4, fecha: new Date('2026-09-20') },
];
const resenaService = cargar('../src/services/resenaService.js', {
  '../config/prisma': {},
  '../config/mongo': { conectar: async () => {} },
  '../models/mongo/Producto': {},
  '../models/mongo/Resena': { find: () => ({ sort: () => ({ lean: async () => RESENAS }) }) },
  './fraudeSyncService': {},
  './ofertaDatosService': {},
});

const rutaProductos = cargar('../src/routes/productoRoutes.js', {
  '../middleware/auth': auth,
  '../services/productoService': productoService,
  '../services/catalogoLecturaService': { listar: async () => [], obtener: async () => ({}), registrarVistaProducto() {} },
  '../services/resenaService': resenaService,
});

const ESTADO = {
  estado: 'degradado',
  componentes: {
    mysql: { ok: true, ms: 12 },
    redis: { ok: false, ms: 1500, error: 'connect ECONNREFUSED 127.0.0.1:6379' },
    mongo: { ok: true, ms: 8 },
  },
  consultadoEn: '2026-10-23T12:00:00.000Z',
};
const estadoReal = cargar('../src/services/estadoServiciosService.js', {
  mongoose: { connection: { db: { admin: () => ({ ping: async () => {} }) } } },
  '../config/prisma': {},
  '../config/mongo': {},
  '../config/redis': {},
  '../config/elasticsearch': {},
  '../config/neo4j': {},
  '../config/cassandra': {},
}, {}, { setTimeout, clearTimeout });
const rutaSalud = cargar('../src/routes/saludRoutes.js', {
  '../middleware/auth': auth,
  '../services/estadoServiciosService': { consultar: async () => ESTADO, paraPublico: estadoReal.paraPublico },
});

const app = express();
app.use('/api/productos', rutaProductos);
app.use('/api/health', rutaSalud);
app.use(manejarErrores);

let servidor;
let base;
test.before(async () => {
  await new Promise((resolver) => {
    servidor = app.listen(0, resolver);
  });
  base = `http://127.0.0.1:${servidor.address().port}/api`;
});
test.after(() => {
  servidor.closeAllConnections?.();
  servidor.close();
});

async function pedir(ruta, tokenDe) {
  const respuesta = await fetch(base + ruta, { headers: tokenDe ? { Authorization: `Bearer ${tokenDe}` } : {} });
  return { estado: respuesta.status, cuerpo: await respuesta.json().catch(() => null) };
}
const sinConsultas = async (accion) => {
  consultas.length = 0;
  const resultado = await accion();
  assert.deepEqual(consultas, [], 'a la base no se le preguntó nada: se negó antes');
  return resultado;
};

// ── Historial de un producto: el dueño y el administrador, nadie más ────────

test('historial: sin sesión o con un token inválido, 401', async () => {
  assert.equal((await sinConsultas(() => pedir('/productos/1/historial'))).estado, 401);
  assert.equal((await sinConsultas(() => pedir('/productos/1/historial', 'token.invalido.xyz'))).estado, 401);
});

test('historial: un comprador no lo ve (403)', async () => {
  assert.equal((await sinConsultas(() => pedir('/productos/1/historial', T.comprador))).estado, 403);
});

test('historial: el vendedor DUEÑO ve el de su producto, con o sin fecha', async () => {
  const completo = await pedir('/productos/1/historial', T.duenoDel1);
  assert.equal(completo.estado, 200);
  assert.deepEqual(completo.cuerpo.map((e) => e.version), [1]);
  assert.equal((await pedir('/productos/1/historial?fecha=2026-10-01', T.duenoDel1)).estado, 200);
});

test('historial: un vendedor NO ve el de un producto ajeno (BOLA: antes devolvía 200 con los precios y el stock de la competencia)', async () => {
  for (const ruta of ['/productos/1/historial', '/productos/1/historial?fecha=2026-10-01']) {
    const r = await sinConsultas(() => pedir(ruta, T.duenoDel3));
    assert.equal(r.estado, 403, ruta);
    assert.match(r.cuerpo.error, /No podés ver el historial de un producto que no te pertenece/, ruta);
  }
});

test('historial: un administrador ve el de cualquier producto', async () => {
  for (const id of [1, 3]) assert.equal((await pedir(`/productos/${id}/historial`, T.admin)).estado, 200, `producto ${id}`);
});

test('historial: un producto que no existe es 404 y un id que no es un entero positivo no llega ni a MySQL (que respondería con una ruta de archivo)', async () => {
  assert.equal((await sinConsultas(() => pedir('/productos/777/historial', T.duenoDel1))).estado, 404);
  for (const id of ['abc', '0', '-3', '1.5']) {
    consultasMysql.length = 0;
    const r = await sinConsultas(() => pedir(`/productos/${id}/historial`, T.admin));
    assert.equal(r.estado, 404, `id ${id}`);
    assert.deepEqual(r.cuerpo, { error: 'Producto no encontrado' }, `id ${id}: sin el texto del error interno`);
    assert.deepEqual(consultasMysql, [], `id ${id}: ni se le preguntó a MySQL`);
  }
});

test('historial: una cuenta suspendida deja de servir su token en la misma petición (403)', async () => {
  suspendidas.add(2);
  try {
    const r = await sinConsultas(() => pedir('/productos/1/historial', T.suspendido));
    assert.equal(r.estado, 403);
    assert.equal(r.cuerpo.codigo, 'CUENTA_SUSPENDIDA');
  } finally {
    suspendidas.delete(2);
  }
});

// ── Estadísticas de ediciones: solo el administrador ────────────────────────

test('estadísticas de ediciones: sin sesión 401; comprador y vendedor 403; solo un administrador la ve (antes era pública)', async () => {
  assert.equal((await sinConsultas(() => pedir('/productos/estadisticas/ediciones'))).estado, 401);
  assert.equal((await sinConsultas(() => pedir('/productos/estadisticas/ediciones', T.comprador))).estado, 403);
  assert.equal((await sinConsultas(() => pedir('/productos/estadisticas/ediciones', T.duenoDel1))).estado, 403);
  const admin = await pedir('/productos/estadisticas/ediciones', T.admin);
  assert.equal(admin.estado, 200);
  assert.deepEqual(admin.cuerpo, [{ producto_id: 1, total_eventos: 3 }]);
});

// ── Reseñas: públicas, pero sin la identidad de quien las escribió ──────────

test('reseñas: cualquiera —anónimo, comprador, vendedor o administrador— ve alias, sin id de cuenta ni nombre completo', async () => {
  for (const [rol, tokenDe] of [['anónimo', undefined], ['comprador', T.comprador], ['vendedor', T.duenoDel1], ['administrador', T.admin]]) {
    const r = await pedir('/productos/1/resenas', tokenDe);
    assert.equal(r.estado, 200, rol);
    assert.deepEqual(r.cuerpo.map((x) => x.usuario_nombre), ['Ana L.', 'Luis R.'], rol);
    for (const resena of r.cuerpo) {
      assert.ok(!('usuario_id' in resena), `${rol}: no sale el id de la cuenta`);
      assert.ok(!/Gómez|María|Ramírez/.test(JSON.stringify(resena)), `${rol}: no sale el nombre completo`);
    }
    assert.deepEqual(Object.keys(r.cuerpo[0]).sort(), ['calificacion', 'comentario', 'fecha', 'id', 'producto_id', 'usuario_nombre'], `${rol}: la forma que la pantalla ya usa`);
  }
});

test('alias de quien reseña: primer nombre + inicial del último apellido', () => {
  const casos = [
    ['Ana Gómez', 'Ana G.'],
    ['Ana María Gómez López', 'Ana L.'],
    ['luis  ramírez', 'luis R.'],
    ['Óscar Álvarez', 'Óscar Á.'],
    ['Madonna', 'Madonna'],
    ['   ', 'Cliente'],
    [undefined, 'Cliente'],
    [null, 'Cliente'],
  ];
  for (const [nombre, esperado] of casos) assert.equal(resenaService.alias(nombre), esperado, String(nombre));
});

// ── Salud: pública, pero el detalle del error es del administrador ──────────

test('salud: sin sesión o con un token malo solo se ve si cada base responde, sin milisegundos ni texto del driver', async () => {
  for (const [quien, tokenDe] of [['anónimo', undefined], ['token inválido', 'token.invalido.xyz'], ['comprador', T.comprador], ['vendedor', T.duenoDel1]]) {
    const r = await pedir('/health/componentes', tokenDe);
    assert.equal(r.estado, 200, quien);
    assert.equal(r.cuerpo.estado, 'degradado', quien);
    assert.deepEqual(r.cuerpo.componentes, { mysql: { ok: true }, redis: { ok: false }, mongo: { ok: true } }, quien);
    assert.ok(!/ECONNREFUSED|127\.0\.0\.1|"ms"/.test(JSON.stringify(r.cuerpo)), `${quien}: nada de direcciones internas`);
  }
});

test('salud: un administrador sí recibe los milisegundos y el texto del error de cada base', async () => {
  const r = await pedir('/health/componentes', T.admin);
  assert.equal(r.estado, 200);
  assert.deepEqual(r.cuerpo, ESTADO);
});

test('salud: el chequeo de «estoy vivo» sigue siendo público y no toca ninguna base', async () => {
  assert.deepEqual((await pedir('/health')).cuerpo, { status: 'ok' });
});

test('verificarPermiso: dueño y administrador pasan; otro vendedor, 403; producto inexistente, 404; el verbo del mensaje se puede cambiar', async () => {
  const { verificarPermiso } = real;
  assert.equal((await verificarPermiso({ id_usuario: 2, rol: 'vendedor' }, 1)).id, 1);
  assert.equal((await verificarPermiso({ id_usuario: 9, rol: 'administrador' }, 1)).id, 1);
  await assert.rejects(verificarPermiso({ id_usuario: 5, rol: 'vendedor' }, 1), (e) => e.status === 403 && /No podés modificar un producto que no te pertenece/.test(e.message), 'el mensaje de siempre al editar');
  await assert.rejects(verificarPermiso({ id_usuario: 5, rol: 'vendedor' }, 1, 'ver el historial de'), (e) => e.status === 403 && /No podés ver el historial de un producto/.test(e.message));
  await assert.rejects(verificarPermiso({ id_usuario: 2, rol: 'vendedor' }, 404), (e) => e.status === 404);
});
