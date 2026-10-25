// La lista blanca de la API (IA/PLAN-ENTREGA-FINAL.md §4.0, paso 1b): recorre el router REAL de app.js y lo
// compara con config/politicaRutas.js. Una ruta sin declarar, un acceso distinto del declarado o una entrada
// que ya no existe hacen fallar la suite. Además prueba por HTTP, en cada ruta protegida, que sin token o con
// un token malo la respuesta es 401 y que cada rol que NO figura en su lista recibe 403 —sin que la petición
// llegue nunca a un servicio—: es la matriz rol × endpoint completa, no solo los cuatro huecos corregidos.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'secreto-de-prueba-acceso-rutas';
// Ninguna base real: config/prisma.js arma el adaptador al cargarse (sin conectar) y, si por un error una
// petición llegara a un servicio, fallaría enseguida contra un puerto cerrado en vez de colgarse esperando.
Object.assign(process.env, {
  DATABASE_URL: 'mysql://prueba:prueba@127.0.0.1:1/prueba',
  MONGO_URI: 'mongodb://127.0.0.1:1/prueba',
  REDIS_URL: 'redis://127.0.0.1:1',
  NEO4J_URI: 'bolt://127.0.0.1:1',
  ELASTICSEARCH_URL: 'http://127.0.0.1:1',
  CASSANDRA_CONTACT_POINTS: '127.0.0.1',
  CASSANDRA_PORT: '1',
});

// Express 5 no guarda en la capa el prefijo con el que se montó un sub-router: se anota acá, ANTES de que
// app.js registre nada. (Se resuelve `router` desde express para parchear la misma copia que él usa.)
const Router = require(require.resolve('router', { paths: [path.dirname(require.resolve('express'))] }));
const usoOriginal = Router.prototype.use;
Router.prototype.use = function use(...args) {
  const antes = this.stack.length;
  const resultado = usoOriginal.apply(this, args);
  const primero = args[0];
  let prefijo = '/';
  if (typeof primero === 'string') prefijo = primero;
  else if (primero instanceof RegExp || (Array.isArray(primero) && typeof primero.flat(Infinity)[0] !== 'function')) prefijo = null;
  for (const capa of this.stack.slice(antes)) capa.prefijoDeclarado = prefijo;
  return resultado;
};

// La consulta de «¿cuenta suspendida?» va a Redis; no es lo que se prueba acá. Se reemplaza ANTES de que
// middleware/auth.js la desestructure.
const suspension = require('../src/services/suspensionService');
suspension.exigirCuentaActiva = async () => {};

// requireRole le pregunta a la política (que lee MySQL: el rol de hoy y las reglas que cambió un administrador) y,
// si deniega, a la auditoría (que escribe en Mongo). Ninguna es lo que se prueba acá —tests/permisos*.test.js—:
// la política se reemplaza por la decisión del código, sin reglas, y se anota por qué ruta preguntó cada llamada.
const politica = require('../src/services/politicaAccesoService');
const clavesConsultadas = new Set();
politica.permite = async (usuario, clave, porDefecto) => {
  clavesConsultadas.add(clave);
  return { ...politica.decidir({ reglas: new Map() }, usuario.rol, clave, porDefecto), rol: usuario.rol };
};
require('../src/services/auditoriaAccesoService').registrarDenegacion = () => false;

const app = require('../src/app');
const { RUTAS, ROLES, clave } = require('../src/config/politicaRutas');

function unir(base, ruta) {
  const trozo = ruta === '/' ? '' : ruta;
  const prefijo = base === '/' ? '' : base;
  return `${prefijo}${trozo}` || '/';
}

// Recorre la pila del router en el orden en que Express la ejecuta: un middleware de ámbito de router
// (router.use(requireAuth)) protege solo lo que se registra DESPUÉS de él, y se hereda hacia los sub-routers.
function recorrer(router, base, heredados, salida) {
  const cadenaDelRouter = [...heredados];
  for (const capa of router.stack) {
    if (capa.route) {
      assert.equal(typeof capa.route.path, 'string', 'ruta con un patrón que no es texto: la prueba no la sabe leer');
      const cadena = [...cadenaDelRouter, ...capa.route.stack.map((c) => c.handle)];
      for (const metodo of Object.keys(capa.route.methods)) {
        const m = metodo === '_all' ? 'ALL' : metodo.toUpperCase();
        const ruta = unir(base, capa.route.path);
        salida.push({ metodo: m, ruta, clave: `${m} ${ruta}`, cadena });
      }
    } else if (capa.handle?.stack) {
      assert.notEqual(capa.prefijoDeclarado, undefined, 'un sub-router montado sin que la prueba viera su prefijo');
      assert.notEqual(capa.prefijoDeclarado, null, 'sub-router montado con un patrón que no es texto: la prueba no lo sabe leer');
      recorrer(capa.handle, unir(base, capa.prefijoDeclarado), cadenaDelRouter, salida);
    } else {
      if (capa.handle.acceso) {
        assert.equal(capa.prefijoDeclarado, '/', 'un middleware de acceso montado en un subcamino: la prueba no sabe a qué rutas alcanza');
      }
      cadenaDelRouter.push(capa.handle);
    }
  }
}

function rutasReales() {
  const salida = [];
  recorrer(app.router, '', [], salida);
  return salida;
}

// Para la parte HTTP ningún manejador real debe ejecutarse. Cada manejador SIN etiqueta de acceso (la lógica
// de negocio y los middlewares de pedidos) se reemplaza por un centinela que responde 299; los que sí la tienen
// (requireAuth, requireRole) siguen siendo los reales. Si una ruta deja pasar a quien no debía, la respuesta es
// 299 —y se dice— en vez de tocar una base.
const ESTADO_CENTINELA = 299;
function centinela(req, res) {
  res.status(ESTADO_CENTINELA).json({ llegoAlManejador: true });
}
function aislarManejadores(router) {
  for (const capa of router.stack) {
    if (capa.route) {
      for (const interno of capa.route.stack) if (!interno.handle.acceso) interno.handle = centinela;
    } else if (capa.handle?.stack) {
      aislarManejadores(capa.handle);
    }
  }
}
aislarManejadores(app.router);

// Deriva, de las etiquetas de los middlewares de la cadena, qué exige la ruta.
function accesoReal(cadena) {
  let sesion = false;
  let opcional = false;
  let roles = null;
  let rolesSinSesion = false;
  for (const middleware of cadena) {
    const etiqueta = middleware.acceso;
    if (!etiqueta) continue;
    if (etiqueta.sesion) sesion = true;
    if (etiqueta.sesionOpcional) opcional = true;
    if (etiqueta.roles) {
      if (!sesion) rolesSinSesion = true;
      roles = roles ? roles.filter((r) => etiqueta.roles.includes(r)) : [...etiqueta.roles];
    }
  }
  if (roles) return { acceso: rolesSinSesion ? 'roles-sin-sesion' : 'roles', roles };
  if (sesion) return { acceso: 'sesion' };
  if (opcional) return { acceso: 'opcional' };
  return { acceso: 'publica' };
}

const tokenDe = (rol) => jwt.sign({ id_usuario: 1, rol }, process.env.JWT_SECRET, { expiresIn: '5m' });
const conIds = (ruta) => ruta.replace(/:[A-Za-z]+/g, '1');

// El estado HTTP de la respuesta, ya redactado para el mensaje de la falla.
async function estadoDe(url, opciones) {
  try {
    const { status } = await fetch(url, { ...opciones, signal: AbortSignal.timeout(4000) });
    return status === ESTADO_CENTINELA ? `${status} (llegó hasta el manejador sin que ningún filtro la detuviera)` : status;
  } catch (err) {
    return `sin respuesta en 4 s (${err.name})`;
  }
}

test('lista blanca: toda ruta del router real está declarada en config/politicaRutas.js y no sobra ninguna', () => {
  const reales = rutasReales();
  assert.ok(reales.some((r) => r.clave === 'GET /api/admin/fraude'), 'el recorrido no encontró una ruta conocida: la prueba estaría pasando en vacío');
  assert.ok(reales.some((r) => r.clave === 'POST /api/auth/login'));

  const claves = reales.map((r) => r.clave);
  assert.deepEqual(claves.filter((c, i) => claves.indexOf(c) !== i), [], 'rutas registradas dos veces');

  const declaradas = new Set(RUTAS.map(clave));
  const sinDeclarar = claves.filter((c) => !declaradas.has(c));
  assert.deepEqual(
    sinDeclarar,
    [],
    `Rutas SIN declarar. Una ruta nueva se agrega a src/config/politicaRutas.js con el acceso que exige:\n  ${sinDeclarar.join('\n  ')}`
  );
  const sinRuta = [...declaradas].filter((c) => !claves.includes(c));
  assert.deepEqual(sinRuta, [], `Rutas declaradas que ya no existen en el router:\n  ${sinRuta.join('\n  ')}`);
});

test('lista blanca: el acceso declarado es el que cada ruta exige de verdad', () => {
  const declaradas = new Map(RUTAS.map((r) => [clave(r), r]));
  const diferencias = [];
  for (const real of rutasReales()) {
    const declarada = declaradas.get(real.clave);
    if (!declarada) continue; // lo cubre la prueba anterior
    const exige = accesoReal(real.cadena);
    if (exige.acceso !== declarada.acceso) {
      diferencias.push(`${real.clave}: declara «${declarada.acceso}» pero exige «${exige.acceso}»`);
    } else if (exige.acceso === 'roles') {
      const reales = [...exige.roles].sort().join(',');
      const esperados = [...declarada.roles].sort().join(',');
      if (reales !== esperados) diferencias.push(`${real.clave}: declara roles [${esperados}] pero deja pasar a [${reales}]`);
    }
  }
  assert.deepEqual(diferencias, [], `El acceso real no coincide con la lista blanca:\n  ${diferencias.join('\n  ')}`);
});

test('lista blanca: la lista declarada es coherente (sin duplicados, roles válidos, cada ruta con su nota)', () => {
  const claves = RUTAS.map(clave);
  assert.deepEqual(claves.filter((c, i) => claves.indexOf(c) !== i), [], 'rutas declaradas dos veces');
  for (const r of RUTAS) {
    assert.ok(['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(r.metodo), `${clave(r)}: método desconocido`);
    assert.ok(r.ruta.startsWith('/'), `${clave(r)}: la ruta debe empezar con /`);
    assert.ok(['publica', 'opcional', 'sesion', 'roles'].includes(r.acceso), `${clave(r)}: acceso desconocido «${r.acceso}»`);
    assert.ok(typeof r.nota === 'string' && r.nota.trim().length >= 5, `${clave(r)}: falta la nota que explica la ruta`);
    if (r.acceso === 'roles') {
      assert.ok(Array.isArray(r.roles) && r.roles.length > 0, `${clave(r)}: «roles» sin lista de roles`);
      for (const rol of r.roles) assert.ok(ROLES.includes(rol), `${clave(r)}: rol desconocido «${rol}»`);
    } else {
      assert.equal(r.roles, undefined, `${clave(r)}: solo las rutas «roles» llevan lista de roles`);
    }
    if (r.propios) assert.ok(['sesion', 'roles'].includes(r.acceso), `${clave(r)}: «propios» exige sesión`);
  }
});

test('lista blanca: cada ruta por roles es editable desde la pantalla o explica por qué es fija, y siempre dice su grupo', () => {
  const porRol = RUTAS.filter((r) => r.acceso === 'roles');
  for (const r of porRol) {
    assert.ok(typeof r.grupo === 'string' && r.grupo.length >= 3, `${clave(r)}: falta el grupo con el que se muestra en la matriz`);
    if (r.editable) {
      assert.equal(r.fija, undefined, `${clave(r)}: no puede ser editable y fija a la vez`);
      assert.ok(!r.propios, `${clave(r)}: una ruta que comprueba el dueño no se concede a otros roles: no hay «dueño» que comprobar`);
    } else {
      assert.ok(typeof r.fija === 'string' && r.fija.length >= 20, `${clave(r)}: una ruta fija dice por qué no se puede cambiar`);
    }
    assert.ok(r.roles.includes('administrador'), `${clave(r)}: el administrador conserva todas las rutas por roles`);
  }
  const editables = porRol.filter((r) => r.editable);
  assert.ok(editables.length >= 10 && editables.length < porRol.length, 'la matriz tiene filas editables y filas fijas');
  // Lo que administra los permisos NUNCA es editable: quien lo recibiera podría concederse todo lo demás.
  const deAdministracion = porRol.filter((r) => /^\/api\/admin\/(permisos|roles|usuarios|auditoria)/.test(r.ruta));
  assert.ok(deAdministracion.length >= 10, 'el filtro no encontró las rutas de administración de permisos');
  for (const r of deAdministracion) {
    assert.equal(Boolean(r.editable), false, `${clave(r)}: administrar permisos no se concede`);
    assert.deepEqual(r.roles, ['administrador'], clave(r));
  }
});

test('accesoReal: deriva el acceso de la cadena de middleware, en orden', () => {
  const auth = { acceso: { sesion: true } };
  const opcional = { acceso: { sesionOpcional: true } };
  const admin = { acceso: { roles: ['administrador'] } };
  const vendedores = { acceso: { roles: ['vendedor', 'administrador'] } };
  const otro = () => {};

  assert.deepEqual(accesoReal([otro]), { acceso: 'publica' });
  assert.deepEqual(accesoReal([opcional, otro]), { acceso: 'opcional' });
  assert.deepEqual(accesoReal([auth, otro]), { acceso: 'sesion' });
  assert.deepEqual(accesoReal([auth, admin, otro]), { acceso: 'roles', roles: ['administrador'] });
  assert.deepEqual(accesoReal([auth, vendedores, admin]), { acceso: 'roles', roles: ['administrador'] }, 'dos filtros de rol: pasa quien cumple los dos');
  assert.equal(accesoReal([admin, auth]).acceso, 'roles-sin-sesion', 'requireRole antes de requireAuth no tiene a quién mirar');
  assert.equal(accesoReal([admin]).acceso, 'roles-sin-sesion');
});

test('HTTP: toda ruta con sesión rechaza sin token y con un token inválido (401), antes de llegar a ningún servicio', async (t) => {
  const servidor = http.createServer(app);
  await new Promise((resolver) => servidor.listen(0, '127.0.0.1', resolver));
  t.after(() => {
    servidor.closeAllConnections();
    servidor.close();
  });
  const base = `http://127.0.0.1:${servidor.address().port}`;

  const protegidas = RUTAS.filter((r) => r.acceso === 'sesion' || r.acceso === 'roles');
  assert.ok(protegidas.length >= 30, 'muy pocas rutas protegidas: la lista declarada se vació');
  const fallas = [];
  for (const r of protegidas) {
    const url = base + conIds(r.ruta);
    const sinToken = await estadoDe(url, { method: r.metodo });
    if (sinToken !== 401) fallas.push(`${clave(r)} sin token → ${sinToken} (esperado 401)`);
    const tokenMalo = await estadoDe(url, { method: r.metodo, headers: { Authorization: 'Bearer no-es-un-token' } });
    if (tokenMalo !== 401) fallas.push(`${clave(r)} con token inválido → ${tokenMalo} (esperado 401)`);
  }
  assert.deepEqual(fallas, [], `Rutas con sesión que no la exigen:\n  ${fallas.join('\n  ')}`);
});

test('HTTP: toda ruta por roles rechaza con 403 a cada rol que no está en su lista (la matriz rol × endpoint completa)', async (t) => {
  const servidor = http.createServer(app);
  await new Promise((resolver) => servidor.listen(0, '127.0.0.1', resolver));
  t.after(() => {
    servidor.closeAllConnections();
    servidor.close();
  });
  const base = `http://127.0.0.1:${servidor.address().port}`;

  const porRol = RUTAS.filter((r) => r.acceso === 'roles');
  assert.ok(porRol.length >= 15, 'muy pocas rutas por roles: la lista declarada se vació');
  const fallas = [];
  let comprobaciones = 0;
  for (const r of porRol) {
    const excluidos = [...ROLES.filter((rol) => !r.roles.includes(rol)), 'rol-inexistente'];
    for (const rol of excluidos) {
      const estado = await estadoDe(base + conIds(r.ruta), { method: r.metodo, headers: { Authorization: `Bearer ${tokenDe(rol)}` } });
      comprobaciones++;
      if (estado !== 403) fallas.push(`${clave(r)} como «${rol}» → ${estado} (esperado 403)`);
    }
  }
  assert.ok(comprobaciones >= 30);
  assert.deepEqual(fallas, [], `Rutas por roles que dejan pasar a un rol que no figura en su lista:\n  ${fallas.join('\n  ')}`);

  // La clave con la que requireRole le pregunta a la política sale de cómo se montó cada router; tiene que ser
  // EXACTAMENTE la que declara la lista blanca, o las reglas de la pantalla no encontrarían la ruta.
  const declaradas = porRol.map(clave).sort();
  assert.deepEqual([...clavesConsultadas].sort(), declaradas, 'las claves por las que se consultó la política no son las de la lista blanca');
});
