const test = require('node:test');
const assert = require('node:assert/strict');
const { escenario, cuenta, hallazgoPersona, hallazgoGasto } = require('./bloqueoHelpers');

const HORA = 3600000;

// Respuesta escalonada (bloqueoService.js, PLAN §21): un hallazgo «alta» suspende y uno
// «posible» restringe — la cuenta sigue comprando, con límites. La parte de las
// suspensiones está en bloqueo.test.js.

test('un hallazgo «posible» restringe en vez de suspender: la cuenta entra, con límites; un administrador queda fuera', async () => {
  const e = escenario({
    usuarios: [cuenta(1), cuenta(2), cuenta(9, 'administrador')],
    hallazgos: {
      gastoAnomalo: [hallazgoGasto(1, 128, 'posible'), hallazgoGasto(9, 130, 'posible')],
      cuentasRelacionadas: [hallazgoPersona([2, 3], 'posible')], // la cuenta 3 ya no existe
    },
  });

  const r = await e.servicio.evaluar();
  assert.equal(r.casosNuevos, 0, 'ningún hallazgo es «alta»: no se suspende a nadie');
  assert.equal(r.restriccionesNuevas, 2);
  assert.equal(r.restringidas.length, 2);
  assert.equal(r.omitidosAdministrador, 1, 'un administrador tampoco se restringe');
  for (const id of [1, 2]) {
    assert.equal((await e.suspension.estadoBloqueo(id)).bloqueada, false, `la cuenta ${id} puede entrar`);
    const limites = await e.restriccion.limitesDe(id, 'comprador');
    assert.equal(limites.montoMaximo, 500);
    assert.equal(limites.pedidosPorHora, 2);
    assert.ok(limites.hasta.getTime() - Date.now() > 23.9 * HORA, 'por las 24 horas de la restricción');
  }
  assert.equal(await e.restriccion.limitesDe(9, 'administrador'), null);
  assert.equal(await e.restriccion.limitesDe(5, 'comprador'), null, 'una cuenta sin restricción no tiene límites');
  assert.ok(e.prisma.filas.every((f) => f.tipo === 'restriccion' && f.estado === 'activo'));

  const otra = await e.servicio.evaluar();
  assert.equal(otra.restriccionesNuevas, 0, 'el mismo hallazgo no restringe dos veces');
  assert.equal(e.prisma.filas.length, 2);
});

test('si el mismo hallazgo se corrobora y pasa a «alta», además de la restricción se abre la suspensión', async () => {
  const e = escenario({ usuarios: [cuenta(1)], hallazgos: { gastoAnomalo: [hallazgoGasto(1, 128, 'posible')] } });
  await e.servicio.evaluar();
  assert.equal((await e.suspension.estadoBloqueo(1)).bloqueada, false);

  e.poner({ gastoAnomalo: [hallazgoGasto(1, 128, 'alta')] }); // lo corrobora otra señal
  const r = await e.servicio.evaluar();
  assert.equal(r.casosNuevos, 1, 'la evidencia es nueva: se suspende');
  assert.equal(e.prisma.filas.length, 2);
  assert.equal(e.prisma.filas.map((f) => f.tipo).sort().join(','), 'restriccion,suspension');
  assert.equal((await e.suspension.estadoBloqueo(1)).bloqueada, true);
  assert.ok(await e.restriccion.limitesDe(1, 'comprador'), 'la restricción sigue vigente');

  // Liberar la suspensión no toca la restricción.
  await e.servicio.liberar(1, 50);
  assert.equal((await e.suspension.estadoBloqueo(1)).bloqueada, false);
  assert.ok(await e.restriccion.limitesDe(1, 'comprador'));
});

test('un «posible» ya revisado, o que ya es «alta», no vuelve a restringir', async () => {
  const e = escenario({ usuarios: [cuenta(1), cuenta(50, 'administrador', 'Rosa')], hallazgos: { gastoAnomalo: [hallazgoGasto(1, 128, 'posible')] } });
  await e.servicio.evaluar();
  const r = await e.servicio.quitarRestriccion(1, 50, 'Es un cliente habitual');
  assert.equal(r.casosCerrados, 1);
  assert.equal(r.restriccionLevantada, true);
  assert.equal(await e.restriccion.limitesDe(1, 'comprador'), null);
  const caso = e.prisma.filas[0];
  assert.equal(caso.estado, 'liberado');
  assert.equal(caso.revisado_por, 50);
  assert.equal(caso.nota_revision, 'Es un cliente habitual');
  assert.equal((await e.servicio.evaluar()).restriccionesNuevas, 0, 'el hallazgo ya fue revisado: el grafo lo sigue marcando y no vuelve');
  assert.equal(await e.restriccion.limitesDe(1, 'comprador'), null);

  // Quitar una restricción que no existe, 404.
  await assert.rejects(e.servicio.quitarRestriccion(1, 50), (err) => err.status === 404);

  // Un hallazgo que ya suspendió (alta) y después baja a «posible» tampoco restringe: ya hay un caso.
  const f = escenario({ usuarios: [cuenta(2)], hallazgos: { gastoAnomalo: [hallazgoGasto(2, 130, 'alta')] } });
  await f.servicio.evaluar();
  f.poner({ gastoAnomalo: [hallazgoGasto(2, 130, 'posible')] });
  assert.equal((await f.servicio.evaluar()).restriccionesNuevas, 0);
  assert.equal(f.prisma.filas.length, 1);
});

test('la restricción y la suspensión son independientes: quitar una no toca la otra', async () => {
  const e = escenario({
    usuarios: [cuenta(1), cuenta(50, 'administrador')],
    hallazgos: { gastoAnomalo: [hallazgoGasto(1, 128, 'alta')], cuentasRelacionadas: [hallazgoPersona([1, 4], 'posible')] },
  });
  const r = await e.servicio.evaluar();
  assert.equal(r.casosNuevos, 1);
  assert.equal(r.restriccionesNuevas, 1);

  await e.servicio.quitarRestriccion(1, 50);
  assert.equal(await e.restriccion.limitesDe(1, 'comprador'), null);
  assert.equal((await e.suspension.estadoBloqueo(1)).bloqueada, true, 'seguía suspendida');
  const extendida = await e.servicio.extender(1, 50, 2); // extender solo aplica a la suspensión
  assert.equal(extendida.casosExtendidos, 1);
});

test('reconciliar repone y limpia cada candado por separado', async () => {
  const e = escenario({ usuarios: [cuenta(1), cuenta(2)], hallazgos: { gastoAnomalo: [hallazgoGasto(1, 128, 'alta'), hallazgoGasto(2, 129, 'posible')] } });
  await e.servicio.evaluar();
  e.redis.claves.clear(); // Redis se reinicia y pierde los dos
  let r = await e.servicio.reconciliar();
  assert.equal(r.reconstruidos, 2);
  assert.equal((await e.suspension.estadoBloqueo(1)).bloqueada, true);
  assert.ok(await e.restriccion.limitesDe(2, 'comprador'));

  // Un candado de cada tipo sin ningún caso activo se quita; los legítimos no se tocan.
  await e.suspension.bloquear(78, 60000);
  await e.restriccion.candado.bloquear(77, 60000);
  r = await e.servicio.reconciliar();
  assert.equal(r.huerfanos, 2);
  assert.equal((await e.suspension.estadoBloqueo(78)).bloqueada, false);
  assert.equal(await e.restriccion.limitesDe(77, 'comprador'), null);
  assert.equal((await e.suspension.estadoBloqueo(1)).bloqueada, true);
  assert.ok(await e.restriccion.limitesDe(2, 'comprador'));

  // Pasa el tiempo: los candados vencen solos por TTL y los dos casos se marcan vencidos.
  e.redis.avanzar(25 * HORA);
  r = await e.servicio.reconciliar({ ahora: new Date(Date.now() + 25 * HORA) });
  assert.equal(r.vencidos, 2);
  assert.equal(await e.restriccion.limitesDe(2, 'comprador'), null);
});

test('los límites suaves se pueden apagar o configurar, y una mala configuración no impide suspender', async () => {
  const apagado = escenario({ usuarios: [cuenta(1)], hallazgos: { gastoAnomalo: [hallazgoGasto(1, 128, 'posible')] }, entorno: { RESTRICCION_ENABLED: 'false' } });
  assert.equal((await apagado.servicio.evaluar()).restriccionesNuevas, 0, 'apagados, no se abren casos que no tendrían efecto');
  assert.equal(apagado.prisma.filas.length, 0);

  const malo = escenario({
    usuarios: [cuenta(1), cuenta(2)],
    hallazgos: { gastoAnomalo: [hallazgoGasto(1, 128, 'posible'), hallazgoGasto(2, 129, 'alta')] },
    entorno: { RESTRICCION_MONTO_MAXIMO: 'mucho' },
  });
  const r = await malo.servicio.evaluar();
  assert.equal(r.casosNuevos, 1, 'la suspensión sigue funcionando');
  assert.equal(r.restriccionesNuevas, 0);
  assert.match(r.advertencias.join(' '), /RESTRICCION_MONTO_MAXIMO/);

  const sinTopes = escenario({ usuarios: [], entorno: { RESTRICCION_MONTO_MAXIMO: '0', RESTRICCION_PEDIDOS_HORA: '0' } });
  await sinTopes.restriccion.candado.bloquear(1, 60000);
  const limites = await sinTopes.restriccion.limitesDe(1, 'comprador');
  assert.equal(limites.montoMaximo, null, '0 = sin tope de monto');
  assert.equal(limites.pedidosPorHora, null, '0 = sin tope propio de pedidos');

  const propios = escenario({ usuarios: [], entorno: { RESTRICCION_MONTO_MAXIMO: '1200', RESTRICCION_PEDIDOS_HORA: '1', FRAUDE_RESTRICCION_HORAS: '6' } });
  await propios.restriccion.candado.bloquear(1, 60000);
  const configurados = await propios.restriccion.limitesDe(1, 'comprador');
  assert.equal(configurados.montoMaximo, 1200);
  assert.equal(configurados.pedidosPorHora, 1);
  assert.equal(propios.restriccion.configuracion({ FRAUDE_RESTRICCION_HORAS: '6' }).duracionMs, 6 * HORA);
  assert.throws(() => propios.restriccion.configuracion({ FRAUDE_RESTRICCION_HORAS: '0' }), /FRAUDE_RESTRICCION_HORAS/);

  // Fallar abierto: sin Redis nadie queda restringido.
  const caido = escenario({ usuarios: [] });
  caido.redis.pttl = async () => {
    throw new Error('Redis caído');
  };
  assert.equal(await caido.restriccion.limitesDe(1, 'comprador'), null);
});

test('listar separa las restricciones de las suspensiones y el historial dice de qué tipo era cada caso', async () => {
  const e = escenario({
    usuarios: [cuenta(1), cuenta(2), cuenta(50, 'administrador', 'Rosa')],
    hallazgos: { gastoAnomalo: [hallazgoGasto(1, 128, 'alta'), hallazgoGasto(2, 129, 'posible')] },
  });
  await e.servicio.evaluar();
  let lista = await e.servicio.listar();
  assert.equal(lista.resumen.activas, 1);
  assert.equal(lista.resumen.restringidas, 1);
  assert.equal(lista.activas[0].usuario.id, 1);
  assert.equal(lista.restringidas[0].usuario.id, 2);
  assert.equal(lista.restringidas[0].casos[0].tipo, 'restriccion');
  assert.ok(lista.restringidas[0].restanteSegundos > 23.9 * 3600);
  assert.equal(lista.configuracion.restriccion.montoMaximo, 500);
  assert.equal(lista.configuracion.restriccion.pedidosPorHora, 2);

  await e.servicio.quitarRestriccion(2, 50, 'Falso positivo');
  lista = await e.servicio.listar();
  assert.equal(lista.resumen.restringidas, 0);
  assert.equal(lista.historial.length, 1);
  assert.equal(lista.historial[0].tipo, 'restriccion');
  assert.equal(lista.historial[0].revisado.nota, 'Falso positivo');
});
