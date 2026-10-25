const test = require('node:test');
const assert = require('node:assert/strict');
const { cargar } = require('./redisHelpers');

// requireRole con la política de permisos: le pregunta a politicaAccesoService con la CLAVE de la ruta (sale de cómo
// se montó el router) y la lista de roles que declara el código; si se niega, responde 403 ACL_DENEGADO y deja la
// denegación en la auditoría. La política real se prueba en permisosPolitica.test.js y la matriz completa por HTTP,
// con el router de verdad, en accesoRutas.test.js.
// Lo que devuelve el módulo cargado en el sandbox es de otro «realm»: deepEqual compara también el prototipo.
const plano = (valor) => JSON.parse(JSON.stringify(valor));

function montar({ decision = { permitido: true, origen: 'codigo', rol: 'vendedor' }, falla = null } = {}) {
  const preguntas = [];
  const denegaciones = [];
  const auth = cargar('../src/middleware/auth.js', {
    '../services/suspensionService': { CODIGO_CUENTA_SUSPENDIDA: 'CUENTA_SUSPENDIDA', exigirCuentaActiva: async () => {} },
    '../services/politicaAccesoService': {
      permite: async (usuario, clave, porDefecto) => {
        preguntas.push({ usuario, clave, porDefecto: [...porDefecto] });
        if (falla) throw falla;
        return decision;
      },
    },
    '../services/auditoriaAccesoService': { registrarDenegacion: (usuario, ruta, rol) => denegaciones.push({ id: usuario.id_usuario, ruta, rol }) },
  });
  return { ...auth, preguntas, denegaciones };
}

async function correr(middleware, req) {
  const res = { codigo: null, cuerpo: null };
  res.status = (c) => { res.codigo = c; return res; };
  res.json = (b) => { res.cuerpo = b; return res; };
  let siguio = false;
  let errorNext = null;
  await middleware(req, res, (err) => { siguio = true; errorNext = err ?? null; });
  return { res, siguio, errorNext };
}

const peticion = (extra = {}) => ({ method: 'GET', baseUrl: '/api/admin', route: { path: '/ventas' }, usuario: { id_usuario: 5, rol: 'vendedor' }, ...extra });

test('si la política permite, sigue; y se le pregunta con la clave de la ruta y los roles que declara el código', async () => {
  const m = montar();
  const mw = m.requireRole('administrador');
  const r = await correr(mw, peticion());
  assert.equal(r.siguio, true);
  assert.equal(r.res.codigo, null);
  assert.deepEqual(m.preguntas, [{ usuario: { id_usuario: 5, rol: 'vendedor' }, clave: 'GET /api/admin/ventas', porDefecto: ['administrador'] }]);
  assert.equal(m.denegaciones.length, 0);
});

test('si la política deniega: 403 con ACL_DENEGADO, la petición no sigue y la denegación queda auditada con el rol de hoy', async () => {
  const m = montar({ decision: { permitido: false, origen: 'codigo', rol: 'comprador' } });
  const r = await correr(m.requireRole('administrador'), peticion());
  assert.equal(r.siguio, false);
  assert.equal(r.res.codigo, 403);
  assert.deepEqual(plano(r.res.cuerpo), { error: 'No tenés permiso para esta acción', codigo: 'ACL_DENEGADO' });
  assert.deepEqual(m.denegaciones, [{ id: 5, ruta: 'GET /api/admin/ventas', rol: 'comprador' }], 'el rol de hoy, no el del token');
  assert.equal(m.CODIGO_DENEGADO, 'ACL_DENEGADO');
});

test('sin sesión (requireAuth no corrió) se niega sin preguntarle a nadie', async () => {
  const m = montar();
  const r = await correr(m.requireRole('administrador'), peticion({ usuario: undefined }));
  assert.equal(r.res.codigo, 403);
  assert.equal(m.preguntas.length, 0);
});

test('si la política falla por un error inesperado, NO se deja pasar: el error sigue a Express (500)', async () => {
  const m = montar({ falla: new Error('algo raro en la política') });
  const r = await correr(m.requireRole('administrador'), peticion());
  assert.equal(r.res.codigo, null, 'no responde 200 ni 403: es un fallo del servidor');
  assert.match(r.errorNext.message, /algo raro/);
  assert.equal(m.denegaciones.length, 0);
});

test('la clave de la ruta sale de cómo se montó el router', () => {
  const { claveDeLaRuta } = montar();
  assert.equal(claveDeLaRuta({ method: 'GET', baseUrl: '/api/admin', route: { path: '/ventas' } }), 'GET /api/admin/ventas');
  assert.equal(claveDeLaRuta({ method: 'POST', baseUrl: '/api/productos', route: { path: '/' } }), 'POST /api/productos', 'router.post(\'/\') no deja una barra de más');
  assert.equal(claveDeLaRuta({ method: 'PATCH', baseUrl: '/api/productos', route: { path: '/:id' } }), 'PATCH /api/productos/:id', 'el patrón, no el id de esta petición');
  assert.equal(claveDeLaRuta({ method: 'HEAD', baseUrl: '/api/admin', route: { path: '/ventas' } }), 'GET /api/admin/ventas', 'Express atiende un HEAD con el manejador del GET');
  assert.equal(claveDeLaRuta({ method: 'GET', baseUrl: '/api/admin', path: '/x' }), 'GET /api/admin/x', 'un middleware de router, sin ruta todavía');
});

test('el middleware conserva su etiqueta de acceso: la prueba de la lista blanca lee de ahí los roles que declara el código', () => {
  const { requireRole } = montar();
  assert.deepEqual(plano(requireRole('vendedor', 'administrador').acceso), { roles: ['vendedor', 'administrador'] });
});
