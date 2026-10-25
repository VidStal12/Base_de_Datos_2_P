const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { cargar, politicaAccesoFalsa, auditoriaAccesoFalsa } = require('./redisHelpers');
const { componenteCaido, esErrorDeAcceso, avisarCredencial, CredencialRechazada, ServicioNoDisponible, MENSAJE_PUBLICO_CREDENCIAL } = require('../src/utils/resiliencia');
const { cuerpoDeError, estadoDeError, responderError, manejarErrores } = require('../src/utils/http');
const { CUENTAS, usuarioDe, variableContrasena, reglas, lineaAcl, archivoAcl, sha256 } = require('../src/config/redisCuentas');

// Control de acceso a Redis (IA/PLAN-ENTREGA-FINAL.md §4.0, §4.2 y §4.3): las cuentas de servicio son una lista
// blanca, cada módulo entra con la suya, y un rechazo de credenciales es un error de configuración —no una
// caída— que apaga con ruido, y no en silencio, los controles de seguridad que dependen de Redis. Contra un
// Redis de verdad lo prueba `npm run verificar:acceso`.

const SRC = path.join(__dirname, '..', 'src');
const SCRIPTS = path.join(__dirname, '..', 'scripts');
const respuestaRedis = (mensaje) => Object.assign(new Error(mensaje), { name: 'ReplyError' });

// Las formas REALES de los errores, capturadas de un Redis 7.4 con ACL (no inventadas).
const RECHAZOS = [
  'WRONGPASS invalid username-password pair or user is disabled.',
  'NOAUTH Authentication required.',
  'NOAUTH HELLO must be called with the client already authenticated, otherwise the HELLO <proto> AUTH <user> <pass> option can be used to authenticate the client and select the RESP protocol version at the same time',
  "NOPERM User rd_carrito has no permissions to run the 'info' command",
  'NOPERM No permissions to access a key',
  "ERR ACL failure in script: User rd_candados_w has no permissions to run the 'get' command script: 3ba1350510d1",
  'ERR ACL failure in script: No permissions to access a key script: 9e3dd3d64dbaee89e64ec01b6f252f471bbfb4aa, on @user_script:1.',
];
const NO_SON_RECHAZOS = [
  'Command timed out',
  'connect ECONNREFUSED 127.0.0.1:6379',
  'Connection is closed.',
  'WRONGTYPE Operation against a key holding the wrong kind of value',
  'ERR value is not an integer or out of range',
  'NOSCRIPT No matching script. Please use EVAL.',
  'Producto no encontrado',
];

// ───────────────────────── 1. Clasificación: un rechazo no es una caída ─────────────────────────

test('esErrorDeAcceso reconoce lo que Redis responde cuando rechaza la credencial o el permiso', () => {
  for (const mensaje of RECHAZOS) {
    assert.equal(esErrorDeAcceso(respuestaRedis(mensaje)), 'redis', mensaje);
    assert.equal(componenteCaido(respuestaRedis(mensaje)), null, `«${mensaje.slice(0, 40)}…» NO es una caída: no hay circuito que abrir ni «se sigue sin él»`);
  }
});

test('esErrorDeAcceso no confunde una caída, un error de datos o un error de negocio con un rechazo', () => {
  for (const mensaje of NO_SON_RECHAZOS) assert.equal(esErrorDeAcceso(new Error(mensaje)), null, mensaje);
  assert.equal(esErrorDeAcceso(new ServicioNoDisponible('redis')), null);
  assert.equal(esErrorDeAcceso(null), null);
  assert.equal(esErrorDeAcceso('NOPERM'), null, 'solo errores, no cadenas sueltas');
});

test('esErrorDeAcceso mira también la causa de un error envuelto, y reconoce el suyo propio', () => {
  const envuelto = new Error('falló la caché', { cause: respuestaRedis('NOPERM No permissions to access a key') });
  assert.equal(esErrorDeAcceso(envuelto), 'redis');
  const propio = new CredencialRechazada('redis', 'rd_carrito', respuestaRedis('WRONGPASS x'));
  assert.equal(esErrorDeAcceso(propio), 'redis');
  assert.equal(propio.status, 500);
  assert.equal(propio.codigo, 'CREDENCIAL_RECHAZADA');
  assert.equal(propio.cuenta, 'rd_carrito');
  assert.equal(componenteCaido(propio), null, 'su texto no puede parecer una caída');
});

// ───────────────────────── 2. Qué ve el cliente ─────────────────────────

test('el cliente nunca ve la cuenta, el comando ni la llave: 500 con un código estable', () => {
  for (const mensaje of RECHAZOS) {
    const err = respuestaRedis(mensaje);
    assert.equal(estadoDeError(err, 404), 500, 'ni el 404 ni el 400 de la ruta: no es «producto inexistente»');
    assert.deepEqual(cuerpoDeError(err), { error: MENSAJE_PUBLICO_CREDENCIAL, codigo: 'CREDENCIAL_RECHAZADA' });
  }
  assert.doesNotMatch(JSON.stringify(cuerpoDeError(respuestaRedis(RECHAZOS[3]))), /rd_|NOPERM|info|redis/i);
});

test('responderError y el manejador global responden 500 CREDENCIAL_RECHAZADA aunque la ruta tuviera otro estado por defecto', (t) => {
  t.mock.method(console, 'error', () => {});
  const res = () => {
    const r = { estado: null, cuerpo: null, headersSent: false };
    r.status = (c) => ((r.estado = c), r);
    r.json = (b) => ((r.cuerpo = b), r);
    return r;
  };
  const err = respuestaRedis('NOPERM No permissions to access a key');

  const a = res();
  responderError(a, err, 404);
  assert.equal(a.estado, 500);
  assert.equal(a.cuerpo.codigo, 'CREDENCIAL_RECHAZADA');

  const b = res();
  manejarErrores(err, { method: 'GET', originalUrl: '/api/x' }, b, () => assert.fail('no debe pasar al siguiente manejador'));
  assert.equal(b.estado, 500);
  assert.equal(b.cuerpo.codigo, 'CREDENCIAL_RECHAZADA', 'no el «Ocurrió un error inesperado» genérico: este error SÍ se puede nombrar');
});

test('el aviso al log sale una vez por cuenta cada 15 s, con la cuenta y el motivo REAL de la base', (t) => {
  const lineas = [];
  t.mock.method(console, 'error', (...args) => lineas.push(args.join(' ')));
  const sinPermiso = (cuenta) => respuestaRedis(`ERR ACL failure in script: User ${cuenta} has no permissions to run the 'incr' command script: 80f798d1, on @user_script:2.`);
  const ahora = 5_000_000;

  assert.equal(avisarCredencial('redis', sinPermiso('rd_prueba_a'), undefined, { ahora }), true);
  assert.equal(avisarCredencial('redis', sinPermiso('rd_prueba_a'), undefined, { ahora: ahora + 5000 }), false, 'la misma cuenta dentro de la ventana: no se repite');
  assert.equal(avisarCredencial('redis', sinPermiso('rd_prueba_b'), undefined, { ahora: ahora + 5000 }), true, 'otra cuenta sí');
  assert.equal(avisarCredencial('redis', sinPermiso('rd_prueba_a'), undefined, { ahora: ahora + 16000 }), true, 'pasada la ventana, otra vez');

  assert.match(lineas[0], /^\[acceso\] redis rechazó a la cuenta del backend rd_prueba_a: ERR ACL failure in script: User rd_prueba_a has no permissions to run the 'incr' command/);
  assert.match(lineas[0], /npm run seguridad:inicializar/, 'dice qué hacer');
  assert.doesNotMatch(lineas[0], /\.\./, 'sin puntuación doble');

  // Con el error propio (CredencialRechazada) el motivo es el de la base que lo causó, no nuestro texto.
  const propio = new CredencialRechazada('redis', 'rd_prueba_c', respuestaRedis('WRONGPASS invalid username-password pair or user is disabled.'));
  assert.equal(avisarCredencial('redis', propio, 'rd_prueba_c', { ahora: ahora + 99000 }), true);
  assert.match(lineas.at(-1), /^\[acceso\] redis rechazó a la cuenta del backend rd_prueba_c: WRONGPASS invalid username-password pair or user is disabled\. Revisá/);
});

// ───────────────────────── 3. La lista blanca de cuentas ─────────────────────────

const PELIGROSOS = ['flushall', 'flushdb', 'keys', 'config', 'acl', 'shutdown', 'debug', 'monitor', 'slaveof', 'replicaof', 'module', 'save', 'bgsave', 'bgrewriteaof', 'client', 'info', 'migrate', 'sort', 'publish', 'subscribe', 'psubscribe', 'script', 'function', 'object'];
const sinAdmin = Object.entries(CUENTAS).filter(([, d]) => !d.todo);

test('el archivo de ACL apaga a `default`, lleva una línea por cuenta y ningún secreto', () => {
  const contrasenas = Object.fromEntries(Object.keys(CUENTAS).map((c) => [c, `${c}-${'x'.repeat(24)}`]));
  const archivo = archivoAcl(contrasenas);
  const lineas = archivo.trimEnd().split('\n');
  assert.equal(lineas[0], 'user default off', 'la cuenta sin contraseña y con todos los permisos queda apagada');
  assert.equal(lineas.length, 1 + Object.keys(CUENTAS).length);
  assert.ok(lineas.every((l) => l.startsWith('user ')), 'Redis no admite comentarios ni líneas sueltas en el archivo de ACL');
  for (const [cuenta, contrasena] of Object.entries(contrasenas)) {
    assert.ok(!archivo.includes(contrasena), `la contraseña de ${cuenta} no está en claro`);
    assert.ok(archivo.includes(`#${sha256(contrasena)}`), `ni falta su hash`);
  }
});

test('cada cuenta de servicio parte de nada: -@all, sin llaves ni canales, y solo los comandos de su módulo', () => {
  for (const [cuenta, d] of sinAdmin) {
    const r = reglas(cuenta);
    assert.deepEqual(r.slice(0, 4), ['on', 'resetkeys', 'resetchannels', '-@all'], cuenta);
    assert.ok(!r.includes('+@all') && !r.includes('allkeys') && !r.includes('allchannels') && !r.includes('~*'), `${cuenta}: nada global`);
    assert.ok(d.comandos.length > 0, cuenta);
    for (const comando of d.comandos) {
      assert.equal(comando, comando.toLowerCase(), `${cuenta}: ${comando} en minúsculas`);
      assert.ok(!PELIGROSOS.includes(comando), `${cuenta} no puede tener ${comando}`);
    }
    assert.ok(r.filter((x) => x.startsWith('+')).length === d.comandos.length, 'solo +comando sueltos, ninguna categoría');
  }
});

test('solo la cuenta de administración tiene todo; el servidor web no la usa (lo comprueba la sección 4)', () => {
  assert.deepEqual(reglas('admin'), ['on', 'allkeys', 'allchannels', '+@all']);
  assert.deepEqual(sinAdmin.map(([c]) => c), Object.keys(CUENTAS).filter((c) => c !== 'admin'));
});

test('SCAN (que lista los nombres de TODAS las llaves) lo tiene una sola cuenta: la de lectura de candados', () => {
  const conScan = sinAdmin.filter(([, d]) => d.comandos.includes('scan')).map(([c]) => c);
  assert.deepEqual(conScan, ['candados_r']);
});

test('cada familia de llaves se ESCRIBE desde una sola cuenta (la lectura de candados es de solo lectura)', () => {
  const escritores = new Map(); // patrón → cuentas que pueden escribirlo
  for (const [cuenta, d] of sinAdmin) {
    for (const regla of d.llaves) {
      const solo = regla.startsWith('%R~');
      const patron = regla.replace(/^%R~|^~/, '');
      assert.match(patron, /^[a-z-]+(:[a-z]+)?:\*$/, `${cuenta}: ${regla} debe ser un prefijo con *, nunca ~*`);
      if (!solo) escritores.set(patron, [...(escritores.get(patron) ?? []), cuenta]);
    }
  }
  for (const [patron, cuentas] of escritores) assert.equal(cuentas.length, 1, `${patron} lo escriben ${cuentas.join(' y ')}`);
  assert.deepEqual(escritores.get('bloqueo:*'), ['candados_w']);
  assert.deepEqual(escritores.get('carrito:*'), ['carrito']);
  assert.deepEqual(escritores.get('actividad:*'), ['actividad']);
});

test('la matriz de pruebas es coherente con las reglas: lo permitido usa un comando y una llave de la cuenta', () => {
  const sinLlave = new Set(['ping', 'scan']);
  for (const [cuenta, d] of sinAdmin) {
    assert.ok(d.pruebas.permitido.length > 0 && d.pruebas.negado.length > 0, `${cuenta}: prueba lo permitido y lo negado`);
    const patrones = d.llaves.map((l) => new RegExp(`^${l.replace(/^%R~|^~/, '').replace('*', '.*')}$`));
    for (const [comando, llave] of d.pruebas.permitido) {
      assert.ok(d.comandos.includes(comando.toLowerCase()), `${cuenta}: ${comando} está en su lista`);
      if (!sinLlave.has(comando.toLowerCase())) assert.ok(patrones.some((p) => p.test(llave)), `${cuenta}: ${llave} es de una familia suya`);
    }
  }
});

test('lineaAcl exige una contraseña de 16 caracteres o más, y archivoAcl una por cuenta', () => {
  assert.throws(() => lineaAcl('carrito', 'corta'), /al menos 16/);
  assert.throws(() => lineaAcl('carrito', undefined), /al menos 16/);
  assert.throws(() => archivoAcl({ carrito: 'x'.repeat(20) }), /Falta la contraseña/);
  assert.equal(usuarioDe('candados_r'), 'rd_candados_r');
  assert.equal(variableContrasena('candados_r'), 'REDIS_CONTRASENA_CANDADOS_R');
});

// ───────────────────────── 4. Cada módulo entra con SU cuenta (revisión estática del código) ─────────────────────────

function archivosJs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? archivosJs(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
}
const sinComentarios = (texto) => texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

// Las llamadas a la `conectar` DE REDIS de un archivo: [{ cuenta (texto del argumento), linea }]
function llamadasARedis(archivo) {
  const texto = sinComentarios(fs.readFileSync(archivo, 'utf8'));
  const llamadas = [];
  const nombres = [];
  const desestructurado = /const\s*\{([^}]*)\}\s*=\s*require\(\s*['"][^'"]*config\/redis['"]\s*\)/.exec(texto);
  if (desestructurado) {
    for (const parte of desestructurado[1].split(',')) {
      const m = /^\s*conectar\s*(?::\s*(\w+))?\s*$/.exec(parte);
      if (m) nombres.push(m[1] ?? 'conectar');
    }
  }
  const modulo = /const\s+(\w+)\s*=\s*require\(\s*['"][^'"]*config\/redis['"]\s*\)/.exec(texto);
  const patrones = [...nombres.map((n) => new RegExp(`(?<![\\w.])${n}\\(([^)]*)\\)`, 'g')), ...(modulo ? [new RegExp(`\\b${modulo[1]}\\.conectar\\(([^)]*)\\)`, 'g')] : [])];
  for (const patron of patrones) {
    for (const m of texto.matchAll(patron)) llamadas.push({ cuenta: m[1].trim(), linea: texto.slice(0, m.index).split('\n').length });
  }
  const usaRedis = Boolean(desestructurado || modulo);
  return { usaRedis, llamadas };
}

test('todo servicio que usa Redis entra con una cuenta CONOCIDA, escrita en el código, y nunca con la de administración', () => {
  const archivos = archivosJs(SRC).filter((f) => !f.endsWith(`${path.sep}config${path.sep}redis.js`));
  const usuarios = archivos.map((f) => [f, llamadasARedis(f)]).filter(([, r]) => r.usaRedis);
  assert.ok(usuarios.filter(([, r]) => r.llamadas.length > 0).length >= 9, 'el recorrido encontró los servicios que usan Redis');
  for (const [archivo, { llamadas }] of usuarios) {
    for (const { cuenta, linea } of llamadas) {
      const donde = `${path.relative(SRC, archivo)}:${linea}`;
      const literal = /^'([a-z_]+)'$/.exec(cuenta);
      assert.ok(literal, `${donde}: conectar(${cuenta}) debe llevar el nombre de la cuenta como texto literal`);
      assert.ok(Object.hasOwn(CUENTAS, literal[1]), `${donde}: «${literal[1]}» no es una cuenta de redisCuentas.js`);
      assert.notEqual(literal[1], 'admin', `${donde}: el servidor web no usa la cuenta de administración`);
    }
  }
});

test('la cuenta de cada servicio es una de las que lo declaran en redisCuentas.js, y toda declaración se cumple', () => {
  const declaradosPor = new Map(); // 'services/cartService' → cuentas que lo declaran
  for (const [cuenta, d] of Object.entries(CUENTAS)) {
    for (const modulo of d.modulos) {
      const m = /^(services\/\w+)/.exec(modulo);
      if (m) declaradosPor.set(m[1], [...(declaradosPor.get(m[1]) ?? []), cuenta]);
    }
  }
  const usadas = new Map(); // 'services/cartService' → cuentas con las que entra
  for (const archivo of archivosJs(path.join(SRC, 'services'))) {
    const { llamadas } = llamadasARedis(archivo);
    if (llamadas.length === 0) continue;
    const clave = `services/${path.basename(archivo, '.js')}`;
    usadas.set(clave, [...new Set(llamadas.map((l) => /^'([a-z_]+)'$/.exec(l.cuenta)?.[1]))].sort());
  }
  for (const [modulo, cuentas] of usadas) {
    assert.deepEqual(cuentas, (declaradosPor.get(modulo) ?? []).sort(), `${modulo}: entra con [${cuentas}] pero redisCuentas.js lo declara en [${declaradosPor.get(modulo) ?? 'ninguna'}]`);
  }
  for (const modulo of declaradosPor.keys()) assert.ok(usadas.has(modulo), `${modulo} está declarado en redisCuentas.js pero no usa Redis`);
});

test('los scripts de mantenimiento piden la cuenta de administración de forma explícita', () => {
  const sueltos = [];
  for (const archivo of archivosJs(SCRIPTS)) {
    const { llamadas } = llamadasARedis(archivo);
    for (const { cuenta, linea } of llamadas) if (cuenta !== "'admin'") sueltos.push(`${path.relative(SCRIPTS, archivo)}:${linea} conectar(${cuenta})`);
  }
  assert.deepEqual(sueltos, []);
});

// ───────────────────────── 5. Los candados: leer con una cuenta, escribir con otra ─────────────────────────

test('candadoRedis lee con la cuenta de solo lectura y escribe con la de escritura', async () => {
  const usadas = [];
  const redis = {
    async pttl() { return -2; },
    async bloquearCuenta() { return 1; },
    async del() { return 1; },
    async scan() { return ['0', ['bloqueo:5']]; },
    pipeline() { const p = { pttl: () => p, exec: async () => [[null, 1000]] }; return p; },
  };
  const { crearCandado } = cargar('../src/services/candadoRedis.js', { '../config/redis': { conectar: (cuenta) => (usadas.push(cuenta), redis) } });
  const candado = crearCandado('bloqueo');
  await candado.estado(5);
  await candado.restantes([5]);
  await candado.usuarios();
  assert.deepEqual([...new Set(usadas)], ['candados_r'], 'la revisión de sesión no puede escribir');
  usadas.length = 0;
  await candado.bloquear(5, 1000);
  await candado.levantar(5);
  assert.deepEqual([...new Set(usadas)], ['candados_w']);
});

// ───────────────────────── 6. Los controles de seguridad fallan CERRADO ante un rechazo, y abierto ante una caída ─────────────────────────

const rechazo = () => respuestaRedis("NOPERM User rd_candados_r has no permissions to run the 'pttl' command");
const caida = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6379'), { code: 'ECONNREFUSED' });

// `registro` recoge lo que el módulo escribe con console.error (el vm tiene su propia consola, muda por defecto).
function suspensionCon(falla, registro = []) {
  const candado = { clave: (id) => `bloqueo:${id}`, estado: async () => { throw falla(); }, usuarios: async () => { throw falla(); } };
  return cargar('../src/services/suspensionService.js', { './candadoRedis': { crearCandado: () => candado } }, {}, { console: { error: (...args) => registro.push(args.join(' ')), log() {} } });
}

test('la revisión de suspensión: una Redis CAÍDA deja pasar (como siempre), una Redis que RECHAZA a la cuenta falla', async () => {
  const caida_ = suspensionCon(caida);
  await caida_.exigirCuentaActiva(5, 'comprador'); // no lanza: sin Redis nadie queda suspendido
  assert.equal((await caida_.estaBloqueada(5)).bloqueada, false);

  const rechazada = suspensionCon(rechazo);
  await assert.rejects(rechazada.exigirCuentaActiva(5, 'comprador'), (err) => esErrorDeAcceso(err) === 'redis');
  await assert.rejects(rechazada.estaBloqueada(5), (err) => esErrorDeAcceso(err) === 'redis');
  await rechazada.exigirCuentaActiva(1, 'administrador'); // un administrador ni se consulta
});

test('el listado de vendedores suspendidos (visibilidad del catálogo) sigue el criterio de fallar abierto, pero ruidoso', async () => {
  const registro = [];
  const suspension = suspensionCon(rechazo, registro);
  assert.equal((await suspension.vendedoresSuspendidos()).size, 0, 'el catálogo no se cae por esto');
  assert.equal(registro.length, 1, 'pero queda dicho');
  assert.match(registro[0], /NOPERM/, 'con el motivo real');
});

test('los límites suaves: una Redis caída no restringe a nadie; una que RECHAZA no los apaga en silencio', async (t) => {
  t.mock.method(console, 'error', () => {});
  const montar = (falla) => {
    const candado = { estado: async () => { throw falla(); } };
    return cargar('../src/services/restriccionService.js', {
      './candadoRedis': { crearCandado: () => candado },
      './suspensionService': { ROLES_EXENTOS: new Set(['administrador']) },
    }, {});
  };
  assert.equal(await montar(caida).limitesDe(5, 'comprador'), null);
  await assert.rejects(montar(rechazo).limitesDe(5, 'comprador'), (err) => esErrorDeAcceso(err) === 'redis');
});

async function pedirControl({ reservar, limitesDe = async () => null }) {
  const { controlPedidos } = cargar('../src/middleware/controlPedidos.js', {
    '../services/limitePedidosService': { configuracion: () => ({ porHora: 5 }), reservar, liberar: async () => {} },
    '../services/restriccionService': { limitesDe },
    '../services/reautenticacionService': { verificarContrasena: async () => ({ ok: true }) },
  });
  const res = { on() { return res; }, status() { return res; }, json() { return res; }, set() { return res; } };
  const resultado = {};
  await controlPedidos({ usuario: { id_usuario: 5, rol: 'comprador' }, body: {} }, res, (err) => { resultado.siguiente = true; resultado.error = err; });
  return resultado;
}

test('el tope de pedidos por hora: caída → el pedido pasa; rechazo → el pedido falla con el error (500 CREDENCIAL_RECHAZADA)', async (t) => {
  t.mock.method(console, 'error', () => {});
  assert.deepEqual(await pedirControl({ reservar: async () => { throw caida(); } }), { siguiente: true, error: undefined });
  const rechazado = await pedirControl({ reservar: async () => { throw rechazo(); } });
  assert.equal(rechazado.siguiente, true);
  assert.equal(esErrorDeAcceso(rechazado.error), 'redis', 'next(err): lo recoge el manejador global y responde 500');
});

test('si los límites suaves rechazan a la cuenta, el pedido falla; no se compra sin tope ni contraseña', async () => {
  const resultado = await pedirControl({ reservar: async () => ({ admitido: true }), limitesDe: async () => { throw rechazo(); } });
  assert.equal(esErrorDeAcceso(resultado.error), 'redis');
});

test('el contador de intentos de contraseña: sin Redis se verifica igual; si Redis rechaza a la cuenta, no se verifica sin contador', async (t) => {
  t.mock.method(console, 'error', () => {});
  const montar = (falla) => cargar('../src/services/reautenticacionService.js', {
    bcryptjs: { compare: async () => true },
    '../config/prisma': { usuarios: { findUnique: async () => ({ contrasena: 'hash' }) } },
    '../config/redis': { conectar: () => ({ reservarCupo: async () => { throw falla(); }, del: async () => { throw falla(); } }) },
  });
  assert.equal((await montar(caida).verificarContrasena(5, 'Password123!')).ok, true);
  await assert.rejects(montar(rechazo).verificarContrasena(5, 'Password123!'), (err) => esErrorDeAcceso(err) === 'redis');
});

function authCon(falla) {
  process.env.JWT_SECRET ??= 'secreto-de-prueba';
  const entorno = { JWT_SECRET: 'secreto-de-prueba-redis' };
  return {
    entorno,
    ...cargar('../src/middleware/auth.js', {
      '../services/suspensionService': { CODIGO_CUENTA_SUSPENDIDA: 'CUENTA_SUSPENDIDA', exigirCuentaActiva: async () => { throw falla(); } },
      '../services/politicaAccesoService': politicaAccesoFalsa(), '../services/auditoriaAccesoService': auditoriaAccesoFalsa(),
    }, entorno),
  };
}

test('requireAuth: si no se puede comprobar la suspensión por una credencial rechazada, la petición FALLA (no entra ni se da por suspendida)', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { requireAuth, entorno } = authCon(rechazo);
  const token = jwt.sign({ id_usuario: 5, rol: 'comprador' }, entorno.JWT_SECRET);
  const resultado = {};
  const res = { status() { assert.fail('no debe responder 401 ni 403: no es culpa de la persona'); } };
  await requireAuth({ headers: { authorization: `Bearer ${token}` } }, res, (err) => { resultado.error = err; resultado.siguio = true; });
  assert.equal(resultado.siguio, true);
  assert.equal(esErrorDeAcceso(resultado.error), 'redis', 'next(err) → 500 CREDENCIAL_RECHAZADA');
});

test('optionalAuth: con la comprobación rechazada la persona queda como ANÓNIMA, nunca como sesión sin revisar', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { optionalAuth, entorno } = authCon(rechazo);
  const token = jwt.sign({ id_usuario: 5, rol: 'comprador' }, entorno.JWT_SECRET);
  const req = { headers: { authorization: `Bearer ${token}` } };
  let siguio = false;
  await optionalAuth(req, {}, () => { siguio = true; });
  assert.equal(siguio, true);
  assert.equal(req.usuario, undefined);
});
