const test = require('node:test');
const assert = require('node:assert/strict');
const { cargar } = require('./redisHelpers');
const { prismaFalso, auditoriaRegistro, ROLES_BASE, USUARIOS_BASE } = require('./politicaHelpers');

// usuarioAdminService: las cuentas y los roles de la pantalla /admin/permisos. Lo importante son los límites:
// nadie cambia su propio rol, siempre queda un administrador, los roles del sistema no se borran, un rol con cuentas
// tampoco, y todo cambio queda en la auditoría. Con una base y una auditoría de mentira.
const plano = (valor) => JSON.parse(JSON.stringify(valor));
const admin = { id_usuario: 9, rol: 'administrador' };

function servicio({ reglas = [], usuarios = USUARIOS_BASE, falla = false } = {}) {
  const prisma = prismaFalso({ roles: ROLES_BASE, usuarios, reglas });
  const auditoria = auditoriaRegistro({ falla });
  const olvidados = [];
  let invalidaciones = 0;
  const politica = {
    esRolDelSistema: (nombre) => ['comprador', 'vendedor', 'administrador'].includes(nombre),
    olvidarRol: (id) => olvidados.push(id),
    invalidar: () => { invalidaciones += 1; },
  };
  const modulo = cargar('../src/services/usuarioAdminService.js', {
    '../config/prisma': prisma,
    './politicaAccesoService': politica,
    './auditoriaAccesoService': auditoria,
  });
  return { ...modulo, prisma, auditoria, olvidados, invalidaciones: () => invalidaciones };
}

const rechaza = (promesa, status, texto) => assert.rejects(promesa, (err) => err.status === status && texto.test(err.message), `${status} ${texto}`);

// ── Listar ──────────────────────────────────────────────────────────────────────────────────────────────────────

test('lista las cuentas con su rol, sin la contraseña ni nada que no haga falta', async () => {
  const s = servicio();
  const r = plano(await s.listarUsuarios());
  assert.equal(r.total, 5);
  assert.deepEqual(r.usuarios[0], { id: 1, nombre: 'Ana Gómez', correo: 'ana@example.com', creadoEn: '2026-09-01T00:00:00.000Z', rol: 'comprador', rolId: 1 });
  assert.ok(r.usuarios.every((u) => !('contrasena' in u)));
});

test('busca por correo, nombre, apellido o número de cuenta, y pagina', async () => {
  const s = servicio();
  assert.deepEqual(plano(await s.listarUsuarios({ q: 'LUIS' })).usuarios.map((u) => u.id), [2], 'sin distinguir mayúsculas');
  assert.deepEqual(plano(await s.listarUsuarios({ q: 'example.com' })).total, 5);
  assert.deepEqual(plano(await s.listarUsuarios({ q: 'Auditora' })).usuarios.map((u) => u.id), [11]);
  assert.deepEqual(plano(await s.listarUsuarios({ q: '10' })).usuarios.map((u) => u.id), [10], 'un número también es el id');
  const pagina2 = plano(await s.listarUsuarios({ tamano: 2, pagina: 2 }));
  assert.deepEqual([pagina2.pagina, pagina2.paginas, pagina2.usuarios.map((u) => u.id)], [2, 3, [9, 10]]);
});

test('el tamaño de página tiene tope y los valores raros no rompen nada', async () => {
  const s = servicio();
  assert.equal(plano(await s.listarUsuarios({ tamano: '100000' })).tamano, 100);
  assert.equal(plano(await s.listarUsuarios({ tamano: 'x', pagina: '-4' })).pagina, 1);
  assert.equal(plano(await s.listarUsuarios({ q: 'a'.repeat(500) })).total, 0, 'un texto larguísimo se recorta, no revienta');
});

// ── Cambiar el rol de una cuenta ────────────────────────────────────────────────────────────────────────────────

test('cambiar el rol lo guarda, olvida el rol en memoria y lo audita con el antes y el después', async () => {
  const s = servicio();
  const r = plano(await s.cambiarRol(admin, 1, 'auditor'));
  assert.deepEqual([r.sinCambios, r.rol, r.anterior, r.auditado], [false, 'auditor', 'comprador', true]);
  assert.equal(s.prisma.estado.usuarios.find((u) => u.id_usuario === 1).rol_id, 4);
  assert.deepEqual(s.olvidados, [1], 'rige al instante en este proceso');
  assert.deepEqual(plano(s.auditoria.eventos), [{
    tipo: 'rol_cuenta', actor: { id: 9, rol: 'administrador' }, objetivo: { tipo: 'usuario', id: '1' }, antes: { rol: 'comprador' }, despues: { rol: 'auditor' },
  }]);
});

test('nadie cambia su propio rol: un administrador que se lo quitara a sí mismo se quedaría sin acceso', async () => {
  const s = servicio();
  await rechaza(s.cambiarRol(admin, 9, 'comprador'), 400, /propio rol/);
  await rechaza(s.cambiarRol(admin, '9', 'vendedor'), 400, /propio rol/);
  assert.equal(s.prisma.estado.usuarios.find((u) => u.id_usuario === 9).rol_id, 3);
});

test('siempre queda al menos un administrador', async () => {
  const solo = servicio({ usuarios: USUARIOS_BASE.filter((u) => u.id_usuario !== 10) });
  // El actor es otra cuenta con token de administrador (el rol de hoy es lo que decide en la API); si el objetivo es el único administrador, no se baja.
  await rechaza(solo.cambiarRol({ id_usuario: 99, rol: 'administrador' }, 9, 'comprador'), 409, /al menos un administrador/);
  const dos = servicio();
  assert.equal(plano(await dos.cambiarRol(admin, 10, 'comprador')).rol, 'comprador', 'con otro administrador sí se puede');
});

test('un cambio al mismo rol no escribe ni audita', async () => {
  const s = servicio();
  const r = plano(await s.cambiarRol(admin, 2, 'vendedor'));
  assert.equal(r.sinCambios, true);
  assert.equal(s.auditoria.eventos.length, 0);
  assert.ok(!s.prisma.estado.consultas.includes('usuarios.update'));
  assert.deepEqual(s.olvidados, []);
});

test('el cambio de rol rechaza ids inválidos, cuentas y roles que no existen, y no toca nada', async () => {
  const s = servicio();
  await rechaza(s.cambiarRol(admin, 'abc', 'vendedor'), 400, /id de cuenta/);
  await rechaza(s.cambiarRol(admin, -3, 'vendedor'), 400, /id de cuenta/);
  await rechaza(s.cambiarRol(admin, 1, ''), 400, /rol nuevo/);
  await rechaza(s.cambiarRol(admin, 1, { $ne: 1 }), 400, /rol nuevo/);
  await rechaza(s.cambiarRol(admin, 404, 'vendedor'), 404, /cuenta no existe/);
  await rechaza(s.cambiarRol(admin, 1, 'fantasma'), 404, /«fantasma» no existe/);
  assert.ok(!s.prisma.estado.consultas.includes('usuarios.update'));
  assert.equal(s.auditoria.eventos.length, 0);
});

test('si la auditoría no responde el cambio se aplica igual y se avisa', async () => {
  const s = servicio({ falla: true });
  const r = plano(await s.cambiarRol(admin, 1, 'vendedor'));
  assert.equal(r.auditado, false);
  assert.equal(s.prisma.estado.usuarios.find((u) => u.id_usuario === 1).rol_id, 2);
});

// ── Crear y borrar roles ────────────────────────────────────────────────────────────────────────────────────────

test('crear un rol: minúsculas, sin permisos más que los de un comprador, y queda auditado', async () => {
  const s = servicio();
  const r = plano(await s.crearRol(admin, '  Soporte-N1  '));
  assert.deepEqual([r.nombre, r.sistema, r.usuarios, r.auditado], ['soporte-n1', false, 0, true]);
  assert.ok(s.prisma.estado.roles.some((x) => x.tipo_rol === 'soporte-n1'));
  assert.equal(s.invalidaciones(), 1, 'la política se vuelve a leer: el rol nuevo aparece en la matriz');
  assert.equal(plano(s.auditoria.eventos)[0].tipo, 'rol_creado');
});

test('el nombre de un rol es estricto: sin espacios, acentos, símbolos ni nombres ya usados', async () => {
  const s = servicio();
  for (const malo of ['', 'ab', 'x'.repeat(31), '1auditor', 'con espacio', 'ñandú', 'rol;drop', '<b>x</b>', null, 42, { a: 1 }]) {
    await rechaza(s.crearRol(admin, malo), 400, /minúsculas/);
  }
  for (const repetido of ['vendedor', 'ADMINISTRADOR', 'auditor']) await rechaza(s.crearRol(admin, repetido), 409, /Ya existe/);
  assert.equal(s.prisma.estado.roles.length, 4);
});

test('borrar un rol propio sin cuentas: lo borra con sus reglas y lo audita', async () => {
  const s = servicio({ reglas: [{ rol_id: 4, ruta: 'GET /api/admin/ventas', permitido: true }], usuarios: USUARIOS_BASE.filter((u) => u.rol_id !== 4) });
  const r = plano(await s.eliminarRol(admin, 4));
  assert.deepEqual([r.eliminado, r.reglasBorradas, r.auditado], ['auditor', 1, true]);
  assert.equal(s.prisma.estado.roles.some((x) => x.id === 4), false);
  assert.equal(s.prisma.estado.reglas.length, 0);
  assert.equal(s.invalidaciones(), 1);
  const [evento] = plano(s.auditoria.eventos);
  assert.deepEqual([evento.tipo, evento.objetivo.nombre, evento.detalle], ['rol_eliminado', 'auditor', 'Se borraron 1 regla(s) de permisos del rol']);
});

test('los roles del sistema no se borran, ni un rol que todavía tiene cuentas', async () => {
  const s = servicio();
  for (const id of [1, 2, 3]) await rechaza(s.eliminarRol(admin, id), 400, /rol del sistema/);
  await rechaza(s.eliminarRol(admin, 4), 409, /Una cuenta tiene este rol: cambiales el rol primero/);
  const dos = servicio({ usuarios: [...USUARIOS_BASE, { id_usuario: 12, rol_id: 4, nombres: 'X', apellidos: 'Y', correo: 'x@y.z', creado_en: new Date() }] });
  await rechaza(dos.eliminarRol(admin, 4), 409, /2 cuentas tienen este rol/);
  await rechaza(s.eliminarRol(admin, 404), 404, /no existe/);
  await rechaza(s.eliminarRol(admin, 'abc'), 400, /id de rol/);
  assert.equal(s.prisma.estado.roles.length, 4);
  assert.equal(s.auditoria.eventos.length, 0);
});
