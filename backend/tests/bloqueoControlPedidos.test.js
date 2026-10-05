const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { cargar } = require('./redisHelpers');
const { redisBloqueos } = require('./bloqueoHelpers');

// Control de un pedido ANTES de que se complete (middleware/controlPedidos.js): el tope
// de pedidos por hora y los límites suaves de una cuenta bajo revisión (tope de monto,
// menos pedidos por hora y contraseña en cada pedido). Con el Lua simulado en memoria;
// contra un Redis de verdad lo prueba scripts/verificarRespuestaEscalonada.js.

const HASH = bcrypt.hashSync('Password123!', 4);

function escenario({ entorno = {}, restringidas = [] } = {}) {
  const redis = redisBloqueos();
  const candadoRedis = cargar('../src/services/candadoRedis.js', { '../config/redis': { conectar: () => redis } });
  const suspension = cargar('../src/services/suspensionService.js', { './candadoRedis': candadoRedis });
  const restriccion = cargar('../src/services/restriccionService.js', { './candadoRedis': candadoRedis, './suspensionService': suspension }, entorno);
  const limite = cargar('../src/services/limitePedidosService.js', { '../config/redis': { conectar: () => redis } }, entorno);
  const reautenticacion = cargar('../src/services/reautenticacionService.js', {
    '../config/prisma': { usuarios: { findUnique: async ({ where }) => (where.id_usuario === 404 ? null : { contrasena: HASH }) } },
    '../config/redis': { conectar: () => redis },
  });
  const { controlPedidos } = cargar('../src/middleware/controlPedidos.js', {
    '../services/limitePedidosService': limite,
    '../services/restriccionService': restriccion,
    '../services/reautenticacionService': reautenticacion,
  });
  const ponerRestriccion = (id) => restriccion.candado.bloquear(id, 3600000);
  return { redis, controlPedidos, limite, ponerRestriccion, restringidas };
}

const peticion = (id, { rol = 'comprador', body = {} } = {}) => ({ usuario: { id_usuario: id, rol }, body });
function respuesta() {
  const r = { codigo: null, cuerpo: null, cabeceras: {}, statusCode: 200, alTerminar: [] };
  r.status = (c) => {
    r.codigo = c;
    r.statusCode = c;
    return r;
  };
  r.set = (nombre, valor) => {
    r.cabeceras[nombre] = valor;
    return r;
  };
  r.json = (b) => {
    r.cuerpo = b;
    return r;
  };
  r.on = (evento, fn) => {
    if (evento === 'finish') r.alTerminar.push(fn);
    return r;
  };
  // Lo que hace Express al terminar la respuesta de la ruta.
  r.terminar = async (status) => {
    r.statusCode = status;
    for (const fn of r.alTerminar) fn();
    await new Promise((resolve) => setImmediate(resolve));
  };
  return r;
}

// Corre el middleware: devuelve la respuesta y si dejó pasar la petición.
async function pedir(controlPedidos, req) {
  const res = respuesta();
  let paso = false;
  await controlPedidos(req, res, (err) => {
    assert.equal(err, undefined, 'next() no debe recibir un error');
    paso = true;
  });
  return { res, paso, req };
}

test('el tope de pedidos por hora rechaza el siguiente ANTES de que se complete, con cuánto falta', async () => {
  const e = escenario({ entorno: { LIMITE_PEDIDOS_HORA: '3' } });
  for (let i = 0; i < 3; i += 1) assert.equal((await pedir(e.controlPedidos, peticion(1))).paso, true, `el pedido ${i + 1} pasa`);

  const cuarto = await pedir(e.controlPedidos, peticion(1));
  assert.equal(cuarto.paso, false);
  assert.equal(cuarto.res.codigo, 429);
  assert.equal(cuarto.res.cuerpo.codigo, 'LIMITE_PEDIDOS');
  assert.match(cuarto.res.cuerpo.error, /máximo de 3 pedidos por hora/);
  assert.ok(cuarto.res.cuerpo.reintentarEnSegundos > 3500 && cuarto.res.cuerpo.reintentarEnSegundos <= 3600);
  assert.equal(cuarto.res.cabeceras['Retry-After'], String(cuarto.res.cuerpo.reintentarEnSegundos));

  // El tope es por cuenta: otra cuenta no lo siente.
  assert.equal((await pedir(e.controlPedidos, peticion(2))).paso, true);
  // Y la ventana se cierra sola: pasada la hora, vuelve a pasar.
  e.redis.avanzar(3601 * 1000);
  assert.equal((await pedir(e.controlPedidos, peticion(1))).paso, true);
});

test('un pedido que termina en error devuelve su cupo; uno que se completa lo conserva', async () => {
  const e = escenario({ entorno: { LIMITE_PEDIDOS_HORA: '2' } });
  const a = await pedir(e.controlPedidos, peticion(1));
  await a.res.terminar(409); // sin stock, o el precio cambió: no se completó
  const b = await pedir(e.controlPedidos, peticion(1));
  await b.res.terminar(201); // completado
  const c = await pedir(e.controlPedidos, peticion(1));
  await c.res.terminar(201); // completado
  // Dos completados: el tercero ya no pasa, aunque uno de los intentos anteriores falló.
  assert.equal((await pedir(e.controlPedidos, peticion(1))).paso, false);
});

test('con pedidos simultáneos pasan exactamente `límite`, ni uno más', async () => {
  const e = escenario({ entorno: { LIMITE_PEDIDOS_HORA: '4' } });
  const resultados = await Promise.all(Array.from({ length: 12 }, () => pedir(e.controlPedidos, peticion(7))));
  assert.equal(resultados.filter((r) => r.paso).length, 4);
  assert.equal(resultados.filter((r) => r.res.codigo === 429).length, 8);
});

test('sin tope (LIMITE_PEDIDOS_HORA=0) o con una configuración inválida o Redis caído, no se frena a nadie', async () => {
  const sinTope = escenario({ entorno: { LIMITE_PEDIDOS_HORA: '0' } });
  for (let i = 0; i < 20; i += 1) assert.equal((await pedir(sinTope.controlPedidos, peticion(1))).paso, true);

  const invalido = escenario({ entorno: { LIMITE_PEDIDOS_HORA: 'muchos' } });
  assert.equal((await pedir(invalido.controlPedidos, peticion(1))).paso, true);

  const caido = escenario({ entorno: { LIMITE_PEDIDOS_HORA: '1' } });
  caido.redis.reservarCupo = async () => {
    throw new Error('Redis caído');
  };
  assert.equal((await pedir(caido.controlPedidos, peticion(1))).paso, true);
  assert.equal((await pedir(caido.controlPedidos, peticion(1))).paso, true);
});

test('una cuenta bajo revisión necesita su contraseña en cada pedido, y un intento fallido no gasta un pedido', async () => {
  const e = escenario({ entorno: { LIMITE_PEDIDOS_HORA: '5' } });
  await e.ponerRestriccion(1);

  const sin = await pedir(e.controlPedidos, peticion(1));
  assert.equal(sin.paso, false);
  assert.equal(sin.res.codigo, 403);
  assert.equal(sin.res.cuerpo.codigo, 'REQUIERE_CONTRASENA');
  assert.equal((await pedir(e.controlPedidos, peticion(1, { body: { contrasena: '' } }))).res.cuerpo.codigo, 'REQUIERE_CONTRASENA');
  assert.equal((await pedir(e.controlPedidos, peticion(1, { body: { contrasena: 12345 } }))).res.cuerpo.codigo, 'REQUIERE_CONTRASENA', 'solo cuenta un texto');

  const mala = await pedir(e.controlPedidos, peticion(1, { body: { contrasena: 'incorrecta' } }));
  assert.equal(mala.res.codigo, 403);
  assert.equal(mala.res.cuerpo.codigo, 'CONTRASENA_INCORRECTA');

  const buena = await pedir(e.controlPedidos, peticion(1, { body: { contrasena: 'Password123!' } }));
  assert.equal(buena.paso, true);
  assert.equal(buena.req.limitesPedido.montoMaximo, 500, 'el tope de monto queda para que el servicio lo haga cumplir');

  // Una cuenta sin restricción no pasa por esto: ni contraseña ni tope de monto.
  const libre = await pedir(e.controlPedidos, peticion(2));
  assert.equal(libre.paso, true);
  assert.equal(libre.req.limitesPedido, undefined);
});

test('los intentos de contraseña también tienen cupo: no se puede adivinar por el endpoint de compra', async () => {
  const e = escenario({ entorno: { LIMITE_PEDIDOS_HORA: '0', RESTRICCION_PEDIDOS_HORA: '0' } }); // solo los intentos de contraseña cuentan acá
  await e.ponerRestriccion(1);
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await pedir(e.controlPedidos, peticion(1, { body: { contrasena: `mal${i}` } }))).res.cuerpo.codigo, 'CONTRASENA_INCORRECTA');
  }
  const sexto = await pedir(e.controlPedidos, peticion(1, { body: { contrasena: 'Password123!' } }));
  assert.equal(sexto.paso, false, 'ni siquiera la correcta, hasta que cierre la ventana');
  assert.equal(sexto.res.codigo, 429);
  assert.equal(sexto.res.cuerpo.codigo, 'DEMASIADOS_INTENTOS');
  assert.ok(sexto.res.cuerpo.reintentarEnSegundos > 0 && sexto.res.cuerpo.reintentarEnSegundos <= 900);
  assert.ok(sexto.res.cabeceras['Retry-After']);

  // Y un acierto borra el contador: quien sabe su contraseña no acumula intentos.
  const otra = escenario({ entorno: { LIMITE_PEDIDOS_HORA: '0', RESTRICCION_PEDIDOS_HORA: '0' } });
  await otra.ponerRestriccion(1);
  for (let i = 0; i < 4; i += 1) {
    await pedir(otra.controlPedidos, peticion(1, { body: { contrasena: 'mal' } }));
    assert.equal((await pedir(otra.controlPedidos, peticion(1, { body: { contrasena: 'Password123!' } }))).paso, true);
  }
});

test('una cuenta bajo revisión tiene menos pedidos por hora: rige el menor entre el tope general y el suyo', async () => {
  const e = escenario({ entorno: { LIMITE_PEDIDOS_HORA: '5', RESTRICCION_PEDIDOS_HORA: '2' } });
  await e.ponerRestriccion(1);
  const conClave = { body: { contrasena: 'Password123!' } };
  assert.equal((await pedir(e.controlPedidos, peticion(1, conClave))).paso, true);
  assert.equal((await pedir(e.controlPedidos, peticion(1, conClave))).paso, true);
  const tercero = await pedir(e.controlPedidos, peticion(1, conClave));
  assert.equal(tercero.res.cuerpo.codigo, 'LIMITE_PEDIDOS');
  assert.match(tercero.res.cuerpo.error, /máximo de 2 pedidos por hora \(tu cuenta está en revisión\)/);

  // Sin tope general, el de la restricción rige igual; sin el de la restricción, el general.
  const soloRestriccion = escenario({ entorno: { LIMITE_PEDIDOS_HORA: '0', RESTRICCION_PEDIDOS_HORA: '1' } });
  await soloRestriccion.ponerRestriccion(1);
  await pedir(soloRestriccion.controlPedidos, peticion(1, conClave));
  assert.equal((await pedir(soloRestriccion.controlPedidos, peticion(1, conClave))).res.cuerpo.codigo, 'LIMITE_PEDIDOS');
  const soloGeneral = escenario({ entorno: { LIMITE_PEDIDOS_HORA: '3', RESTRICCION_PEDIDOS_HORA: '0' } });
  await soloGeneral.ponerRestriccion(1);
  for (let i = 0; i < 3; i += 1) assert.equal((await pedir(soloGeneral.controlPedidos, peticion(1, conClave))).paso, true);
  assert.equal((await pedir(soloGeneral.controlPedidos, peticion(1, conClave))).res.cuerpo.codigo, 'LIMITE_PEDIDOS');
});

test('un administrador no tiene límites suaves (pero sí el tope general), y apagarlos los desactiva', async () => {
  const e = escenario({ entorno: { LIMITE_PEDIDOS_HORA: '2' } });
  await e.ponerRestriccion(9); // aunque exista el candado
  const admin = await pedir(e.controlPedidos, peticion(9, { rol: 'administrador' }));
  assert.equal(admin.paso, true, 'sin contraseña');
  assert.equal(admin.req.limitesPedido, undefined);
  await pedir(e.controlPedidos, peticion(9, { rol: 'administrador' }));
  assert.equal((await pedir(e.controlPedidos, peticion(9, { rol: 'administrador' }))).res.cuerpo.codigo, 'LIMITE_PEDIDOS', 'el tope general también rige para un administrador');

  const apagado = escenario({ entorno: { RESTRICCION_ENABLED: 'false', LIMITE_PEDIDOS_HORA: '0' } });
  await apagado.ponerRestriccion(1);
  const libre = await pedir(apagado.controlPedidos, peticion(1));
  assert.equal(libre.paso, true, 'con los límites suaves apagados, ni contraseña ni tope');
  assert.equal(libre.req.limitesPedido, undefined);
});

test('una contraseña de una cuenta que ya no existe no pasa', async () => {
  const e = escenario({ entorno: { LIMITE_PEDIDOS_HORA: '0' } });
  await e.ponerRestriccion(404);
  const r = await pedir(e.controlPedidos, peticion(404, { body: { contrasena: 'Password123!' } }));
  assert.equal(r.paso, false);
  assert.equal(r.res.cuerpo.codigo, 'CONTRASENA_INCORRECTA');
});
