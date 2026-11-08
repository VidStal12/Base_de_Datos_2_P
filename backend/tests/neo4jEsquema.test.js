const test = require('node:test');
const assert = require('node:assert/strict');
const { cargar } = require('./redisHelpers');

function config({ run = async () => ({ records: [] }) } = {}) {
  const consultas = [];
  let cierres = 0;
  const driver = {
    session: () => ({
      executeWrite: async (f) => f({ run: async (q) => { consultas.push(q); return run(q); } }),
      close: async () => { cierres++; },
    }),
    close: async () => {},
  };
  const api = cargar('../src/config/neo4j.js', {
    'neo4j-driver': { driver: () => driver, auth: { basic: () => ({}) } },
    '../utils/resiliencia': { crearCircuito: () => ({ ejecutar: (f) => f() }) },
  });
  return { ...api, consultas, cierres: () => cierres };
}

test('el esquema protege Usuario y se prepara una sola vez aun con llamadas concurrentes', async () => {
  const n = config();
  await Promise.all(Array.from({ length: 8 }, () => n.asegurarEsquema()));
  assert.equal(n.consultas.length, 3);
  assert.match(n.consultas[0], /Usuario.*id_usuario IS UNIQUE/);
  assert.equal(n.cierres(), 3);
  await n.cerrar();
  await n.asegurarEsquema();
  assert.equal(n.consultas.length, 6, 'al reconectar se vuelve a comprobar el esquema');
});

test('una falla al preparar el esquema se propaga, cierra la sesión y permite reintentar', async () => {
  let falla = true;
  const n = config({ run: async () => { if (falla) throw new Error('duplicados'); } });
  await assert.rejects(n.asegurarEsquema(), /duplicados/);
  assert.equal(n.cierres(), 1);
  falla = false;
  await n.asegurarEsquema();
  assert.equal(n.consultas.length, 4);
});

function sincronizador({ falla = false } = {}) {
  let listo = false;
  let escrituras = 0;
  const s = cargar('../src/services/fraudeSyncService.js', {
    '../config/neo4j': {
      asegurarEsquema: async () => { if (falla) throw new Error('esquema no disponible'); listo = true; },
      escribir: async () => { assert.equal(listo, true, 'no escribe antes de proteger los usuarios'); escrituras++; },
    },
    '../config/prisma': { usuarios: { findUnique: async () => ({ correo: 'a@example.com' }) } },
    '../config/mongo': { conectar: async () => {} },
    '../models/mongo/Subcategoria': { findById: () => ({ select: () => ({ lean: async () => ({ categoria_id: 'cat' }) }) }) },
  });
  return { s, escrituras: () => escrituras };
}

const datos = {
  usuarioId: 113, usuarioNombre: 'Cuenta de prueba', usuarioRol: 'comprador',
  vendedorId: 2, vendedorNombre: 'Vendedor', productoId: 14,
  productoNombre: 'Producto', productoDescripcion: '', subcategoriaId: 'subcat',
  detalleId: 342, compraId: 341, monto: 100, calificacion: 5,
  fecha: '2026-11-08T00:00:00Z', primeraVez: '2026-11-08T00:00:00Z',
  ultimaVez: '2026-11-08T00:00:00Z', inicios: 1, dispositivoHash: 'hash',
};
for (const metodo of ['registrarCompra', 'registrarResena', 'registrarProducto', 'registrarDispositivo']) {
  test(`${metodo} prepara el esquema antes de escribir y no escribe si falla`, async () => {
    const ok = sincronizador();
    await ok.s[metodo](datos);
    assert.equal(ok.escrituras(), 1);
    const error = sincronizador({ falla: true });
    await assert.rejects(error.s[metodo](datos), /esquema no disponible/);
    assert.equal(error.escrituras(), 0);
  });
}

const { unificar } = require('../scripts/unificarUsuariosNeo4j');

function migracion({ seguros }) {
  const consultas = [];
  let cierres = 0;
  const driver = { session: () => ({
    close: async () => { cierres++; },
    executeWrite: async (f) => f({ run: async (q) => {
      consultas.push(q);
      if (q.includes('RETURN id, nodos')) return { records: seguros.map((_, i) => ({ toObject: () => ({ id: i, nodos: [`a${i}`, `b${i}`] }) })) };
      if (q.includes('AS seguro')) return { records: [{ get: () => seguros.shift() }] };
      return { records: [] };
    } }),
  }) };
  return { driver, consultas, cierres: () => cierres };
}

test('la inspección de duplicados no borra ni bloquea nodos', async () => {
  const m = migracion({ seguros: [true] });
  const resultado = await unificar(m.driver);
  assert.equal(resultado.eliminados, 0);
  assert.equal(resultado.respaldo, null);
  assert.equal(m.consultas.some((q) => /DELETE|SET /.test(q)), false);
  assert.equal(m.cierres(), 1);
});

test('si un duplicado tiene datos diferentes, no elimina ninguno aunque otro sea redundante', async () => {
  const m = migracion({ seguros: [true, false] });
  await assert.rejects(unificar(m.driver, { aplicar: true }), /datos distintos/);
  assert.equal(m.consultas.some((q) => q.includes('DELETE')), false);
  assert.equal(m.cierres(), 1);
});
