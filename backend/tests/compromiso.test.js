const test = require('node:test');
const assert = require('node:assert/strict');
const { cargar } = require('./redisHelpers');

// compromisoService.js real, con un doble de Prisma que devuelve el rol de cada
// cuenta — así se prueba la regla (quién tiene que aceptar y qué cuenta como
// aceptación) sin una base de datos.
function servicio(roles) {
  return cargar('../src/services/compromisoService.js', {
    '../config/prisma': {
      usuarios: { findUnique: async ({ where }) => (roles[where.id_usuario] ? { rol: { tipo_rol: roles[where.id_usuario] } } : null) },
    },
  });
}

const roles = { 1: 'comprador', 2: 'vendedor', 3: 'administrador' };

// Se comparan los campos, no el objeto: el servicio corre en un contexto de vm
// distinto y `deepStrictEqual` también compara prototipos entre contextos.
async function sinCompromiso(s, id, aceptaNoReventa, mensaje) {
  const compromiso = await s.exigirCompromiso(id, aceptaNoReventa);
  assert.equal(compromiso.requerido, false, mensaje);
  assert.equal(compromiso.aceptadoEn, null, mensaje);
}

test('un comprador no tiene que aceptar nada, mande lo que mande', async () => {
  const s = servicio(roles);
  await sinCompromiso(s, 1, undefined);
  await sinCompromiso(s, 1, true, 'tampoco se le guarda una aceptación que no hacía falta');
});

test('las cuentas que pueden vender (vendedor y administrador) deben aceptar, y la constancia es el instante', async () => {
  const s = servicio(roles);
  for (const id of [2, 3]) {
    const antes = Date.now();
    const compromiso = await s.exigirCompromiso(id, true);
    assert.equal(compromiso.requerido, true);
    assert.ok(compromiso.aceptadoEn instanceof Date && compromiso.aceptadoEn.getTime() >= antes);
  }
});

test('sin aceptación explícita se rechaza con 400 y un código que el frontend reconoce', async () => {
  const s = servicio(roles);
  for (const valor of [undefined, false, null, 'true', 1, {}]) {
    await assert.rejects(
      s.exigirCompromiso(2, valor),
      (err) => err.status === 400 && err.codigo === 'COMPROMISO_NO_REVENTA' && /compromiso de no reventa/.test(err.message),
      `aceptaNoReventa = ${JSON.stringify(valor)} no debe contar como aceptación`
    );
  }
});

test('una cuenta desconocida no se rechaza acá: el checkout falla por su cuenta', async () => {
  await sinCompromiso(servicio(roles), 99, undefined);
});

test('los roles que venden son los mismos que pueden publicar productos', () => {
  const { ROLES_QUE_VENDEN } = servicio(roles);
  assert.deepEqual([...ROLES_QUE_VENDEN].sort(), ['administrador', 'vendedor']);
});
