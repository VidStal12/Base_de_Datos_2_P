const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { cargar, politicaAccesoFalsa, auditoriaAccesoFalsa } = require('./redisHelpers');

// El middleware de autenticación hace cumplir la suspensión en cada petición
// (suspensionService.exigirCuentaActiva). La prueba contra el stack real, con Redis,
// es scripts/verificarBloqueoCuentas.js.
const SECRETO = 'secreto-de-prueba';

function middleware(suspendidas = []) {
  const suspension = {
    CODIGO_CUENTA_SUSPENDIDA: 'CUENTA_SUSPENDIDA',
    exigirCuentaActiva: async (id, rol) => {
      if (rol === 'administrador' || !suspendidas.includes(id)) return;
      const err = new Error('Tu cuenta está suspendida temporalmente');
      err.codigo = 'CUENTA_SUSPENDIDA';
      err.hasta = '2026-10-06T00:00:00.000Z';
      throw err;
    },
  };
  return cargar('../src/middleware/auth.js', { '../services/suspensionService': suspension, '../services/politicaAccesoService': politicaAccesoFalsa(), '../services/auditoriaAccesoService': auditoriaAccesoFalsa() }, { JWT_SECRET: SECRETO });
}

const token = (id, rol = 'comprador') => jwt.sign({ id_usuario: id, rol }, SECRETO);
const peticion = (t) => ({ headers: t ? { authorization: `Bearer ${t}` } : {} });
function respuesta() {
  const r = { codigo: null, cuerpo: null };
  r.status = (c) => {
    r.codigo = c;
    return r;
  };
  r.json = (b) => {
    r.cuerpo = b;
    return r;
  };
  return r;
}
async function correr(funcion, req) {
  const res = respuesta();
  let llamoNext = false;
  let errorNext = null;
  await funcion(req, res, (err) => {
    llamoNext = true;
    errorNext = err ?? null;
  });
  return { res, llamoNext, errorNext };
}

test('requireAuth: sin token o con uno inválido, 401; con uno válido de una cuenta activa, pasa', async () => {
  const { requireAuth } = middleware([]);
  assert.equal((await correr(requireAuth, peticion(null))).res.codigo, 401);
  assert.equal((await correr(requireAuth, peticion('basura'))).res.cuerpo.error, 'Token inválido o expirado');

  const req = peticion(token(7));
  const { llamoNext, errorNext } = await correr(requireAuth, req);
  assert.equal(llamoNext, true);
  assert.equal(errorNext, null);
  assert.equal(req.usuario.id_usuario, 7);
});

test('requireAuth: una cuenta suspendida recibe 403 con código y hora, y la petición no sigue', async () => {
  const { requireAuth } = middleware([7]);
  const req = peticion(token(7));
  const { res, llamoNext } = await correr(requireAuth, req);
  assert.equal(res.codigo, 403);
  assert.equal(res.cuerpo.codigo, 'CUENTA_SUSPENDIDA');
  assert.equal(res.cuerpo.hasta, '2026-10-06T00:00:00.000Z');
  assert.match(res.cuerpo.error, /suspendida temporalmente/);
  assert.equal(llamoNext, false);
  assert.equal(req.usuario, undefined, 'una cuenta suspendida no llega a las rutas con sesión');
  // Otra cuenta, mismo middleware: pasa.
  assert.equal((await correr(requireAuth, peticion(token(8)))).llamoNext, true);
});

test('requireAuth: un administrador nunca queda fuera, aunque su id figure como suspendido', async () => {
  const { requireAuth } = middleware([1]);
  assert.equal((await correr(requireAuth, peticion(token(1, 'administrador')))).llamoNext, true);
});

test('requireAuth: un error inesperado de la consulta se pasa a Express, no se confunde con una suspensión', async () => {
  const { requireAuth } = cargar(
    '../src/middleware/auth.js',
    {
      '../services/suspensionService': {
        CODIGO_CUENTA_SUSPENDIDA: 'CUENTA_SUSPENDIDA',
        exigirCuentaActiva: async () => {
          throw new Error('algo raro');
        },
      },
      '../services/politicaAccesoService': politicaAccesoFalsa(), '../services/auditoriaAccesoService': auditoriaAccesoFalsa(),
    },
    { JWT_SECRET: SECRETO }
  );
  const { res, errorNext } = await correr(requireAuth, peticion(token(7)));
  assert.equal(res.codigo, null);
  assert.match(errorNext.message, /algo raro/);
});

test('optionalAuth: una cuenta suspendida se trata como visitante (el catálogo público sigue abierto)', async () => {
  const { optionalAuth } = middleware([7]);
  const suspendida = peticion(token(7));
  const a = await correr(optionalAuth, suspendida);
  assert.equal(a.llamoNext, true);
  assert.equal(suspendida.usuario, undefined);

  const activa = peticion(token(8));
  await correr(optionalAuth, activa);
  assert.equal(activa.usuario.id_usuario, 8);

  const anonima = peticion(null);
  assert.equal((await correr(optionalAuth, anonima)).llamoNext, true);
  assert.equal(anonima.usuario, undefined);
});
