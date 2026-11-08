const test = require('node:test');
const assert = require('node:assert/strict');
const { correosExentos, esCorreoExento } = require('../src/services/fraudeExencionesFlashService');
const { escenario, cuenta, hallazgoGasto } = require('./bloqueoHelpers');

const habilitado = { FRAUDE_EXENTOS_FLASH_ENABLED: 'true' };
const vendedor = () => ({ ...cuenta(1, 'vendedor'), correo: 'luis.ramirez@example.com' });
const comprador = () => ({ ...cuenta(2), correo: 'flash.test.01@example.com' });

test('la excepción flash es optativa, exacta y nunca funciona en producción', () => {
  assert.equal(correosExentos({}).length, 0);
  assert.equal(correosExentos({ ...habilitado, NODE_ENV: 'production' }).length, 0);
  assert.equal(correosExentos(habilitado).length, 101);
  for (const correo of ['luis.ramirez@example.com', 'flash.test.01@example.com', 'flash.test.100@example.com']) {
    assert.equal(esCorreoExento(correo, habilitado), true);
  }
  for (const correo of ['ana.gomez@example.com', 'flash.test.101@example.com', 'flash.test.1@example.com', 'flash.test.01@example.com.otro', undefined]) {
    assert.equal(esCorreoExento(correo, habilitado), false);
  }
});

test('el barrido omite suspensión y restricciones de las cuentas flash y conserva las de otras cuentas', async () => {
  const e = escenario({
    usuarios: [vendedor(), comprador(), cuenta(3)], entorno: habilitado,
    hallazgos: { gastoAnomalo: [hallazgoGasto(1, 1), hallazgoGasto(2, 2, 'posible'), hallazgoGasto(3, 3)] },
  });
  const r = await e.servicio.evaluar();
  assert.equal(r.omitidosPruebaFlash, 2);
  assert.equal(r.casosNuevos, 1);
  assert.equal(r.restriccionesNuevas, 0);
  assert.deepEqual(e.prisma.filas.map(f => f.id_usuario), [3]);
  assert.equal((await e.suspension.estaBloqueada(3)).bloqueada, true);
});

test('reconciliar libera casos y candados flash existentes, restaura al vendedor y no afecta otras cuentas', async () => {
  const e = escenario({ usuarios: [vendedor(), comprador(), cuenta(3)], entorno: habilitado });
  for (const [id, tipo] of [[1, 'suspension'], [2, 'restriccion'], [3, 'suspension']]) {
    await e.servicio.abrirCaso({ usuarioId: id, huella: `prueba:${id}`, senal: 'gasto_anomalo', motivo: 'prueba', tipo, duracionMs: 3600000 });
  }
  assert.equal((await e.suspension.vendedoresSuspendidos()).has(1), true);
  await e.servicio.reconciliar();
  await e.servicio.reconciliar();
  assert.equal((await e.suspension.estaBloqueada(1)).bloqueada, false);
  assert.equal((await e.restriccion.candado.estado(2)).activo, false);
  assert.equal((await e.suspension.vendedoresSuspendidos()).has(1), false);
  assert.equal((await e.suspension.estaBloqueada(3)).bloqueada, true);
  assert.equal(e.prisma.filas.find(f => f.id_usuario === 3).estado, 'activo');
  for (const id of [1, 2]) {
    const caso = e.prisma.filas.find(f => f.id_usuario === id);
    assert.equal(caso.estado, 'liberado');
    assert.ok(caso.revisado_en);
    assert.match(caso.nota_revision, /Exención local/);
  }
});

test('con la opción apagada o en producción el vendedor flash se suspende normalmente', async () => {
  for (const entorno of [{}, { ...habilitado, NODE_ENV: 'production' }]) {
    const e = escenario({ usuarios: [vendedor()], entorno, hallazgos: { gastoAnomalo: [hallazgoGasto(1, 1)] } });
    const r = await e.servicio.evaluar();
    assert.equal(r.casosNuevos, 1);
    assert.equal((await e.suspension.estaBloqueada(1)).bloqueada, true);
  }
});

test('una falla al limpiar candados de prueba no detiene el barrido de otras cuentas', async () => {
  const e = escenario({
    usuarios: [vendedor(), cuenta(3)], entorno: habilitado,
    hallazgos: { gastoAnomalo: [hallazgoGasto(1, 1), hallazgoGasto(3, 3)] },
  });
  await e.servicio.abrirCaso({ usuarioId: 1, huella: 'anterior', senal: 'gasto_anomalo', motivo: 'prueba', duracionMs: 3600000 });
  const eliminar = e.redis.del;
  e.redis.del = async (clave) => {
    if (clave === 'bloqueo:1') throw new Error('Redis no permite quitar este candado');
    return eliminar(clave);
  };
  const r = await e.servicio.evaluar();
  assert.equal(r.omitidosPruebaFlash, 1);
  assert.equal(r.casosNuevos, 1);
  assert.equal((await e.suspension.estaBloqueada(3)).bloqueada, true);
});
