const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ServicioNoDisponible, CODIGO_NO_DISPONIBLE, componenteCaido, crearCircuito, descripcionDe, avisarCaida, avisarRecuperacion, registrarFallo,
} = require('../src/utils/resiliencia');
const { cuerpoDeError, estadoDeError, responderError, manejarErrores } = require('../src/utils/http');

// El núcleo de la degradación elegante (IA/ENTREGA-3-CONSISTENCIA.md §7): reconocer que
// «una base no responde» venga del driver que venga, y fallar rápido en vez de esperar el
// timeout en cada petición. Los errores de abajo tienen la forma de los que lanzaron los
// drivers REALES con su contenedor detenido (capturados el 2026-10-19): no son inventados.

function error(nombre, mensaje, extra = {}) {
  const err = new Error(mensaje);
  err.name = nombre;
  return Object.assign(err, extra);
}

test('reconoce el fallo de cada base con el error real de su driver', () => {
  const casos = [
    // Prisma + adaptador MariaDB (MySQL apagado, con el pool de conexiones ya abierto)
    [error('PrismaClientKnownRequestError', 'Transaction API error: Unable to start a transaction in the given time.', { code: 'P2028' }), 'mysql'],
    [error('PrismaClientKnownRequestError', ' Invalid `prisma.$queryRaw()` invocation: Raw query failed. Message: `pool timeout: failed to retrieve a connection from pool after 10011ms`', { code: 'P2010' }), 'mysql'],
    [error('PrismaClientInitializationError', "Can't reach database server at `localhost:3306`"), 'mysql'],
    // Mongoose / driver de MongoDB
    [error('MongooseServerSelectionError', 'connect ECONNREFUSED ::1:27018, connect ECONNREFUSED 127.0.0.1:27018'), 'mongo'],
    [error('MongoServerSelectionError', 'connect ECONNREFUSED ::1:27018'), 'mongo'],
    [error('MongooseError', 'Operation `productos.find()` buffering timed out after 10000ms'), 'mongo'],
    // ioredis
    [error('MaxRetriesPerRequestError', 'Reached the max retries per request limit (which is 20).'), 'redis'],
    [error('Error', 'Command timed out'), 'redis'],
    // neo4j-driver
    [error('Neo4jError', 'Failed to connect to server. Please ensure that your database is listening', { code: 'ServiceUnavailable' }), 'neo4j'],
    // cassandra-driver
    [error('NoHostAvailableError', 'All host(s) tried for query failed. First host tried, 127.0.0.1:9042: Error: connect ECONNREFUSED'), 'cassandra'],
    // @elastic/elasticsearch
    [error('ConnectionError', 'connect ECONNREFUSED 127.0.0.1:9200'), 'elasticsearch'],
    [error('NoLivingConnectionsError', 'There are no living connections'), 'elasticsearch'],
  ];
  for (const [err, componente] of casos) {
    assert.equal(componenteCaido(err), componente, `${err.name}: ${err.message.slice(0, 50)}`);
  }
});

test('un errno de red sin más pistas es una caída de componente desconocido, también dentro de una causa', () => {
  assert.equal(componenteCaido(error('Error', 'connect ECONNREFUSED 127.0.0.1:1', { code: 'ECONNREFUSED' })), 'desconocido');
  assert.equal(componenteCaido(error('Error', 'algo falló', { cause: error('Error', 'read ECONNRESET', { code: 'ECONNRESET' }) })), 'desconocido');
});

test('lo que NO es una caída no se confunde con una: validaciones, 404, 409 y errores propios', () => {
  assert.equal(componenteCaido(new Error('La descripción es obligatoria')), null);
  assert.equal(componenteCaido(Object.assign(new Error('Producto no encontrado'), { status: 404 })), null);
  assert.equal(componenteCaido(Object.assign(new Error('Stock insuficiente'), { status: 409 })), null);
  assert.equal(componenteCaido(error('PrismaClientKnownRequestError', 'Unique constraint failed on the fields: (`correo`)', { code: 'P2002' })), null, 'una clave duplicada significa que MySQL SÍ respondió');
  assert.equal(componenteCaido(null), null);
  assert.equal(componenteCaido('texto'), null);
});

test('ServicioNoDisponible dice qué falta, lleva 503 y un código estable, y admite un mensaje propio', () => {
  const normal = new ServicioNoDisponible('redis', new Error('causa'));
  assert.equal(normal.status, 503);
  assert.equal(normal.codigo, CODIGO_NO_DISPONIBLE);
  assert.equal(normal.componente, 'redis');
  assert.match(normal.message, /Redis/);
  assert.equal(normal.cause.message, 'causa');
  assert.equal(componenteCaido(normal), 'redis', 'se reconoce a sí mismo');

  assert.match(new ServicioNoDisponible(undefined).message, /servicio del que depende/);
  assert.equal(new ServicioNoDisponible('redis', null, 'Las ofertas flash necesitan Redis').message, 'Las ofertas flash necesitan Redis');
});

// ── Cortacircuitos ──────────────────────────────────────────────────────────

function reloj() {
  const estado = { t: 1000 };
  return { ahora: () => estado.t, avanzar: (ms) => { estado.t += ms; } };
}

test('la primera falla de conexión abre el circuito: las siguientes llamadas fallan al instante sin tocar la base', async () => {
  const r = reloj();
  const circuito = crearCircuito('neo4j', { aperturaMs: 5000, ahora: r.ahora });
  let llamadas = 0;
  const caida = () => { llamadas += 1; throw error('Neo4jError', 'Failed to connect', { code: 'ServiceUnavailable' }); };

  await assert.rejects(circuito.ejecutar(caida), (e) => e instanceof ServicioNoDisponible && e.componente === 'neo4j');
  assert.equal(llamadas, 1);
  assert.equal(circuito.abierto(), true);

  r.avanzar(3000);
  await assert.rejects(circuito.ejecutar(caida), (e) => e instanceof ServicioNoDisponible);
  assert.equal(llamadas, 1, 'con el circuito abierto la operación ni se intenta');
});

test('pasado el tiempo se deja pasar una prueba: si responde, el circuito se cierra; si falla, vuelve a abrirse', async () => {
  const r = reloj();
  const circuito = crearCircuito('cassandra', { aperturaMs: 5000, ahora: r.ahora });
  await assert.rejects(circuito.ejecutar(async () => { throw error('NoHostAvailableError', 'All host(s) tried for query failed'); }));

  r.avanzar(5001);
  await assert.rejects(circuito.ejecutar(async () => { throw error('NoHostAvailableError', 'All host(s) tried for query failed'); }));
  assert.equal(circuito.abierto(), true, 'la prueba falló: otra ventana cerrada');

  r.avanzar(5001);
  assert.equal(await circuito.ejecutar(async () => 'ok'), 'ok');
  assert.equal(circuito.abierto(), false);
  assert.equal(await circuito.ejecutar(async () => 'otra'), 'otra', 'y sigue pasando todo');
});

test('un error de la consulta (no de la conexión) no abre el circuito', async () => {
  const r = reloj();
  const circuito = crearCircuito('elasticsearch', { ahora: r.ahora });
  const rechazo = Object.assign(error('ResponseError', 'parsing_exception'), { statusCode: 400 });
  await assert.rejects(circuito.ejecutar(async () => { throw rechazo; }), (e) => e === rechazo, 'el error original llega intacto');
  assert.equal(circuito.abierto(), false);
});

test('los avisos de caída se limitan a uno por componente cada 15 s, y la recuperación se anota una sola vez', () => {
  const lineas = [];
  const original = { error: console.error, log: console.log };
  console.error = (...a) => lineas.push(['error', a.join(' ')]);
  console.log = (...a) => lineas.push(['log', a.join(' ')]);
  try {
    assert.equal(avisarCaida('prueba-x', new Error('se cayó'), { ahora: 100000 }), true);
    assert.equal(avisarCaida('prueba-x', new Error('se cayó'), { ahora: 105000 }), false, 'dentro de la ventana: sin línea nueva');
    assert.equal(avisarCaida('prueba-y', new Error('otra'), { ahora: 105000 }), true, 'cada componente tiene su propia ventana');
    assert.equal(avisarCaida('prueba-x', new Error('se cayó'), { ahora: 116000 }), true);
    assert.equal(avisarRecuperacion('prueba-x'), true);
    assert.equal(avisarRecuperacion('prueba-x'), false, 'ya estaba anotada');
    assert.equal(avisarRecuperacion('nunca-cayo'), false, 'no se anuncia la recuperación de lo que no se avisó caído');
  } finally {
    console.error = original.error;
    console.log = original.log;
  }
  assert.equal(lineas.filter(([tipo]) => tipo === 'error').length, 3);
  assert.match(lineas.find(([tipo]) => tipo === 'log')[1], /prueba-x volvió a responder/);
});

// ── Respuestas HTTP ─────────────────────────────────────────────────────────

function respuestaFalsa() {
  const r = { enviada: false };
  r.status = (codigo) => { r.codigo = codigo; return r; };
  r.json = (cuerpo) => { r.cuerpo = cuerpo; r.enviada = true; return r; };
  return r;
}

test('una base caída responde 503 con el componente y SIN las rutas ni los nombres internos del driver', () => {
  const cruda = error('PrismaClientKnownRequestError',
    'Invalid `prisma.usuarios.findUnique()` invocation in C:\\Users\\alguien\\backend\\src\\services\\authService.js:73:48\n\nCan\'t reach database server', { code: 'P1001' });
  assert.equal(estadoDeError(cruda, 401), 503, 'ni 401 (credenciales) ni 404 ni 500: una caída es una caída');
  const cuerpo = cuerpoDeError(cruda);
  assert.equal(cuerpo.codigo, CODIGO_NO_DISPONIBLE);
  assert.equal(cuerpo.componente, 'mysql');
  assert.doesNotMatch(cuerpo.error, /C:\\|prisma\.|invocation/);

  const res = respuestaFalsa();
  responderError(res, cruda, 400);
  assert.equal(res.codigo, 503);
  assert.equal(res.cuerpo.componente, 'mysql');
});

test('el resto de los errores conserva su estado, su mensaje y su código', () => {
  const rechazo = Object.assign(new Error('Como vendedor tenés que aceptar el compromiso'), { status: 400, codigo: 'COMPROMISO_NO_REVENTA' });
  assert.equal(estadoDeError(rechazo, 503), 400);
  assert.deepEqual({ ...cuerpoDeError(rechazo) }, { error: 'Como vendedor tenés que aceptar el compromiso', codigo: 'COMPROMISO_NO_REVENTA' });
  assert.equal(estadoDeError(new Error('La descripción es obligatoria'), 400), 400, 'sin estado propio, el de la ruta');
  assert.deepEqual({ ...cuerpoDeError(new Error('La descripción es obligatoria')) }, { error: 'La descripción es obligatoria' });
});

test('el manejador global no deja pasar la traza: 503 para una caída, 500 genérico para un bug', () => {
  const caida = respuestaFalsa();
  manejarErrores(new ServicioNoDisponible('mongo'), { method: 'GET', originalUrl: '/api/x' }, caida, () => assert.fail('no debe delegar'));
  assert.equal(caida.codigo, 503);
  assert.equal(caida.cuerpo.componente, 'mongo');

  const original = console.error;
  const registro = [];
  console.error = (...a) => registro.push(a.join(' '));
  try {
    const bug = respuestaFalsa();
    manejarErrores(new TypeError('Cannot read properties of undefined (reading \'x\')'), { method: 'GET', originalUrl: '/api/y' }, bug, () => {});
    assert.equal(bug.codigo, 500);
    assert.doesNotMatch(bug.cuerpo.error, /undefined|reading/);
    assert.match(registro[0], /GET \/api\/y/, 'el detalle queda en el log del servidor');
  } finally {
    console.error = original;
  }

  const yaEnviada = { headersSent: true };
  let delegado = null;
  manejarErrores(new Error('tarde'), {}, yaEnviada, (err) => { delegado = err; });
  assert.equal(delegado.message, 'tarde', 'si la respuesta ya salió, se delega a Express');
});

// ── Registros legibles ──────────────────────────────────────────────────────

test('descripcionDe deja una línea legible: sin la ruta del archivo de Prisma, y con el errno de un AggregateError', () => {
  const prisma = new Error(
    '\nInvalid `prisma.checkout_intento.findMany()` invocation in\nC:\Users\alguien\backend\src\services\checkoutIntentoService.js:166:54\n\n' +
    '  163 if (ejecucion) return ejecucion;\n→ 166   const pendientes = await prisma.checkout_intento.findMany(\n' +
    'Database error. Code: `45028`. Message: `pool timeout: failed to retrieve a connection from pool after 2508ms`'
  );
  const linea = descripcionDe(prisma);
  assert.match(linea, /pool timeout/);
  assert.doesNotMatch(linea, /C:\|invocation|\.js:/);

  // Node 20+: connect ECONNREFUSED ::1 y 127.0.0.1 llega con el mensaje vacío; el dato está en `code`
  const agregado = Object.assign(new Error(''), { name: 'AggregateError', code: 'ECONNREFUSED' });
  assert.equal(descripcionDe(agregado), 'ECONNREFUSED');
  assert.equal(descripcionDe(new Error('')), 'sin detalle');
  assert.equal(descripcionDe(undefined), 'sin detalle');
});

test('registrarFallo: una base apagada es UNA línea cada 15 s; cualquier otro error se muestra entero', () => {
  const lineas = [];
  const original = console.error;
  console.error = (...a) => lineas.push(a.join(' '));
  try {
    const caida = error('MaxRetriesPerRequestError', 'Reached the max retries per request limit (which is 20).');
    registrarFallo('Sincronización de ventas', caida);
    registrarFallo('Sincronización de ventas', caida);
    registrarFallo('Sincronización de ventas', caida);
    assert.equal(lineas.length, 1, 'tres vueltas del temporizador, una sola línea');
    assert.match(lineas[0], /^\[resiliencia\] redis no responde/);

    registrarFallo('Sincronización de ventas', new TypeError('x is not a function'));
    registrarFallo('Sincronización de ventas', new TypeError('x is not a function'));
    assert.equal(lineas.length, 3, 'un bug no se silencia: aparece cada vez, con su contexto');
    assert.match(lineas[2], /Sincronización de ventas: x is not a function/);
  } finally {
    console.error = original;
  }
});
