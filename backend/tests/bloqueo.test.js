const test = require('node:test');
const assert = require('node:assert/strict');
const { escenario, cuenta, ficha, hallazgoPersona, hallazgoGasto } = require('./bloqueoHelpers');

const HORA = 3600000;
const base = { motivo: 'm', corroboradores: [] };

test('cada hallazgo apunta a quien corresponde y su nivel decide el tipo: «alta» suspende, «posible» restringe', () => {
  const { servicio } = escenario({ usuarios: [] });
  const candidatos = servicio.candidatosDeHallazgos({
    cuentasRelacionadas: [hallazgoPersona([1, 2]), hallazgoPersona([5, 6], 'posible')],
    autocompra: [
      { ...base, nivelConfianza: 'alta', mismaCuenta: false, mismoNombre: true, mismoBuzon: false, pedidos: 2, total: 90, comprador: { id: 3, nombre: 'C3', ficha: ficha(3) }, vendedor: { id: 4, nombre: 'C4', ficha: ficha(4, 'vendedor') } },
      { ...base, nivelConfianza: 'alta', mismaCuenta: true, pedidos: 1, total: 10, comprador: { id: 7, nombre: 'C7', ficha: ficha(7) }, vendedor: { id: 7, nombre: 'C7', ficha: ficha(7) } },
      { ...base, nivelConfianza: 'posible', mismaCuenta: true, pedidos: 1, total: 10, comprador: { id: 8, nombre: 'C8', ficha: ficha(8) }, vendedor: { id: 8, nombre: 'C8', ficha: ficha(8) } },
    ],
    reventa: [
      {
        ...base,
        nivelConfianza: 'alta',
        vendedor: { id: 10, nombre: 'C10', ficha: ficha(10, 'vendedor') },
        publicacion: { id: 99, descripcion: 'Reloj' },
        originales: [{ producto: { id: 5, descripcion: 'Reloj' }, vendedor: { id: 11, nombre: 'C11', ficha: ficha(11, 'vendedor') } }],
        listadaDespues: true,
        mismosAtributos: true,
      },
    ],
    rafagaGasto: [{ ...base, nivelConfianza: 'alta', usuario: { id: 12, nombre: 'C12', ficha: ficha(12) }, dia: '2026-10-03', pedidos: 6, gastado: 900 }],
    gastoAnomalo: [hallazgoGasto(13, 128), hallazgoGasto(14, 130, 'posible')],
    categoriaInusual: [{ ...base, nivelConfianza: 'alta', usuario: { id: 15, nombre: 'C15', ficha: ficha(15) }, compraId: 140, categoria: 'Hogar', ordenesPrevias: 6 }],
    // Las reseñas coordinadas no traen nivel de confianza (no están clasificadas): ni suspenden ni restringen.
    resenasCoordinadas: [{ motivo: 'm', usuario1: { id: 20, nombre: 'C20' }, usuario2: { id: 21, nombre: 'C21' }, productos: [] }],
  });

  const resumen = candidatos.map((c) => `${c.nivel}|${c.senal}|${c.usuarioId}|${c.huella}`).sort();
  assert.equal(
    resumen.join('\n'),
    [
      'alta|autocompra|3|autocompra:3>4',
      'alta|autocompra|4|autocompra:3>4', // entre cuentas distintas (la misma persona): las dos
      'alta|autocompra|7|autocompra:7>7', // una cuenta consigo misma: solo esa
      'alta|categoria_inusual|15|categoria_inusual:15:140',
      'alta|cuentas_relacionadas|1|cuentas_relacionadas:1-2',
      'alta|cuentas_relacionadas|2|cuentas_relacionadas:1-2',
      'alta|gasto_anomalo|13|gasto_anomalo:13:128',
      'alta|rafaga_gasto|12|rafaga_gasto:12:2026-10-03',
      'alta|reventa|10|reventa:10:99', // solo quien revende; el vendedor original (11) es la víctima
      'posible|autocompra|8|autocompra:8>8',
      'posible|cuentas_relacionadas|5|cuentas_relacionadas:5-6',
      'posible|cuentas_relacionadas|6|cuentas_relacionadas:5-6',
      'posible|gasto_anomalo|14|gasto_anomalo:14:130',
    ].join('\n')
  );
  const reventa = candidatos.find((c) => c.senal === 'reventa');
  assert.equal(reventa.evidencia.involucradas.map((i) => i.papel).join(','), 'revende,vendedor original', 'la evidencia nombra al vendedor original aunque no se lo suspenda');
});

test('el barrido suspende a las cuentas con un hallazgo alto, nunca a un administrador, y no repite el mismo hallazgo', async () => {
  const e = escenario({
    usuarios: [cuenta(1), cuenta(2), cuenta(3), cuenta(9, 'administrador')],
    hallazgos: { cuentasRelacionadas: [hallazgoPersona([1, 2])], gastoAnomalo: [hallazgoGasto(3, 128), hallazgoGasto(9, 129)] },
  });

  const primera = await e.servicio.evaluar();
  assert.equal(primera.casosNuevos, 3);
  assert.equal(primera.omitidosAdministrador, 1);
  assert.equal(primera.cuentas.length, 3);
  for (const id of [1, 2, 3]) {
    const estado = await e.suspension.estadoBloqueo(id);
    assert.equal(estado.bloqueada, true, `la cuenta ${id} debe quedar suspendida`);
    assert.ok(estado.restanteMs > 23.9 * HORA && estado.restanteMs <= 24 * HORA, 'por las 24 horas de la configuración');
  }
  assert.equal((await e.suspension.estadoBloqueo(9)).bloqueada, false, 'un administrador nunca se suspende');
  assert.equal(e.prisma.filas.length, 3);
  assert.ok(e.prisma.filas.every((f) => f.estado === 'activo' && f.origen === 'automatico'));
  assert.equal(e.prisma.filas.find((f) => f.id_usuario === 1).evidencia.involucradas.length, 2, 'cada caso guarda la evidencia con la que se abrió');

  // El grafo sigue marcando lo mismo, pero ese hallazgo ya suspendió a esas cuentas.
  const segunda = await e.servicio.evaluar();
  assert.equal(segunda.casosNuevos, 0);
  assert.equal(segunda.yaConocidos, 3);
  assert.equal(e.prisma.filas.length, 3);
});

test('dos barridos simultáneos comparten el resultado en vez de repetir las consultas', async () => {
  const e = escenario({ usuarios: [cuenta(1)], hallazgos: { gastoAnomalo: [hallazgoGasto(1, 128)] } });
  const [a, b] = await Promise.all([e.servicio.evaluar(), e.servicio.evaluar()]);
  assert.equal(a, b);
  assert.equal(e.prisma.filas.length, 1);
});

test('liberar levanta la suspensión, deja quién y por qué, y ese hallazgo no vuelve a suspender; uno distinto sí', async () => {
  const e = escenario({ usuarios: [cuenta(1), cuenta(50, 'administrador', 'Rosa')], hallazgos: { gastoAnomalo: [hallazgoGasto(1, 128)] } });
  await e.servicio.evaluar();
  assert.equal((await e.suspension.estadoBloqueo(1)).bloqueada, true);

  const r = await e.servicio.liberar(1, 50, '  Compra legítima de un negocio  ');
  assert.equal(r.casosCerrados, 1);
  assert.equal(r.bloqueoLevantado, true);
  assert.equal((await e.suspension.estadoBloqueo(1)).bloqueada, false);
  const caso = e.prisma.filas[0];
  assert.equal(caso.estado, 'liberado');
  assert.equal(caso.revisado_por, 50);
  assert.equal(caso.nota_revision, 'Compra legítima de un negocio');
  assert.ok(caso.revisado_en instanceof Date);

  // El grafo sigue señalando lo mismo, pero un administrador ya lo revisó: no se vuelve a suspender.
  const otra = await e.servicio.evaluar();
  assert.equal(otra.casosNuevos, 0);
  assert.equal((await e.suspension.estadoBloqueo(1)).bloqueada, false);

  // Un hallazgo DISTINTO de la misma cuenta es evidencia nueva: abre otro caso.
  e.poner({ gastoAnomalo: [hallazgoGasto(1, 128), hallazgoGasto(1, 131)] });
  const nuevo = await e.servicio.evaluar();
  assert.equal(nuevo.casosNuevos, 1);
  assert.equal((await e.suspension.estadoBloqueo(1)).bloqueada, true);

  // Liberar otra vez funciona; con nada que liberar, 404.
  await e.servicio.liberar(1, 50);
  await assert.rejects(e.servicio.liberar(1, 50), (err) => err.status === 404);

  // Reintento tras una liberación a medias (MySQL cerrado, Redis no): quita el bloqueo que quedó.
  await e.suspension.bloquear(1, 60000);
  const reintento = await e.servicio.liberar(1, 50);
  assert.equal(reintento.casosCerrados, 0);
  assert.equal(reintento.bloqueoLevantado, true);
  assert.equal((await e.suspension.estadoBloqueo(1)).bloqueada, false);
});

test('extender suma horas al caso y al bloqueo de Redis, anota la revisión y valida la entrada', async () => {
  const e = escenario({ usuarios: [cuenta(1), cuenta(2)], hallazgos: { gastoAnomalo: [hallazgoGasto(1, 128)] } });
  await e.servicio.evaluar();
  const antes = e.prisma.filas[0].expira_en.getTime();

  const r = await e.servicio.extender(1, 50, 12, 'Se mantiene');
  assert.equal(r.casosExtendidos, 1);
  const caso = e.prisma.filas[0];
  assert.equal(caso.expira_en.getTime(), antes + 12 * HORA);
  assert.equal(caso.estado, 'activo', 'extender no cierra el caso');
  assert.equal(caso.revisado_por, 50);
  assert.equal(caso.nota_revision, 'Se mantiene');
  const restante = (await e.suspension.estadoBloqueo(1)).restanteMs;
  assert.ok(restante > 35.9 * HORA && restante <= 36 * HORA, 'y el TTL de Redis pasa a las 36 horas');

  // Extender otra vez sin nota no borra la anterior.
  await e.servicio.extender(1, 50, 1);
  assert.equal(e.prisma.filas[0].nota_revision, 'Se mantiene');

  await assert.rejects(e.servicio.extender(1, 50, 0), (err) => err.status === 400);
  await assert.rejects(e.servicio.extender(1, 50, 9999), (err) => err.status === 400);
  await assert.rejects(e.servicio.extender(1, 50, 1, 'x'.repeat(501)), (err) => err.status === 400);
  await assert.rejects(e.servicio.extender(2, 50, 1), (err) => err.status === 404, 'una cuenta sin bloqueo no se extiende');
});

test('reconciliar recupera un bloqueo perdido de Redis, quita el que quedó de más y marca lo vencido', async () => {
  const e = escenario({ usuarios: [cuenta(1), cuenta(2)], hallazgos: { gastoAnomalo: [hallazgoGasto(1, 128), hallazgoGasto(2, 129)] } });
  await e.servicio.evaluar();

  // Redis se reinicia y pierde los bloqueos: MySQL, que guarda los casos, los reconstruye.
  e.redis.claves.clear();
  let r = await e.servicio.reconciliar();
  assert.equal(r.reconstruidos, 2);
  const restante = (await e.suspension.estadoBloqueo(1)).restanteMs;
  assert.ok(restante > 23.9 * HORA, 'con lo que falta del vencimiento, no con 24 horas nuevas');

  // Sin diferencias, la siguiente pasada no toca nada.
  r = await e.servicio.reconciliar();
  assert.equal(r.reconstruidos, 0);
  assert.equal(r.huerfanos, 0);

  // Un bloqueo sin ningún caso activo (una liberación a medias, o escrito a mano) se quita.
  await e.suspension.bloquear(77, 60000);
  r = await e.servicio.reconciliar();
  assert.equal(r.huerfanos, 1);
  assert.equal((await e.suspension.estadoBloqueo(77)).bloqueada, false);

  // Pasa el tiempo: Redis suelta el bloqueo por TTL y los casos se marcan vencidos.
  e.redis.avanzar(25 * HORA);
  r = await e.servicio.reconciliar({ ahora: new Date(Date.now() + 25 * HORA) });
  assert.equal(r.vencidos, 2);
  assert.ok(e.prisma.filas.every((f) => f.estado === 'expirado'));
  assert.equal((await e.suspension.estadoBloqueo(1)).bloqueada, false);

  // Y lo vencido no vuelve a suspender: ese hallazgo ya cumplió su tiempo.
  const otra = await e.servicio.evaluar();
  assert.equal(otra.casosNuevos, 0);
  assert.equal((await e.suspension.estadoBloqueo(1)).bloqueada, false);
});

test('si Redis falla al abrir el caso, el caso queda en MySQL y el siguiente barrido reconstruye el bloqueo', async () => {
  const e = escenario({ usuarios: [cuenta(1)], hallazgos: { gastoAnomalo: [hallazgoGasto(1, 128)] } });
  const escribir = e.redis.bloquearCuenta;
  e.redis.bloquearCuenta = async () => {
    throw new Error('Redis caído');
  };
  const r = await e.servicio.evaluar();
  assert.equal(r.casosNuevos, 1);
  assert.equal(e.prisma.filas.length, 1);
  assert.equal((await e.suspension.estadoBloqueo(1)).bloqueada, false);

  e.redis.bloquearCuenta = escribir;
  const reconciliado = await e.servicio.reconciliar();
  assert.equal(reconciliado.reconstruidos, 1);
  assert.equal((await e.suspension.estadoBloqueo(1)).bloqueada, true);
});

test('exigirCuentaActiva: 403 con código y fecha para una suspendida; administradores y un Redis caído pasan', async () => {
  const { suspension, redis } = escenario({ usuarios: [] });
  await suspension.exigirCuentaActiva(1, 'comprador'); // sin bloqueo: pasa

  await suspension.bloquear(1, 2 * HORA);
  await assert.rejects(
    suspension.exigirCuentaActiva(1, 'comprador'),
    (err) =>
      err.status === 403 &&
      err.codigo === 'CUENTA_SUSPENDIDA' &&
      /suspendida temporalmente/.test(err.message) &&
      Math.abs(new Date(err.hasta).getTime() - (Date.now() + 2 * HORA)) < 5000
  );
  await suspension.exigirCuentaActiva(1, 'administrador'); // exento aunque la clave exista

  // Fallar abierto: Redis caído no deja a todo el sitio sin poder entrar.
  redis.pttl = async () => {
    throw new Error('Redis caído');
  };
  await suspension.exigirCuentaActiva(1, 'comprador');
});

test('el bloqueo de Redis solo se alarga: un segundo hallazgo no acorta una suspensión que ya corre', async () => {
  const { suspension } = escenario({ usuarios: [] });
  assert.equal(await suspension.bloquear(1, 10 * HORA), true);
  assert.equal(await suspension.bloquear(1, 2 * HORA), false, 'uno más corto no escribe');
  assert.ok((await suspension.estadoBloqueo(1)).restanteMs > 9.9 * HORA);
  assert.equal(await suspension.bloquear(1, 20 * HORA), true, 'uno más largo sí');
  assert.ok((await suspension.estadoBloqueo(1)).restanteMs > 19.9 * HORA);
  await assert.rejects(suspension.bloquear(1, 0), /positiva/);
});

test('listar agrupa por cuenta, deja primero lo pendiente de revisión y guarda en el historial quién decidió', async () => {
  const e = escenario({
    usuarios: [cuenta(1), cuenta(2), cuenta(3), cuenta(50, 'administrador', 'Rosa')],
    hallazgos: { cuentasRelacionadas: [hallazgoPersona([1, 2])], gastoAnomalo: [hallazgoGasto(1, 128), hallazgoGasto(3, 129)] },
  });
  await e.servicio.evaluar(); // la cuenta 1 con dos casos, la 2 y la 3 con uno
  await e.servicio.extender(3, 50, 2, 'Revisado: se mantiene');

  let lista = await e.servicio.listar();
  assert.equal(lista.resumen.activas, 3);
  assert.equal(lista.resumen.pendientesDeRevision, 2);
  const uno = lista.activas.find((a) => a.usuario.id === 1);
  assert.equal(uno.casos.length, 2);
  assert.equal(uno.revisado, null);
  assert.ok(uno.restanteSegundos > 23.9 * 3600);
  const tres = lista.activas.find((a) => a.usuario.id === 3);
  assert.equal(tres.revisado.nota, 'Revisado: se mantiene');
  assert.equal(tres.revisado.por, 'Rosa Prueba');
  assert.equal(lista.activas[2].usuario.id, 3, 'lo ya revisado queda al final');
  assert.equal(lista.configuracion.horas, 24);

  await e.servicio.liberar(1, 50, 'Falso positivo');
  lista = await e.servicio.listar();
  assert.equal(lista.resumen.activas, 2);
  assert.equal(lista.historial.length, 2, 'los dos casos de la cuenta 1');
  assert.equal(lista.historial[0].estado, 'liberado');
  assert.equal(lista.historial[0].revisado.por, 'Rosa Prueba');
  assert.equal(lista.historial[0].revisado.nota, 'Falso positivo');
  assert.equal(lista.historial[0].usuario.nombre, 'Cuenta1 Prueba');
});

test('la configuración se valida en vez de caer en el defecto sin avisar', () => {
  const { servicio } = escenario({ usuarios: [] });
  const defecto = servicio.configuracion({});
  assert.equal(defecto.habilitado, true);
  assert.equal(defecto.horas, 24);
  assert.equal(defecto.duracionMs, 24 * HORA);
  assert.equal(defecto.intervaloMs, 60000);
  assert.equal(servicio.configuracion({ FRAUDE_BLOQUEO_ENABLED: 'false' }).habilitado, false);
  assert.equal(servicio.configuracion({ FRAUDE_BLOQUEO_HORAS: '0.5' }).duracionMs, 30 * 60000);
  assert.throws(() => servicio.configuracion({ FRAUDE_BLOQUEO_HORAS: '0' }), /FRAUDE_BLOQUEO_HORAS/);
  assert.throws(() => servicio.configuracion({ FRAUDE_BLOQUEO_HORAS: 'mucho' }), /FRAUDE_BLOQUEO_HORAS/);
  assert.throws(() => servicio.configuracion({ FRAUDE_BLOQUEO_INTERVALO_MS: '10' }), /FRAUDE_BLOQUEO_INTERVALO_MS/);
});
