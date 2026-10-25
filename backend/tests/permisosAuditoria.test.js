const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cargar } = require('./redisHelpers');
const { prismaFalso, relojFalso, ROLES_BASE, USUARIOS_BASE } = require('./politicaHelpers');

// auditoriaAccesoService: el registro de cambios de permisos y de accesos denegados. De mejor esfuerzo (no registrar
// no impide un cambio ni una respuesta 403), con las denegaciones repetidas recortadas, filtros que no se dejan
// engañar, nombres que se resuelven al leer y un CSV que una hoja de cálculo no ejecuta como fórmula.
// Con un Mongo y un MySQL de mentira: no abre ninguna conexión.
const plano = (valor) => JSON.parse(JSON.stringify(valor));
const TIPOS = ['regla', 'restaurar', 'rol_cuenta', 'rol_creado', 'rol_eliminado', 'denegacion'];

function servicio({ docs = [], mongoFalla = null } = {}) {
  const insertados = [];
  const consultas = [];
  const fallos = [];
  const modelo = {
    TIPOS,
    insertMany: async (lista, opciones) => {
      if (mongoFalla) throw mongoFalla;
      insertados.push(...lista);
      consultas.push(['insertMany', opciones]);
    },
    countDocuments: async (filtro) => {
      consultas.push(['countDocuments', plano(filtro)]);
      return docs.length;
    },
    find: (filtro) => {
      consultas.push(['find', plano(filtro)]);
      const cadena = {
        sort: (orden) => { consultas.push(['sort', orden]); return cadena; },
        skip: (n) => { consultas.push(['skip', n]); return cadena; },
        limit: (n) => { consultas.push(['limit', n]); return cadena; },
        lean: async () => docs,
      };
      return cadena;
    },
  };
  const prisma = prismaFalso({ roles: ROLES_BASE, usuarios: USUARIOS_BASE });
  const { reloj, Date } = relojFalso();
  const modulo = cargar(
    '../src/services/auditoriaAccesoService.js',
    {
      '../config/prisma': prisma,
      '../models/mongo/AuditoriaAcceso': modelo,
      '../config/mongo': { conectar: async () => {} },
      '../utils/resiliencia': { registrarFallo: (contexto, err) => fallos.push([contexto, err.message]) },
    },
    {},
    { Date }
  );
  return { ...modulo, insertados, consultas, fallos, reloj, prisma };
}

const cola = () => new Promise((resolver) => setImmediate(resolver));

// ── Registrar ───────────────────────────────────────────────────────────────────────────────────────────────────

test('registrar guarda los eventos y dice si lo logró', async () => {
  const s = servicio();
  assert.equal(await s.registrar({ tipo: 'regla' }), true);
  assert.equal(await s.registrarVarios([{ tipo: 'regla' }, { tipo: 'restaurar' }]), true);
  assert.equal(s.insertados.length, 3);
  assert.equal(await s.registrarVarios([]), true, 'una lista vacía no escribe');
  assert.equal(s.consultas.filter(([n]) => n === 'insertMany').length, 2);
});

test('si Mongo falla, registrar NO lanza: devuelve false y deja la falla en el log', async () => {
  const s = servicio({ mongoFalla: new Error('Mongo apagado') });
  assert.equal(await s.registrar({ tipo: 'regla' }), false);
  assert.deepEqual(s.fallos, [['No se pudo registrar en la auditoría de accesos', 'Mongo apagado']]);
});

test('una denegación se registra en segundo plano, con quién, con qué rol y en qué ruta', async () => {
  const s = servicio();
  assert.equal(s.registrarDenegacion({ id_usuario: 5, rol: 'vendedor' }, 'GET /api/admin/ventas', 'comprador'), true);
  await cola();
  assert.deepEqual(plano(s.insertados), [{ tipo: 'denegacion', actor: { id: 5, rol: 'comprador' }, objetivo: { tipo: 'ruta', id: 'GET /api/admin/ventas' }, detalle: 'ACL_DENEGADO' }]);
});

test('la misma cuenta en la misma ruta se anota una vez por minuto, no una por cada clic', async () => {
  const s = servicio();
  const u = { id_usuario: 5, rol: 'vendedor' };
  assert.equal(s.registrarDenegacion(u, 'GET /a', 'vendedor'), true);
  assert.equal(s.registrarDenegacion(u, 'GET /a', 'vendedor'), false);
  assert.equal(s.registrarDenegacion(u, 'GET /a', 'vendedor'), false);
  assert.equal(s.registrarDenegacion(u, 'GET /b', 'vendedor'), true, 'otra ruta sí');
  assert.equal(s.registrarDenegacion({ id_usuario: 6, rol: 'vendedor' }, 'GET /a', 'vendedor'), true, 'otra cuenta sí');
  s.reloj.avanzar(59000);
  assert.equal(s.registrarDenegacion(u, 'GET /a', 'vendedor'), false);
  s.reloj.avanzar(1001);
  assert.equal(s.registrarDenegacion(u, 'GET /a', 'vendedor'), true, 'pasado el minuto vuelve a anotarse');
  await cola();
  assert.equal(s.insertados.length, 4);
});

test('el control de repetidas no crece sin límite aunque lleguen miles de cuentas distintas', async () => {
  const s = servicio();
  for (let i = 1; i <= 2000; i++) s.registrarDenegacion({ id_usuario: i, rol: 'comprador' }, 'GET /a', 'comprador');
  await cola();
  assert.equal(s.insertados.length, 2000, 'cada cuenta distinta sí se anota');
  s.reloj.avanzar(61000);
  assert.equal(s.registrarDenegacion({ id_usuario: 1, rol: 'comprador' }, 'GET /a', 'comprador'), true);
});

// ── Leer ────────────────────────────────────────────────────────────────────────────────────────────────────────

const DOCS = [
  { _id: 'a1', tipo: 'regla', fecha: new Date('2026-10-24T18:00:00Z'), actor: { id: 9, rol: 'administrador' }, objetivo: { tipo: 'ruta', id: 'GET /api/admin/ventas', nombre: 'Panel de ventas' }, antes: { rol: 'auditor', permitido: false }, despues: { rol: 'auditor', permitido: true } },
  { _id: 'a2', tipo: 'rol_cuenta', fecha: new Date('2026-10-24T17:00:00Z'), actor: { id: 9, rol: 'administrador' }, objetivo: { tipo: 'usuario', id: '11' }, antes: { rol: 'comprador' }, despues: { rol: 'auditor' } },
  { _id: 'a3', tipo: 'denegacion', fecha: new Date('2026-10-24T16:00:00Z'), actor: { id: 777, rol: 'comprador' }, objetivo: { tipo: 'ruta', id: 'GET /api/admin/fraude' }, detalle: 'ACL_DENEGADO' },
];

test('listar devuelve los más recientes primero, con nombre y correo de quien actuó y de la cuenta afectada', async () => {
  const s = servicio({ docs: DOCS });
  const r = plano(await s.listar({}));
  assert.deepEqual([r.total, r.pagina, r.tamano, r.paginas], [3, 1, 25, 1]);
  assert.deepEqual(plano(s.consultas.filter(([n]) => ['sort', 'skip', 'limit'].includes(n))), [['sort', { fecha: -1, _id: -1 }], ['skip', 0], ['limit', 25]]);
  const [regla, rolCuenta, denegacion] = r.registros;
  assert.deepEqual(regla.actor, { id: 9, rol: 'administrador', nombre: 'Admin Uno', correo: 'admin@example.com' });
  assert.equal(regla.objetivo.nombre, 'Panel de ventas');
  assert.deepEqual([rolCuenta.objetivo.nombre, rolCuenta.objetivo.correo], ['Rosa Auditora', 'rosa@example.com']);
  assert.deepEqual(denegacion.actor, { id: 777, rol: 'comprador', eliminada: true }, 'una cuenta que ya no existe se ve como tal');
  assert.equal(r.registros[0].id, 'a1');
});

test('el registro NO guarda nombres ni correos: se resuelven al leer', () => {
  const origen = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'politicaAccesoService.js'), 'utf8')
    + fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'usuarioAdminService.js'), 'utf8');
  assert.ok(!/actor:\s*\{[^}]*(correo|nombres|nombre)/.test(origen), 'el actor es solo { id, rol }');
});

test('los filtros se traducen a una consulta de Mongo y las fechas son días de Guatemala (UTC−6)', async () => {
  const s = servicio({ docs: [] });
  await s.listar({ tipo: 'regla', desde: '2026-10-20', hasta: '2026-10-21' });
  const [, filtro] = s.consultas.find(([n]) => n === 'find');
  assert.equal(filtro.tipo, 'regla');
  assert.equal(filtro.fecha.$gte, '2026-10-20T06:00:00.000Z', 'el día 20 empieza a las 00:00 de Guatemala');
  assert.equal(filtro.fecha.$lte, '2026-10-22T05:59:59.999Z', 'y el 21 termina a las 23:59:59.999 de Guatemala');
});

test('«cambios» son todos los tipos menos las denegaciones', async () => {
  const s = servicio({ docs: [] });
  await s.listar({ tipo: 'cambios' });
  assert.deepEqual(s.consultas.find(([n]) => n === 'find')[1].tipo, { $ne: 'denegacion' });
});

test('filtrar por quién actuó: un número es el id; un texto se busca por correo y nombre', async () => {
  const porId = servicio({ docs: [] });
  await porId.listar({ actor: '9' });
  assert.deepEqual(porId.consultas.find(([n]) => n === 'find')[1]['actor.id'], { $in: [9] });
  const porTexto = servicio({ docs: [] });
  await porTexto.listar({ actor: 'admin' });
  assert.deepEqual(porTexto.consultas.find(([n]) => n === 'find')[1]['actor.id'], { $in: [9, 10] });
  const nadie = servicio({ docs: [] });
  await nadie.listar({ actor: 'nadie-se-llama-asi' });
  assert.deepEqual(nadie.consultas.find(([n]) => n === 'find')[1]['actor.id'], { $in: [] }, 'sin coincidencias no devuelve todo: devuelve nada');
});

test('un filtro mal escrito es un 400, no una consulta rara', async () => {
  const s = servicio({ docs: [] });
  for (const consulta of [{ tipo: 'inventado' }, { desde: '20/10/2026' }, { hasta: 'ayer' }, { desde: '2026-13-45' }, { tipo: { $ne: 'regla' } }]) {
    await assert.rejects(s.listar(consulta), (err) => err.status === 400, JSON.stringify(consulta));
  }
  // El mensaje dice QUÉ formato se espera (una fecha que no es AAAA-MM-DD no se confunde con una fecha imposible).
  await assert.rejects(s.listar({ desde: '20/10/2026' }), /AAAA-MM-DD/);
  await assert.rejects(s.listar({ hasta: 'ayer' }), /AAAA-MM-DD/);
  await assert.rejects(s.listar({ desde: '2026-13-45' }), /no es válida/);
  assert.ok(!s.consultas.some(([n]) => n === 'find'), 'ninguna llegó a Mongo');
});

test('el tamaño de página tiene tope y la página mínima es la 1', async () => {
  const s = servicio({ docs: [] });
  const r = plano(await s.listar({ tamano: '5000', pagina: '-2' }));
  assert.deepEqual([r.tamano, r.pagina], [100, 1]);
  const chica = servicio({ docs: [] });
  assert.equal(plano(await chica.listar({ tamano: '0' })).tamano, 25, 'un 0 o un texto vuelve al valor por omisión');
});

// ── CSV ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test('una celda del CSV se escapa: comillas, comas, saltos de línea', () => {
  const { celdaCsv } = servicio();
  assert.equal(celdaCsv('simple'), 'simple');
  assert.equal(celdaCsv('con, coma'), '"con, coma"');
  assert.equal(celdaCsv('dice "hola"'), '"dice ""hola"""');
  assert.equal(celdaCsv('dos\nlíneas'), '"dos\nlíneas"');
  assert.equal(celdaCsv(null), '');
  assert.equal(celdaCsv(undefined), '');
  assert.equal(celdaCsv(0), '0');
  assert.equal(celdaCsv({ rol: 'a', permitido: true }), '"{""rol"":""a"",""permitido"":true}"');
});

test('una celda que empieza como fórmula se neutraliza: una hoja de cálculo no la ejecuta', () => {
  const { celdaCsv } = servicio();
  for (const peligrosa of ['=HYPERLINK("http://x","y")', '+1+1', '-2+3', '@SUM(A1)', '\t=1', '\r=1']) {
    assert.ok(celdaCsv(peligrosa).replace(/^"/, '').startsWith("'"), `${JSON.stringify(peligrosa)} debe empezar con apóstrofo`);
  }
  assert.equal(celdaCsv('normal=1'), 'normal=1', 'un = en medio no es una fórmula');
});

test('el CSV lleva su encabezado, una fila por registro y el nombre de quien actuó', async () => {
  const s = servicio({ docs: DOCS });
  const csv = await s.exportarCsv({});
  const lineas = csv.split('\r\n');
  assert.equal(lineas[0], 'fecha,tipo,actor_id,actor_nombre,actor_correo,actor_rol,objetivo_tipo,objetivo,objetivo_nombre,antes,despues,detalle');
  assert.equal(lineas.length, 4);
  assert.match(lineas[1], /^2026-10-24T18:00:00\.000Z,regla,9,Admin Uno,admin@example\.com,administrador,ruta,GET \/api\/admin\/ventas,Panel de ventas,/);
  assert.match(lineas[3], /,denegacion,777,,,comprador,/, 'una cuenta eliminada queda con nombre y correo vacíos');
});

test('el CSV tiene tope de filas', async () => {
  const s = servicio({ docs: [] });
  await s.exportarCsv({});
  assert.equal(s.consultas.find(([n]) => n === 'limit')[1], s.TOPE_CSV);
  assert.equal(s.TOPE_CSV, 5000);
});

// ── La colección ────────────────────────────────────────────────────────────────────────────────────────────────

test('el modelo declara los tipos, y las denegaciones vencen a los 90 días solo ellas (un cambio de permisos se guarda siempre)', () => {
  const { Schema } = require('mongoose');
  assert.ok(Schema, 'mongoose cargó');
  const AuditoriaAcceso = require('../src/models/mongo/AuditoriaAcceso');
  assert.deepEqual([...AuditoriaAcceso.TIPOS], TIPOS);
  const indices = AuditoriaAcceso.schema.indexes();
  const ttl = indices.find(([, opciones]) => opciones.expireAfterSeconds);
  assert.equal(ttl[1].expireAfterSeconds, 90 * 86400);
  assert.deepEqual(ttl[1].partialFilterExpression, { tipo: 'denegacion' });
  assert.ok(indices.some(([campos]) => campos.fecha === -1), 'índice por fecha para listar lo más reciente');
});

test('el código del servidor nunca modifica ni borra un registro de auditoría (y la base tampoco lo dejaría)', () => {
  const src = path.join(__dirname, '..', 'src');
  const archivos = [];
  const recorrer = (carpeta) => {
    for (const e of fs.readdirSync(carpeta, { withFileTypes: true })) {
      if (e.isDirectory()) recorrer(path.join(carpeta, e.name));
      else if (e.name.endsWith('.js')) archivos.push(path.join(carpeta, e.name));
    }
  };
  recorrer(src);
  const usan = archivos.filter((a) => /AuditoriaAcceso/.test(fs.readFileSync(a, 'utf8')));
  assert.ok(usan.length >= 2, 'el recorrido encontró quién usa el modelo');
  for (const archivo of usan) {
    const texto = fs.readFileSync(archivo, 'utf8');
    assert.ok(!/AuditoriaAcceso\s*\.\s*(update|updateOne|updateMany|replaceOne|findOneAndUpdate|findByIdAndUpdate|delete|deleteOne|deleteMany|findOneAndDelete|findByIdAndDelete|remove|drop|bulkWrite)/.test(texto), `${path.relative(src, archivo)} toca un registro de auditoría`);
  }
});
