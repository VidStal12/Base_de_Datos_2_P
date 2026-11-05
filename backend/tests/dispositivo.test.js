const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { cargar } = require('./redisHelpers');

// Antifraude por dispositivo (IA/PLAN-NEO4J-DETECCION-FRAUDE.md §22) sin ninguna conexión: lo que el servidor acepta de
// las cabeceras, cómo se calculan los hash (el identificador en claro nunca se guarda), cómo se registra un inicio de sesión
// con MySQL y Neo4j de mentira, y lo que genera el navegador (frontend/src/utils/dispositivo.js). Que el grafo agrupe y
// califique de verdad lo comprueba, contra las bases reales, `npm run verificar:fraude`.
const plano = (valor) => JSON.parse(JSON.stringify(valor));
const UUID = '3f2b8c1e-7a64-4d0e-9b55-1c2d3e4f5a6b';
const CHROME_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function servicio({ upsert, update, registrarDispositivo, filas = [] } = {}) {
  const llamadas = { upsert: [], update: [], grafo: [], find: [] };
  const modulo = cargar('../src/services/dispositivoService.js', {
    '../config/prisma': {
      dispositivo_usuario: {
        upsert: async (args) => { llamadas.upsert.push(args); return upsert ? upsert(args) : { perfil_hash: args.create.perfil_hash, primera_vez: args.create.primera_vez, ultima_vez: args.create.ultima_vez, inicios: 1 }; },
        update: async (args) => { llamadas.update.push(args); return update ? update(args) : { perfil_hash: null, primera_vez: new Date('2026-11-01T00:00:00Z'), ultima_vez: args.data.ultima_vez, inicios: 2 }; },
        findMany: async (args) => { llamadas.find.push(args); return filas; },
      },
    },
    './fraudeSyncService': { registrarDispositivo: async (datos) => { llamadas.grafo.push(datos); if (registrarDispositivo) return registrarDispositivo(datos); } },
  });
  return { ...modulo, llamadas };
}

// ── Lo que acepta el servidor ───────────────────────────────────────────────

test('familia del navegador y del sistema, sin versiones; Edge y Opera no se confunden con Chrome, ni el iPhone con macOS', () => {
  const { familiaDelNavegador, etiquetaDe } = servicio();
  const familia = (ua) => plano(familiaDelNavegador(ua));
  assert.deepEqual(familia(CHROME_WINDOWS), { navegador: 'Chrome', sistema: 'Windows' });
  assert.deepEqual(familia(CHROME_WINDOWS.replace('Chrome/130', 'Chrome/99')), familia(CHROME_WINDOWS), 'actualizar el navegador no cambia la familia');
  assert.equal(etiquetaDe(`${CHROME_WINDOWS} Edg/130.0.0.0`), 'Edge · Windows');
  assert.equal(etiquetaDe(`${CHROME_WINDOWS} OPR/115.0.0.0`), 'Opera · Windows');
  assert.equal(etiquetaDe('Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0'), 'Firefox · Linux');
  assert.equal(etiquetaDe('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'), 'Safari · iOS');
  assert.equal(etiquetaDe('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'), 'Chrome · Android');
  assert.equal(etiquetaDe('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'), 'Safari · macOS');
  assert.equal(etiquetaDe('curl/8.4.0'), 'Otro · Otro');
  assert.equal(etiquetaDe(undefined), 'Otro · Otro');
});

test('desdeCabeceras acepta un identificador de 16 a 64 caracteres alfanuméricos y descarta cualquier otra cosa', () => {
  const { desdeCabeceras } = servicio();
  const con = (cabeceras) => desdeCabeceras((nombre) => cabeceras[nombre]);
  assert.deepEqual(plano(con({ 'x-dispositivo': UUID, 'x-dispositivo-perfil': 'win32|es-gt', 'user-agent': 'ua' })), { dispositivoId: UUID, perfil: 'win32|es-gt', userAgent: 'ua' });
  assert.equal(con({ 'x-dispositivo': `  ${UUID}  ` }).dispositivoId, UUID, 'se recortan los espacios');
  assert.equal(con({ 'x-dispositivo': 'a'.repeat(32) }).dispositivoId, 'a'.repeat(32), 'también sirve un hexadecimal sin guiones');
  assert.equal(con({ 'x-dispositivo': UUID }).perfil, null, 'sin rasgos: perfil null');
  assert.equal(con({ 'x-dispositivo': UUID }).userAgent, '', 'sin User-Agent: cadena vacía');
  for (const invalido of [undefined, '', 'corto', 'a'.repeat(15), 'a'.repeat(65), 'tiene espacios en el medio 1234', `${UUID}; DROP TABLE`, '<script>alert(1)</script>', 'ñandú-ñandú-ñandú-ñandú', ['x'], 42]) {
    assert.equal(con({ 'x-dispositivo': invalido }), null, `no debe aceptar ${JSON.stringify(invalido)}`);
  }
});

// ── Los hash ────────────────────────────────────────────────────────────────

test('el hash del dispositivo es un SHA-256 estable que no contiene el identificador, y cada identificador da el suyo', () => {
  const { hashDispositivo } = servicio();
  const h = hashDispositivo(UUID);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, hashDispositivo(UUID), 'determinista: es lo que permite reconocer al mismo dispositivo');
  assert.notEqual(h, hashDispositivo(UUID.replace('3f2b', '3f2c')));
  assert.equal(h.includes(UUID.replaceAll('-', '')), false);
  assert.notEqual(h, require('node:crypto').createHash('sha256').update(UUID).digest('hex'), 'lleva un prefijo propio: el mismo UUID en otro sistema daría otro valor');
});

test('el perfil se normaliza, no cambia con la versión del navegador y sí con el sistema o con los rasgos; sin rasgos no hay perfil', () => {
  const { hashPerfil } = servicio();
  const rasgos = 'Win32|es-GT|America/Guatemala|1920x1080x24@1|8|0';
  const base = hashPerfil(rasgos, CHROME_WINDOWS);
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(hashPerfil('  win32|ES-gt|america/guatemala|1920x1080x24@1|8|0 ', CHROME_WINDOWS), base, 'mayúsculas y espacios no distinguen');
  assert.equal(hashPerfil(rasgos, CHROME_WINDOWS.replace('Chrome/130', 'Chrome/131')), base, 'una actualización del navegador no cambia el perfil');
  assert.notEqual(hashPerfil(rasgos, `${CHROME_WINDOWS} Edg/130`), base, 'otro navegador, otro perfil');
  assert.notEqual(hashPerfil(rasgos.replace('1920x1080', '1366x768'), CHROME_WINDOWS), base, 'otra pantalla, otro perfil');
  assert.notEqual(hashPerfil(rasgos, 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Safari/537.36'), base, 'otro sistema, otro perfil');
  for (const sinRasgos of [null, undefined, '', '   ', 42]) assert.equal(hashPerfil(sinRasgos, CHROME_WINDOWS), null);
  assert.equal(hashPerfil('x'.repeat(500), CHROME_WINDOWS), hashPerfil('x'.repeat(200), CHROME_WINDOWS), 'los rasgos tienen tope de 200 caracteres');
});

// ── Registrar un inicio de sesión ───────────────────────────────────────────

const dispositivo = (extra = {}) => ({ dispositivoId: UUID, perfil: 'win32|es-gt|america/guatemala|1920x1080x24@1|8|0', userAgent: CHROME_WINDOWS, ...extra });
const AHORA = new Date('2026-11-05T15:00:00Z');

test('un inicio anota (cuenta, dispositivo) con solo hashes, y reenvía al grafo lo mismo — sin el identificador en claro', async () => {
  const s = servicio();
  const fila = await s.registrarInicio({ usuarioId: 7, usuarioNombre: 'Ana Gómez', usuarioRol: 'comprador', dispositivo: dispositivo(), ahora: AHORA });
  assert.equal(s.llamadas.upsert.length, 1);
  const { where, create, update } = s.llamadas.upsert[0];
  assert.deepEqual(plano(where), { id_usuario_dispositivo_hash: { id_usuario: 7, dispositivo_hash: s.hashDispositivo(UUID) } });
  assert.equal(create.id_usuario, 7);
  assert.equal(create.etiqueta, 'Chrome · Windows');
  assert.match(create.perfil_hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(plano(update.inicios), { increment: 1 }, 'si ya existía, suma un inicio');
  assert.equal(update.ultima_vez, AHORA);
  assert.equal(fila.inicios, 1);
  await new Promise((resolver) => setImmediate(resolver));
  assert.equal(s.llamadas.grafo.length, 1);
  assert.equal(JSON.stringify([s.llamadas.upsert, s.llamadas.grafo]).includes(UUID), false, 'ni MySQL ni Neo4j reciben el identificador en claro');
  assert.deepEqual(plano(s.llamadas.grafo[0]), {
    usuarioId: 7, usuarioNombre: 'Ana Gómez', usuarioRol: 'comprador', dispositivoHash: s.hashDispositivo(UUID),
    perfilHash: create.perfil_hash, etiqueta: 'Chrome · Windows', primeraVez: AHORA.toISOString(), ultimaVez: AHORA.toISOString(), inicios: 1,
  });
});

test('sin dispositivo (un script, un cliente viejo) no se anota nada y no se toca ninguna base', async () => {
  const s = servicio();
  assert.equal(await s.registrarInicio({ usuarioId: 7, dispositivo: null }), null);
  assert.equal(await s.registrarInicioSeguro({ usuarioId: 7, dispositivo: undefined }), null);
  assert.equal(s.llamadas.upsert.length + s.llamadas.grafo.length, 0);
});

test('un inicio sin rasgos no borra el perfil que ya se conocía: solo se actualiza si llegó uno', async () => {
  const s = servicio();
  await s.registrarInicio({ usuarioId: 7, dispositivo: dispositivo({ perfil: null }), ahora: AHORA });
  const { create, update } = s.llamadas.upsert[0];
  assert.equal(create.perfil_hash, null);
  assert.equal('perfil_hash' in update, false, 'sin rasgos, el update no menciona perfil_hash');
});

test('dos pestañas de la misma cuenta entrando a la vez chocan con el índice único (P2002): el segundo inicio se suma con un update', async () => {
  const s = servicio({ upsert: () => { throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }); } });
  const fila = await s.registrarInicio({ usuarioId: 7, dispositivo: dispositivo(), ahora: AHORA });
  assert.equal(s.llamadas.update.length, 1);
  assert.deepEqual(plano(s.llamadas.update[0].where), plano(s.llamadas.upsert[0].where));
  assert.equal(fila.inicios, 2);
  const otro = servicio({ upsert: () => { throw Object.assign(new Error('otra cosa'), { code: 'P2025' }); } });
  await assert.rejects(otro.registrarInicio({ usuarioId: 7, dispositivo: dispositivo() }), /otra cosa/, 'cualquier otro error se propaga');
});

test('Neo4j apagado nunca estorba: el inicio no lo espera y su error solo se registra; con esperarGrafo sí se propaga', async () => {
  const s = servicio({ registrarDispositivo: () => { throw new Error('neo4j apagado'); } });
  const fila = await s.registrarInicio({ usuarioId: 7, dispositivo: dispositivo(), ahora: AHORA });
  assert.equal(fila.inicios, 1, 'el inicio se anotó en MySQL igual');
  await new Promise((resolver) => setImmediate(resolver)); // el .catch del reenvío (console.error, silenciado en el sandbox) no deja una promesa sin manejar
  await assert.rejects(s.registrarInicio({ usuarioId: 7, dispositivo: dispositivo(), ahora: AHORA, esperarGrafo: true }), /neo4j apagado/);
});

test('el inicio NO espera al grafo: devuelve aunque Neo4j todavía no haya contestado (un Neo4j lento no puede demorar un inicio de sesión)', async () => {
  let soltar;
  const s = servicio({ registrarDispositivo: () => new Promise((resolver) => { soltar = resolver; }) });
  const resultado = await Promise.race([
    s.registrarInicio({ usuarioId: 7, dispositivo: dispositivo(), ahora: AHORA }),
    new Promise((resolver) => setTimeout(() => resolver('esperó a Neo4j'), 300)),
  ]);
  assert.notEqual(resultado, 'esperó a Neo4j', 'el inicio quedó esperando una escritura de mejor esfuerzo');
  assert.equal(resultado.inicios, 1);
  soltar();
});

test('registrarInicioSeguro: una falla de MySQL (p. ej. la migración sin aplicar) se registra y NO impide entrar', async () => {
  const s = servicio({ upsert: () => { throw new Error('Table dispositivo_usuario doesn\'t exist'); } });
  assert.equal(await s.registrarInicioSeguro({ usuarioId: 7, dispositivo: dispositivo() }), null);
});

// ── La ficha del administrador ──────────────────────────────────────────────

test('dispositivosDe agrupa por cuenta, deja a lo sumo 5 por cuenta (el más reciente primero) y expone solo una referencia corta', async () => {
  const hash = (n) => `${String(n).padStart(2, '0')}${'a'.repeat(62)}`;
  const fecha = (dia) => new Date(`2026-11-${String(dia).padStart(2, '0')}T10:00:00Z`);
  const filas = [
    ...Array.from({ length: 7 }, (_, i) => ({ id_usuario: 1, dispositivo_hash: hash(i), etiqueta: 'Chrome · Windows', inicios: i + 1, primera_vez: fecha(1), ultima_vez: fecha(20 - i) })),
    { id_usuario: 2, dispositivo_hash: hash(0), etiqueta: 'Chrome · Windows', inicios: 3, primera_vez: fecha(2), ultima_vez: fecha(3) },
  ];
  const s = servicio({ filas });
  const mapa = await s.dispositivosDe([1, 2, 3]);
  assert.equal(mapa.get(1).length, 5);
  assert.equal(mapa.get(3), undefined, 'una cuenta sin dispositivos no figura');
  assert.deepEqual(plano(s.llamadas.find[0].orderBy), { ultima_vez: 'desc' });
  assert.deepEqual(plano(mapa.get(2)[0]), { referencia: '00aaaaaa', etiqueta: 'Chrome · Windows', inicios: 3, primeraVez: '2026-11-02T10:00:00.000Z', ultimaVez: '2026-11-03T10:00:00.000Z' });
  assert.equal(mapa.get(1)[0].referencia, mapa.get(2)[0].referencia, 'dos cuentas con el mismo dispositivo muestran la MISMA referencia');
  assert.equal(JSON.stringify([...mapa.values()]).includes(hash(0)), false, 'el hash completo no sale del servidor');
  assert.equal((await servicio().dispositivosDe([])).size, 0);
});

// ── Lo que genera el navegador ──────────────────────────────────────────────

function navegador({ almacen = new Map(), lanza = false, entorno = {} } = {}) {
  const fuente = fs.readFileSync(path.join(__dirname, '../../frontend/src/utils/dispositivo.js'), 'utf8').replace(/export /g, '');
  const localStorage = {
    getItem: (k) => { if (lanza) throw new Error('almacenamiento bloqueado'); return almacen.has(k) ? almacen.get(k) : null; },
    setItem: (k, v) => { if (lanza) throw new Error('almacenamiento bloqueado'); almacen.set(k, v); },
  };
  let contador = 0;
  const contexto = {
    module: { exports: {} }, localStorage, Intl,
    globalThis: {
      crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++contador).padStart(12, '0')}`, getRandomValues: (b) => b.fill(171) },
      navigator: { userAgentData: { platform: 'Windows' }, language: 'es-GT', hardwareConcurrency: 8, maxTouchPoints: 0 },
      screen: { width: 1920, height: 1080, colorDepth: 24 },
      devicePixelRatio: 1.25,
      ...entorno,
    },
  };
  vm.runInNewContext(`${fuente}\nmodule.exports = { idDispositivo, perfilDispositivo, cabecerasDeDispositivo };`, contexto);
  return { ...contexto.module.exports, almacen };
}

test('el navegador genera un identificador aleatorio la primera vez, lo guarda y lo reutiliza', () => {
  const n = navegador();
  const id = n.idDispositivo();
  assert.match(id, /^[A-Za-z0-9-]{16,64}$/, 'tiene la forma que acepta el servidor');
  assert.equal(n.idDispositivo(), id);
  assert.equal(n.almacen.get('tiendaya.dispositivo'), id);
  assert.equal(navegador({ almacen: n.almacen }).idDispositivo(), id, 'otra pestaña (otro módulo, mismo almacenamiento) ve el mismo');
});

test('un valor guardado inválido se reemplaza; sin almacenamiento el identificador dura mientras la pestaña esté abierta', () => {
  const sucio = navegador({ almacen: new Map([['tiendaya.dispositivo', 'basura con espacios']]) });
  assert.match(sucio.idDispositivo(), /^[A-Za-z0-9-]{16,64}$/);
  assert.notEqual(sucio.almacen.get('tiendaya.dispositivo'), 'basura con espacios');
  const bloqueado = navegador({ lanza: true });
  const id = bloqueado.idDispositivo();
  assert.match(id, /^[A-Za-z0-9-]{16,64}$/);
  assert.equal(bloqueado.idDispositivo(), id, 'estable durante la sesión aunque no se pueda guardar');
});

test('el perfil son rasgos gruesos, solo ASCII imprimible (una cabecera con otra cosa haría fallar la petición) y estables', () => {
  const n = navegador();
  assert.equal(n.perfilDispositivo(), 'Windows|es-GT|' + Intl.DateTimeFormat().resolvedOptions().timeZone + '|1920x1080x24@1.25|8|0');
  assert.equal(n.perfilDispositivo(), n.perfilDispositivo());
  const raro = navegador({ entorno: { navigator: { language: 'es-GT ñ ✓', platform: 'Wín32' } } });
  assert.match(raro.perfilDispositivo(), /^[\x20-\x7E]*$/);
  assert.equal(navegador({ entorno: { navigator: undefined, screen: undefined } }).perfilDispositivo().includes('undefined'), false, 'lo que no se conoce no aparece como "undefined"');
});

test('las cabeceras llevan el identificador y, si hay rasgos, el perfil', () => {
  const n = navegador();
  const cabeceras = plano(n.cabecerasDeDispositivo());
  assert.equal(cabeceras['X-Dispositivo'], n.idDispositivo());
  assert.equal(cabeceras['X-Dispositivo-Perfil'], n.perfilDispositivo());
});

test('api/client.js manda las cabeceras de dispositivo SOLO al iniciar sesión y al registrarse (una cabecera propia en una lectura obligaría a un pre-vuelo)', () => {
  const fuente = fs.readFileSync(path.join(__dirname, '../../frontend/src/api/client.js'), 'utf8');
  assert.match(fuente, /RUTAS_CON_DISPOSITIVO = new Set\(\['\/auth\/login', '\/auth\/registro'\]\)/);
  assert.match(fuente, /if \(RUTAS_CON_DISPOSITIVO\.has\(path\)\) Object\.assign\(headers, cabecerasDeDispositivo\(\)\)/);
  assert.equal((fuente.match(/cabecerasDeDispositivo/g) ?? []).length, 2, 'el import y un único uso');
});
