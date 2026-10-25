const test = require('node:test');
const assert = require('node:assert/strict');
const { cargar } = require('./redisHelpers');
const { prismaFalso, relojFalso, auditoriaRegistro, ROLES_BASE, USUARIOS_BASE } = require('./politicaHelpers');

// politicaAccesoService: la lista blanca del código más las diferencias que un administrador guarda desde
// /admin/permisos (IA/ADR-007 §9). Con una base, un reloj y una auditoría de mentira: no abre ninguna conexión.
// Lo que se prueba es la DECISIÓN —qué gana, qué nunca se puede cambiar, qué pasa cuando MySQL falla— y los
// cambios (validación, todo o nada, auditoría); que la API la aplique en cada ruta lo prueba accesoRutas.test.js.
const plano = (valor) => JSON.parse(JSON.stringify(valor));

const VENTAS = 'GET /api/admin/ventas'; //            editable; el código solo la da al administrador
const CATEGORIAS = 'POST /api/categorias'; //          editable; el código la da a vendedor y administrador
const HISTORIAL = 'GET /api/productos/:id/historial'; // fija (depende del dueño del producto)
const PERMISOS = 'GET /api/admin/permisos'; //         fija: administrar permisos no se concede
const ADMIN = ['administrador'];
const VENDEDORES = ['vendedor', 'administrador'];

const ana = { id_usuario: 1, rol: 'comprador' };
const luis = { id_usuario: 2, rol: 'vendedor' };
const admin = { id_usuario: 9, rol: 'administrador' };
const rosa = { id_usuario: 11, rol: 'auditor' };

function servicio({ reglas = [], falla = false } = {}) {
  const prisma = prismaFalso({ roles: ROLES_BASE, usuarios: USUARIOS_BASE, reglas });
  const auditoria = auditoriaRegistro({ falla });
  const { reloj, Date } = relojFalso();
  const avisos = [];
  const modulo = cargar(
    '../src/services/politicaAccesoService.js',
    { '../config/prisma': prisma, './auditoriaAccesoService': auditoria },
    {},
    { Date, setTimeout, clearTimeout, console: { error: (...args) => avisos.push(args.join(' ')), log() {} } }
  );
  return { ...modulo, prisma, auditoria, reloj, avisos };
}

// Las reglas en el formato de la copia en memoria (rol + ruta → permitido), para probar decidir() sola.
const copiaCon = (...reglas) => ({
  reglas: new Map(reglas.map(([rol, ruta, permitido]) => [`${rol}\u0000${ruta}`, { permitido, porId: 9, en: new Date('2026-10-20T12:00:00Z') }])),
});
const reglaDe = (rol_id, ruta, permitido) => ({ rol_id, ruta, permitido });

// ── La decisión (función pura) ──────────────────────────────────────────────────────────────────────────────────

test('sin ninguna regla, vale lo que declara el código: lo que no está en la lista blanca se niega', () => {
  const { decidir } = servicio();
  const nada = copiaCon();
  assert.deepEqual(plano(decidir(nada, 'vendedor', CATEGORIAS, VENDEDORES)), { permitido: true, origen: 'codigo' });
  assert.deepEqual(plano(decidir(nada, 'comprador', CATEGORIAS, VENDEDORES)), { permitido: false, origen: 'codigo' });
  assert.equal(decidir(nada, 'auditor', VENTAS, ADMIN).permitido, false, 'un rol propio empieza sin nada');
  assert.equal(decidir(nada, 'rol-inexistente', VENTAS, ADMIN).permitido, false);
});

test('en una ruta editable la regla de un administrador gana al código, en las dos direcciones', () => {
  const { decidir } = servicio();
  const c = copiaCon(['auditor', VENTAS, true], ['vendedor', CATEGORIAS, false]);
  const concedida = decidir(c, 'auditor', VENTAS, ADMIN);
  assert.equal(concedida.permitido, true);
  assert.equal(concedida.origen, 'regla');
  const quitada = decidir(c, 'vendedor', CATEGORIAS, VENDEDORES);
  assert.equal(quitada.permitido, false);
  assert.equal(quitada.origen, 'regla');
});

test('una regla afecta solo a su rol y a su ruta', () => {
  const { decidir } = servicio();
  const c = copiaCon(['auditor', VENTAS, true]);
  assert.equal(decidir(c, 'comprador', VENTAS, ADMIN).permitido, false, 'otro rol, misma ruta');
  assert.equal(decidir(c, 'auditor', 'GET /api/admin/fraude', ADMIN).permitido, false, 'el mismo rol, otra ruta');
});

test('el administrador conserva todas las rutas: ninguna regla lo toca, ni una fila metida a mano en MySQL', () => {
  const { decidir } = servicio();
  const c = copiaCon(['administrador', VENTAS, false], ['administrador', CATEGORIAS, false]);
  assert.deepEqual(plano(decidir(c, 'administrador', VENTAS, ADMIN)), { permitido: true, origen: 'administrador' });
  assert.equal(decidir(c, 'administrador', CATEGORIAS, VENDEDORES).permitido, true);
  assert.equal(decidir(c, 'administrador', 'GET /ruta-solo-de-vendedores', ['vendedor']).permitido, false, 'sigue la lista que declara el código, no es un comodín');
});

test('una ruta fija ignora toda regla, aunque alguien la meta directo en la tabla', () => {
  const { decidir } = servicio();
  const c = copiaCon(['comprador', HISTORIAL, true], ['auditor', PERMISOS, true], ['vendedor', HISTORIAL, false]);
  assert.deepEqual(plano(decidir(c, 'comprador', HISTORIAL, VENDEDORES)), { permitido: false, origen: 'codigo' });
  assert.equal(decidir(c, 'auditor', PERMISOS, ADMIN).permitido, false, 'administrar permisos no se concede ni por la puerta de atrás');
  assert.equal(decidir(c, 'vendedor', HISTORIAL, VENDEDORES).permitido, true, 'ni se quita lo que el código da');
});

test('sin rol (la cuenta ya no existe) o con una ruta desconocida, se niega', () => {
  const { decidir } = servicio();
  assert.deepEqual(plano(decidir(copiaCon(), null, VENTAS, ADMIN)), { permitido: false, origen: 'sin-rol' });
  assert.equal(decidir(copiaCon(['vendedor', 'GET /no-existe', true]), 'vendedor', 'GET /no-existe').permitido, false);
});

// ── permite(): el rol de hoy, la copia y los fallos de MySQL ─────────────────────────────────────────────────────

test('permite() decide con las reglas de MySQL y dice con qué rol decidió', async () => {
  const s = servicio({ reglas: [reglaDe(4, VENTAS, true), reglaDe(2, CATEGORIAS, false)] });
  assert.deepEqual(plano(await s.permite(rosa, VENTAS, ADMIN)).permitido, true);
  const luisCategorias = plano(await s.permite(luis, CATEGORIAS, VENDEDORES));
  assert.equal(luisCategorias.permitido, false);
  assert.equal(luisCategorias.origen, 'regla');
  assert.equal(luisCategorias.rol, 'vendedor');
  assert.equal((await s.permite(admin, VENTAS, ADMIN)).permitido, true);
  assert.equal((await s.permite(ana, VENTAS, ADMIN)).permitido, false);
});

test('las reglas se leen de MySQL una vez cada 5 s, no en cada petición', async () => {
  const s = servicio({ reglas: [reglaDe(4, VENTAS, true)] });
  const lecturas = () => s.prisma.estado.consultas.filter((c) => c === 'acl_regla.findMany').length;
  await s.permite(rosa, VENTAS, ADMIN);
  await s.permite(rosa, VENTAS, ADMIN);
  await s.permite(luis, CATEGORIAS, VENDEDORES);
  assert.equal(lecturas(), 1);
  s.reloj.avanzar(4900);
  await s.permite(rosa, VENTAS, ADMIN);
  assert.equal(lecturas(), 1);
  s.reloj.avanzar(200);
  await s.permite(rosa, VENTAS, ADMIN);
  assert.equal(lecturas(), 2, 'pasados 5 s se vuelve a leer: un cambio hecho por otro proceso llega en ese tiempo');
});

test('una ruta fija no lee las reglas: solo se mira el rol de hoy de quien pregunta', async () => {
  const s = servicio();
  assert.equal((await s.permite(admin, PERMISOS, ADMIN)).permitido, true);
  assert.ok(!s.prisma.estado.consultas.includes('acl_regla.findMany'));
  assert.ok(s.prisma.estado.consultas.includes('usuarios.findUnique'));
});

test('se decide con el rol de HOY, no con el del token: un administrador degradado pierde las rutas en segundos', async () => {
  const s = servicio();
  assert.equal((await s.permite(admin, VENTAS, ADMIN)).permitido, true);
  s.prisma.estado.usuarios.find((u) => u.id_usuario === 9).rol_id = 1; // lo degradaron a comprador; su token (2 h) aún dice «administrador»
  assert.equal((await s.permite(admin, VENTAS, ADMIN)).permitido, true, 'dentro de los 5 s se usa la copia');
  s.reloj.avanzar(5001);
  const despues = plano(await s.permite(admin, VENTAS, ADMIN));
  assert.equal(despues.permitido, false);
  assert.equal(despues.rol, 'comprador');
});

test('el rol de hoy se olvida al instante cuando este proceso lo cambia (olvidarRol)', async () => {
  const s = servicio();
  assert.equal((await s.permite(ana, CATEGORIAS, VENDEDORES)).permitido, false);
  s.prisma.estado.usuarios.find((u) => u.id_usuario === 1).rol_id = 2; // la hicieron vendedora
  s.olvidarRol(1);
  assert.equal((await s.permite(ana, CATEGORIAS, VENDEDORES)).permitido, true, 'sin esperar los 5 s');
});

test('una cuenta que ya no existe no tiene permisos, aunque su token siga vigente', async () => {
  const s = servicio();
  const r = plano(await s.permite({ id_usuario: 404, rol: 'administrador' }, VENTAS, ADMIN));
  assert.equal(r.permitido, false);
  assert.equal(r.origen, 'sin-rol');
});

test('con MySQL apagado rige el rol del token y lo que declara el código, y no se insiste en cada petición', async () => {
  const s = servicio({ reglas: [reglaDe(4, VENTAS, true)] });
  s.prisma.estado.falla = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3306'), { code: 'ECONNREFUSED' });
  const preguntas = () => s.prisma.estado.consultas.length;
  assert.equal((await s.permite(luis, CATEGORIAS, VENDEDORES)).permitido, true, 'el código da la ruta al vendedor');
  assert.equal((await s.permite(rosa, VENTAS, ADMIN)).permitido, false, 'la regla que la concedía no se puede leer: rige el código');
  const intentos = preguntas();
  for (let i = 0; i < 5; i++) await s.permite(luis, CATEGORIAS, VENDEDORES);
  assert.equal(preguntas(), intentos, 'durante la ventana de reintento no se vuelve a consultar');
  assert.equal(s.avisos.length, 1, 'un aviso por caída, no uno por petición');
  assert.match(s.avisos[0], /política de permisos/);
});

test('arranque en frío con MySQL apagado: rige el código; al volver MySQL se aplican las reglas', async () => {
  const s = servicio({ reglas: [reglaDe(4, VENTAS, true)] });
  s.prisma.estado.falla = new Error('MySQL apagado');
  assert.equal((await s.permite(rosa, VENTAS, ADMIN)).permitido, false);
  s.prisma.estado.falla = null;
  s.reloj.avanzar(2001);
  assert.equal((await s.permite(rosa, VENTAS, ADMIN)).permitido, true);
});

test('con una copia previa, una falla de MySQL conserva las últimas reglas conocidas (también las que niegan)', async () => {
  const s = servicio({ reglas: [reglaDe(2, CATEGORIAS, false)] });
  assert.equal((await s.permite(luis, CATEGORIAS, VENDEDORES)).permitido, false);
  s.prisma.estado.falla = new Error('MySQL apagado');
  s.reloj.avanzar(60000);
  assert.equal((await s.permite(luis, CATEGORIAS, VENDEDORES)).permitido, false, 'la revocación sigue vigente con MySQL caído');
});

test('un MySQL colgado (que no responde) no cuelga la API: a los 1,5 s se decide con lo que hay', async () => {
  const s = servicio({ reglas: [reglaDe(2, CATEGORIAS, false)] });
  s.prisma.estado.cuelga = true;
  const t = Date.now();
  const r = await s.permite(luis, CATEGORIAS, VENDEDORES);
  assert.equal(r.permitido, true, 'sin respuesta de MySQL rige el código');
  assert.ok(Date.now() - t < 5000, 'no se quedó esperando');
});

// ── La matriz ───────────────────────────────────────────────────────────────────────────────────────────────────

test('la matriz trae los roles con su cantidad de cuentas y una fila por cada ruta por roles', async () => {
  const s = servicio({ reglas: [{ ...reglaDe(4, VENTAS, true), actualizado_por: 9 }] });
  const m = plano(await s.matriz());
  assert.deepEqual(m.roles.map((r) => [r.nombre, r.sistema, r.usuarios]), [['comprador', true, 1], ['vendedor', true, 1], ['administrador', true, 2], ['auditor', false, 1]]);
  assert.ok(m.rutas.length >= 20);
  assert.ok(m.rutas.every((r) => ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(r.metodo) && r.grupo && r.nota));
  assert.equal(m.reglas, 1);
});

test('cada celda dice si está permitida, de dónde sale, si coincide con el código y si se puede tocar', async () => {
  const s = servicio({ reglas: [{ ...reglaDe(4, VENTAS, true), actualizado_por: 9, actualizado_en: new Date('2026-10-21T15:30:00Z') }] });
  const fila = (m, clave) => m.rutas.find((r) => r.clave === clave);
  const m = plano(await s.matriz());
  const ventas = fila(m, VENTAS);
  assert.equal(ventas.editable, true);
  assert.deepEqual(ventas.porDefecto, ['administrador']);
  assert.deepEqual(ventas.celdas.auditor, { permitido: true, origen: 'regla', porDefecto: false, bloqueada: false, modificadoPor: 'Admin Uno', modificadoEn: '2026-10-21T15:30:00.000Z' });
  assert.deepEqual(ventas.celdas.comprador, { permitido: false, origen: 'codigo', porDefecto: false, bloqueada: false });
  assert.deepEqual(ventas.celdas.administrador, { permitido: true, origen: 'administrador', porDefecto: true, bloqueada: true }, 'la columna del administrador no se toca');
  const historial = fila(m, HISTORIAL);
  assert.equal(historial.editable, false);
  assert.match(historial.fija, /dueño/);
  assert.ok(Object.values(historial.celdas).every((c) => c.bloqueada === true), 'una fila fija entera es de solo lectura');
  assert.equal(historial.propios, true);
});

test('la matriz lee la base AHORA (no la copia de hace unos segundos) y falla si MySQL no responde', async () => {
  const s = servicio();
  await s.matriz();
  s.prisma.estado.reglas.push({ id: 99, rol_id: 4, ruta: VENTAS, permitido: true, actualizado_por: null, actualizado_en: new Date() });
  assert.equal(plano(await s.matriz()).reglas, 1, 'sin esperar el vencimiento de la copia');
  s.prisma.estado.falla = new Error('MySQL apagado');
  await assert.rejects(s.matriz(), /MySQL apagado/);
});

// ── Aplicar cambios ─────────────────────────────────────────────────────────────────────────────────────────────

const cambio = (clave, rol, permitido) => ({ clave, rol, permitido });

test('aplicar un cambio lo guarda con quién y cuándo, rige al instante y queda auditado con el antes y el después', async () => {
  const s = servicio();
  const r = plano(await s.aplicarCambios(admin, [cambio(VENTAS, 'auditor', true), cambio(CATEGORIAS, 'vendedor', false)]));
  assert.deepEqual(r.aplicados.map((a) => [a.clave, a.rol, a.antes, a.despues]), [[VENTAS, 'auditor', false, true], [CATEGORIAS, 'vendedor', true, false]]);
  assert.equal(r.sinCambios, 0);
  assert.equal(r.auditado, true);
  const guardada = s.prisma.estado.reglas.find((x) => x.ruta === VENTAS);
  assert.deepEqual([guardada.rol_id, guardada.permitido, guardada.actualizado_por], [4, true, 9]);
  assert.equal((await s.permite(rosa, VENTAS, ADMIN)).permitido, true, 'sin esperar los 5 s: este proceso invalida su copia');
  assert.equal((await s.permite(luis, CATEGORIAS, VENDEDORES)).permitido, false);
  assert.deepEqual(plano(s.auditoria.eventos).map((e) => [e.tipo, e.actor, e.objetivo.id, e.antes, e.despues]), [
    ['regla', { id: 9, rol: 'administrador' }, VENTAS, { rol: 'auditor', permitido: false }, { rol: 'auditor', permitido: true }],
    ['regla', { id: 9, rol: 'administrador' }, CATEGORIAS, { rol: 'vendedor', permitido: true }, { rol: 'vendedor', permitido: false }],
  ]);
});

test('dejar una celda como la declara el código borra la regla en vez de guardar una fila que no cambia nada', async () => {
  const s = servicio({ reglas: [reglaDe(2, CATEGORIAS, false)] });
  const r = plano(await s.aplicarCambios(admin, [cambio(CATEGORIAS, 'vendedor', true)]));
  assert.equal(r.aplicados.length, 1);
  assert.equal(s.prisma.estado.reglas.length, 0);
  assert.equal((await s.permite(luis, CATEGORIAS, VENDEDORES)).origen, 'codigo');
});

test('un cambio que no cambia nada no escribe ni audita', async () => {
  const s = servicio();
  const r = plano(await s.aplicarCambios(admin, [cambio(VENTAS, 'comprador', false), cambio(CATEGORIAS, 'vendedor', true)]));
  assert.deepEqual([r.aplicados.length, r.sinCambios], [0, 2]);
  assert.equal(s.prisma.estado.reglas.length, 0);
  assert.equal(s.auditoria.eventos.length, 0);
  assert.ok(!s.prisma.estado.consultas.includes('acl_regla.upsert'));
});

test('el lote es todo o nada: un cambio inválido no deja aplicar ninguno de los demás', async () => {
  const s = servicio();
  const invalidos = [
    [[cambio(VENTAS, 'auditor', true), cambio('GET /no-existe', 'auditor', true)], 400, /no es una ruta por roles/],
    [[cambio(VENTAS, 'auditor', true), cambio(HISTORIAL, 'comprador', true)], 400, /no se puede cambiar desde la pantalla.*dueño/],
    [[cambio(VENTAS, 'auditor', true), cambio(PERMISOS, 'auditor', true)], 400, /no se puede cambiar/],
    [[cambio(VENTAS, 'auditor', true), cambio(VENTAS, 'administrador', false)], 400, /administrador conserva todas/],
    [[cambio(VENTAS, 'auditor', true), cambio(VENTAS, 'fantasma', true)], 404, /no existe/],
    [[cambio(VENTAS, 'auditor', true), cambio(VENTAS, 'auditor', false)], 400, /repetido/],
    [[cambio(VENTAS, 'auditor', true), { clave: VENTAS, rol: 'auditor', permitido: 'si' }], 400, /permitido/],
    [[cambio(VENTAS, 'auditor', true), null], 400, /clave, rol y permitido/],
    [[], 400, /No hay cambios/],
    ['no es un arreglo', 400, /No hay cambios/],
  ];
  for (const [cambios, estado, mensaje] of invalidos) {
    await assert.rejects(s.aplicarCambios(admin, cambios), (err) => err.status === estado && mensaje.test(err.message), JSON.stringify(cambios));
  }
  assert.equal(s.prisma.estado.reglas.length, 0, 'ningún lote inválido dejó nada escrito');
  assert.equal(s.auditoria.eventos.length, 0);
});

test('hay un tope de cambios por lote', async () => {
  const s = servicio();
  const muchos = Array.from({ length: 201 }, () => cambio(VENTAS, 'auditor', true));
  await assert.rejects(s.aplicarCambios(admin, muchos), (err) => err.status === 400 && /demasiados/.test(err.message));
});

test('si la transacción falla a mitad de camino no queda ninguna regla a medias, ni se audita', async () => {
  const s = servicio();
  const original = s.prisma.acl_regla.upsert;
  let llamadas = 0;
  s.prisma.acl_regla.upsert = async (args) => {
    if (++llamadas === 2) throw new Error('se cayó MySQL a mitad del lote');
    return original(args);
  };
  await assert.rejects(s.aplicarCambios(admin, [cambio(VENTAS, 'auditor', true), cambio('GET /api/admin/fraude', 'auditor', true)]), /a mitad del lote/);
  assert.equal(s.prisma.estado.reglas.length, 0, 'la primera regla se deshizo');
  assert.equal(s.auditoria.eventos.length, 0);
});

test('si la auditoría (Mongo) no responde, el cambio igual se aplica y se avisa que no se registró', async () => {
  const s = servicio({ falla: true });
  const r = plano(await s.aplicarCambios(admin, [cambio(VENTAS, 'auditor', true)]));
  assert.equal(r.auditado, false);
  assert.equal(s.prisma.estado.reglas.length, 1, 'revocar un acceso no puede esperar a que Mongo vuelva');
  assert.equal(s.prisma.estado.reglas[0].actualizado_por, 9, 'MySQL guarda al menos quién y cuándo');
});

// ── Restaurar ───────────────────────────────────────────────────────────────────────────────────────────────────

const reglasVarias = () => [reglaDe(4, VENTAS, true), reglaDe(4, 'GET /api/admin/fraude', true), reglaDe(2, CATEGORIAS, false)];

test('restaurar sin filtros vuelve toda la política a lo que declara el código, y audita lo que había', async () => {
  const s = servicio({ reglas: reglasVarias() });
  const r = plano(await s.restaurar(admin, {}));
  assert.deepEqual([r.restauradas, r.auditado], [3, true]);
  assert.equal(s.prisma.estado.reglas.length, 0);
  assert.equal((await s.permite(rosa, VENTAS, ADMIN)).permitido, false, 'rige al instante');
  const [evento] = plano(s.auditoria.eventos);
  assert.equal(evento.tipo, 'restaurar');
  assert.equal(evento.antes.length, 3);
  assert.deepEqual(evento.antes.map((a) => [a.rol, a.clave, a.permitido]).sort(), [['auditor', 'GET /api/admin/fraude', true], ['auditor', VENTAS, true], ['vendedor', CATEGORIAS, false]]);
});

test('restaurar una ruta, o un rol, toca solo eso', async () => {
  const porRuta = servicio({ reglas: reglasVarias() });
  assert.equal(plano(await porRuta.restaurar(admin, { clave: VENTAS })).restauradas, 1);
  assert.deepEqual(porRuta.prisma.estado.reglas.map((r) => r.ruta).sort(), ['GET /api/admin/fraude', CATEGORIAS]);
  const porRol = servicio({ reglas: reglasVarias() });
  assert.equal(plano(await porRol.restaurar(admin, { rol: 'auditor' })).restauradas, 2);
  assert.deepEqual(porRol.prisma.estado.reglas.map((r) => r.ruta), [CATEGORIAS]);
});

test('restaurar cuando no hay nada que restaurar no audita nada', async () => {
  const s = servicio();
  assert.deepEqual(plano(await s.restaurar(admin, {})), { restauradas: 0, auditado: true });
  assert.equal(s.auditoria.eventos.length, 0);
});

test('restaurar rechaza una ruta o un rol que no existen', async () => {
  const s = servicio({ reglas: reglasVarias() });
  await assert.rejects(s.restaurar(admin, { clave: 'GET /no-existe' }), (err) => err.status === 400);
  await assert.rejects(s.restaurar(admin, { rol: 'fantasma' }), (err) => err.status === 404);
  assert.equal(s.prisma.estado.reglas.length, 3);
});

// ── El simulador ────────────────────────────────────────────────────────────────────────────────────────────────

test('el simulador responde con la MISMA decisión que la API aplica, y dice por qué', async () => {
  const s = servicio({ reglas: [{ ...reglaDe(4, VENTAS, true), actualizado_por: 9 }] });
  for (const [rol, clave, base, usuario] of [['auditor', VENTAS, ADMIN, rosa], ['vendedor', VENTAS, ADMIN, luis], ['vendedor', CATEGORIAS, VENDEDORES, luis], ['comprador', CATEGORIAS, VENDEDORES, ana], ['administrador', VENTAS, ADMIN, admin]]) {
    const simulado = await s.simular({ rol, clave });
    const real = await s.permite(usuario, clave, base);
    assert.equal(simulado.permitido, real.permitido, `${rol} en ${clave}`);
    assert.equal(simulado.origen, real.origen, `${rol} en ${clave}`);
  }
});

test('los motivos del simulador cuentan qué regla decidió: el código, un administrador, o ninguna regla', async () => {
  const s = servicio({ reglas: [{ ...reglaDe(4, VENTAS, true), actualizado_por: 9, actualizado_en: new Date('2026-10-21T15:30:00Z') }] });
  const concedida = await s.simular({ rol: 'auditor', clave: VENTAS });
  assert.equal(concedida.permitido, true);
  assert.match(concedida.motivo, /Un administrador lo permitió el .*\(Admin Uno\); el código no incluye a «auditor»/);
  assert.equal(concedida.regla.permitido, true);
  const negada = await s.simular({ rol: 'comprador', clave: VENTAS });
  assert.equal(negada.permitido, false);
  assert.match(negada.motivo, /Se niega: el código no incluye a «comprador» en esta ruta \(lista blanca: «administrador»\)/);
  assert.match((await s.simular({ rol: 'vendedor', clave: CATEGORIAS })).motivo, /Lo permite el código: el código sí permite a «vendedor»/);
  assert.match((await s.simular({ rol: 'administrador', clave: VENTAS })).motivo, /conserva todas las rutas/);
  const fija = await s.simular({ rol: 'comprador', clave: HISTORIAL });
  assert.match(fija.motivo, /Ruta fija:/);
  assert.ok(fija.detalles.some((d) => /sea de quien pregunta/.test(d)), 'avisa que además se comprueba el dueño');
});

test('las rutas públicas o con solo sesión no dependen del rol', async () => {
  const s = servicio();
  const publica = await s.simular({ rol: 'comprador', clave: 'GET /api/categorias' });
  assert.deepEqual([publica.permitido, publica.origen], [true, 'publica']);
  const conSesion = await s.simular({ rol: 'auditor', clave: 'GET /api/carrito' });
  assert.deepEqual([conSesion.permitido, conSesion.origen], [true, 'sesion']);
  assert.match(conSesion.motivo, /cualquier cuenta con sesión/);
});

test('simular una cuenta usa el rol que esa cuenta tiene hoy', async () => {
  const s = servicio();
  const r = plano(await s.simular({ usuarioId: '11', clave: CATEGORIAS }));
  assert.equal(r.rol, 'auditor');
  assert.deepEqual(r.cuenta, { id: 11, nombre: 'Rosa Auditora', correo: 'rosa@example.com' });
  assert.equal(r.permitido, false);
});

test('el simulador rechaza lo que no existe: ruta, rol, cuenta o falta de datos', async () => {
  const s = servicio();
  await assert.rejects(s.simular({ rol: 'vendedor', clave: 'GET /no-existe' }), (err) => err.status === 404);
  await assert.rejects(s.simular({ rol: 'fantasma', clave: VENTAS }), (err) => err.status === 404);
  await assert.rejects(s.simular({ usuarioId: '404', clave: VENTAS }), (err) => err.status === 404);
  await assert.rejects(s.simular({ usuarioId: 'abc', clave: VENTAS }), (err) => err.status === 400);
  await assert.rejects(s.simular({ clave: VENTAS }), (err) => err.status === 400 && /rol o una cuenta/.test(err.message));
});

test('el simulador lee la base ahora, no la copia: refleja un cambio de otro proceso al instante', async () => {
  const s = servicio();
  assert.equal((await s.simular({ rol: 'auditor', clave: VENTAS })).permitido, false);
  s.prisma.estado.reglas.push({ id: 7, rol_id: 4, ruta: VENTAS, permitido: true, actualizado_por: null, actualizado_en: new Date() });
  assert.equal((await s.simular({ rol: 'auditor', clave: VENTAS })).permitido, true);
});

// ── Lo que ve la interfaz ───────────────────────────────────────────────────────────────────────────────────────

test('permisosDe lista las rutas por roles que un rol puede usar hoy', async () => {
  const s = servicio({ reglas: [reglaDe(4, VENTAS, true)] });
  const delAuditor = plano(await s.permisosDe('auditor'));
  assert.deepEqual(delAuditor, [VENTAS]);
  const delComprador = plano(await s.permisosDe('comprador'));
  assert.deepEqual(delComprador, []);
  const delVendedor = plano(await s.permisosDe('vendedor'));
  assert.ok(delVendedor.includes(CATEGORIAS) && delVendedor.includes('POST /api/productos') && !delVendedor.includes(VENTAS));
  const delAdmin = plano(await s.permisosDe('administrador'));
  assert.ok(delAdmin.includes(VENTAS) && delAdmin.includes(PERMISOS) && delAdmin.length >= 25);
});
