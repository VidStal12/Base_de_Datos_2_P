const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { cargar } = require('./redisHelpers');
const { ServicioNoDisponible } = require('../src/utils/resiliencia');
const { manejarErrores } = require('../src/utils/http');

// Las rutas de la pantalla /admin/permisos: qué le pasan a cada servicio, cómo contestan y cómo convierten los
// errores. Quién puede llamarlas (solo un administrador, ningún otro rol) lo prueba accesoRutas.test.js con el
// middleware real; acá requireAuth/requireRole se reemplazan por uno que deja pasar a un administrador de ejemplo.
const ADMIN = { id_usuario: 9, rol: 'administrador' };
const error = (status, mensaje) => Object.assign(new Error(mensaje), { status });

function montar(servicios = {}) {
  const llamadas = [];
  const registrar = (nombre, respuesta) => async (...args) => {
    llamadas.push([nombre, JSON.parse(JSON.stringify(args))]);
    if (typeof respuesta === 'function') return respuesta(...args);
    return respuesta ?? { ok: true };
  };
  const fallos = [];
  const router = cargar('../src/routes/adminAccesoRoutes.js', {
    '../middleware/auth': {
      requireAuth: (req, res, next) => { req.usuario = ADMIN; next(); },
      requireRole: () => (req, res, next) => next(),
    },
    '../services/politicaAccesoService': {
      matriz: registrar('matriz', servicios.matriz),
      aplicarCambios: registrar('aplicarCambios', servicios.aplicarCambios),
      restaurar: registrar('restaurar', servicios.restaurar),
      simular: registrar('simular', servicios.simular),
    },
    '../services/usuarioAdminService': {
      crearRol: registrar('crearRol', servicios.crearRol),
      eliminarRol: registrar('eliminarRol', servicios.eliminarRol),
      listarUsuarios: registrar('listarUsuarios', servicios.listarUsuarios),
      cambiarRol: registrar('cambiarRol', servicios.cambiarRol),
    },
    '../services/auditoriaAccesoService': {
      listar: registrar('listar', servicios.listar),
      exportarCsv: registrar('exportarCsv', servicios.exportarCsv ?? 'fecha,tipo\r\n2026-10-24T18:00:00.000Z,regla'),
    },
    '../utils/resiliencia': { ...require('../src/utils/resiliencia'), registrarFallo: (contexto, err) => fallos.push([contexto, err.message]) },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/admin', router);
  app.use(manejarErrores);
  return { app, llamadas, fallos };
}

async function pedir(app, metodo, ruta, cuerpo) {
  const servidor = http.createServer(app);
  await new Promise((resolver) => servidor.listen(0, '127.0.0.1', resolver));
  try {
    const respuesta = await fetch(`http://127.0.0.1:${servidor.address().port}/api/admin${ruta}`, {
      method: metodo,
      headers: cuerpo === undefined ? {} : { 'Content-Type': 'application/json' },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
    // Por bytes: fetch().text() decodifica en UTF-8 y se come la marca de orden de bytes que esta prueba quiere ver.
    const texto = Buffer.from(await respuesta.arrayBuffer()).toString('utf8');
    let json = null;
    try { json = JSON.parse(texto.replace(/^\uFEFF/, '')); } catch { /* CSV */ }
    return { estado: respuesta.status, json, texto, encabezados: respuesta.headers };
  } finally {
    servidor.closeAllConnections();
    servidor.close();
  }
}

// ── La matriz y los cambios ─────────────────────────────────────────────────────────────────────────────────────

test('GET /permisos devuelve la matriz y no la deja en ninguna caché', async () => {
  const { app } = montar({ matriz: { roles: [], rutas: [] } });
  const r = await pedir(app, 'GET', '/permisos');
  assert.equal(r.estado, 200);
  assert.deepEqual(r.json, { roles: [], rutas: [] });
  assert.equal(r.encabezados.get('cache-control'), 'no-store');
});

test('PUT /permisos le pasa al servicio quién cambia y el lote, y devuelve lo que aplicó', async () => {
  const lote = [{ clave: 'GET /api/admin/ventas', rol: 'auditor', permitido: true }];
  const { app, llamadas } = montar({ aplicarCambios: { aplicados: [{ clave: 'x' }], sinCambios: 0, auditado: true } });
  const r = await pedir(app, 'PUT', '/permisos', { cambios: lote });
  assert.equal(r.estado, 200);
  assert.deepEqual(llamadas, [['aplicarCambios', [ADMIN, lote]]]);
  assert.equal(r.json.auditado, true);
});

test('un cuerpo que no es un lote se le pasa tal cual al servicio, que es quien lo rechaza (400)', async () => {
  const { app } = montar({ aplicarCambios: () => { throw error(400, 'No hay cambios que aplicar.'); } });
  const r = await pedir(app, 'PUT', '/permisos', {});
  assert.deepEqual([r.estado, r.json], [400, { error: 'No hay cambios que aplicar.' }]);
});

test('POST /permisos/restaurar acepta solo textos: un objeto en lugar de la ruta no llega al servicio', async () => {
  const { app, llamadas } = montar({ restaurar: { restauradas: 2, auditado: true } });
  await pedir(app, 'POST', '/permisos/restaurar', { clave: 'GET /api/admin/ventas', rol: 'auditor' });
  await pedir(app, 'POST', '/permisos/restaurar', { clave: { $ne: 1 }, rol: ['a'] });
  await pedir(app, 'POST', '/permisos/restaurar');
  assert.deepEqual(llamadas.map(([, args]) => args[1]), [{ clave: 'GET /api/admin/ventas', rol: 'auditor' }, {}, {}]);
});

// ── El simulador ────────────────────────────────────────────────────────────────────────────────────────────────

test('el simulador pide la ruta y rechaza parámetros repetidos antes de llamar al servicio', async () => {
  const { app, llamadas } = montar({ simular: { permitido: true } });
  const sinClave = await pedir(app, 'GET', '/permisos/simular?rol=vendedor');
  assert.equal(sinClave.estado, 400);
  assert.match(sinClave.json.error, /ruta a simular/);
  assert.equal((await pedir(app, 'GET', '/permisos/simular?clave=GET%20%2Fapi%2Fadmin%2Fventas&rol=a&rol=b')).estado, 400);
  assert.equal((await pedir(app, 'GET', '/permisos/simular?clave=a&clave=b')).estado, 400);
  assert.deepEqual(llamadas, [], 'ninguno llegó al servicio');
  const ok = await pedir(app, 'GET', '/permisos/simular?clave=GET%20%2Fapi%2Fadmin%2Fventas&rol=vendedor');
  assert.equal(ok.estado, 200);
  assert.deepEqual(llamadas, [['simular', [{ clave: 'GET /api/admin/ventas', rol: 'vendedor' }]]]);
  const porCuenta = await pedir(app, 'GET', '/permisos/simular?clave=GET%20%2Fapi%2Fadmin%2Fventas&usuarioId=11');
  assert.equal(porCuenta.estado, 200);
  assert.deepEqual(llamadas[1], ['simular', [{ clave: 'GET /api/admin/ventas', usuarioId: '11' }]]);
});

test('un rol o una ruta que el simulador no conoce llega como 404 con el mensaje del servicio', async () => {
  const { app } = montar({ simular: () => { throw error(404, 'El rol «x» no existe.'); } });
  const r = await pedir(app, 'GET', '/permisos/simular?clave=a&rol=x');
  assert.deepEqual([r.estado, r.json], [404, { error: 'El rol «x» no existe.' }]);
});

// ── Roles y cuentas ─────────────────────────────────────────────────────────────────────────────────────────────

test('crear un rol responde 201; borrarlo, con el id de la URL', async () => {
  const { app, llamadas } = montar({ crearRol: { id: 5, nombre: 'soporte' }, eliminarRol: { eliminado: 'soporte' } });
  const creado = await pedir(app, 'POST', '/roles', { nombre: 'soporte' });
  assert.deepEqual([creado.estado, creado.json.nombre], [201, 'soporte']);
  const borrado = await pedir(app, 'DELETE', '/roles/5');
  assert.deepEqual([borrado.estado, borrado.json.eliminado], [200, 'soporte']);
  assert.deepEqual(llamadas, [['crearRol', [ADMIN, 'soporte']], ['eliminarRol', [ADMIN, '5']]]);
});

test('cambiar el rol de una cuenta le pasa el id de la URL y el rol del cuerpo; los límites del servicio llegan como 400/404/409', async () => {
  const { app, llamadas } = montar({ cambiarRol: (actor, id) => { if (id === '9') throw error(400, 'No podés cambiar tu propio rol'); if (id === '7') throw error(409, 'Tiene que quedar al menos un administrador.'); return { rol: 'auditor' }; } });
  assert.equal((await pedir(app, 'PATCH', '/usuarios/11/rol', { rol: 'auditor' })).estado, 200);
  assert.equal((await pedir(app, 'PATCH', '/usuarios/9/rol', { rol: 'comprador' })).estado, 400);
  assert.equal((await pedir(app, 'PATCH', '/usuarios/7/rol', { rol: 'comprador' })).estado, 409);
  assert.deepEqual(llamadas[0], ['cambiarRol', [ADMIN, '11', 'auditor']]);
});

test('listar cuentas pasa solo textos (búsqueda, página, tamaño)', async () => {
  const { app, llamadas } = montar({ listarUsuarios: { total: 0, usuarios: [] } });
  await pedir(app, 'GET', '/usuarios?q=ana&pagina=2&tamano=10');
  await pedir(app, 'GET', '/usuarios?q=a&q=b&pagina[x]=1');
  assert.deepEqual(llamadas[0][1][0], { q: 'ana', pagina: '2', tamano: '10' });
  assert.equal(llamadas[1][1][0].q, undefined, 'una búsqueda repetida (arreglo) se descarta');
});

// ── Auditoría ───────────────────────────────────────────────────────────────────────────────────────────────────

test('la auditoría pasa los filtros como textos y devuelve lo que el servicio entregue', async () => {
  const { app, llamadas } = montar({ listar: { total: 1, registros: [{ id: 'a1' }] } });
  const r = await pedir(app, 'GET', '/auditoria?tipo=cambios&actor=ana&desde=2026-10-01&hasta=2026-10-31&pagina=3&tamano=50');
  assert.equal(r.estado, 200);
  assert.deepEqual(llamadas[0], ['listar', [{ tipo: 'cambios', actor: 'ana', desde: '2026-10-01', hasta: '2026-10-31', pagina: '3', tamano: '50' }]]);
  assert.equal(r.encabezados.get('cache-control'), 'no-store');
});

test('un filtro inválido de la auditoría llega como 400', async () => {
  const { app } = montar({ listar: () => { throw error(400, 'Las fechas se escriben AAAA-MM-DD'); } });
  const r = await pedir(app, 'GET', '/auditoria?desde=ayer');
  assert.deepEqual([r.estado, r.json.error], [400, 'Las fechas se escriben AAAA-MM-DD']);
});

test('la exportación es un CSV descargable, en UTF-8 con marca de orden de bytes, sin caché', async () => {
  const { app } = montar();
  const r = await pedir(app, 'GET', '/auditoria/exportar?tipo=regla');
  assert.equal(r.estado, 200);
  assert.match(r.encabezados.get('content-type'), /^text\/csv; charset=utf-8/);
  assert.match(r.encabezados.get('content-disposition'), /^attachment; filename="auditoria-acceso-\d{4}-\d{2}-\d{2}\.csv"$/);
  assert.equal(r.encabezados.get('cache-control'), 'no-store');
  assert.ok(r.texto.startsWith('\uFEFF'), 'Excel necesita la marca para leer los acentos');
  assert.match(r.texto, /^\uFEFFfecha,tipo\r\n2026-10-24/);
});

// ── Errores ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('una base apagada es un 503 que dice cuál; un error inesperado es un 500 genérico, sin el texto crudo', async () => {
  const caida = montar({ matriz: () => { throw new ServicioNoDisponible('mysql'); } });
  const r = await pedir(caida.app, 'GET', '/permisos');
  assert.equal(r.estado, 503);
  assert.equal(r.json.codigo, 'SERVICIO_NO_DISPONIBLE');
  const rota = montar({ matriz: () => { throw new Error('Invalid `prisma.acl_regla.findMany()` invocation in C:\\proyecto\\backend\\src\\services\\x.js'); } });
  const e = await pedir(rota.app, 'GET', '/permisos');
  assert.equal(e.estado, 500);
  assert.doesNotMatch(JSON.stringify(e.json), /prisma|proyecto|invocation/);
  assert.match(e.json.error, /No se pudo completar la operación/);
  assert.equal(rota.fallos.length, 1, 'el detalle queda en el log del servidor');
  assert.match(rota.fallos[0][1], /invocation/);
});
