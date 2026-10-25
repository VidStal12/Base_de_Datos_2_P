const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// frontend/src/utils/permisos.js son funciones puras: se cargan igual que filtrosBusqueda.js (sin los `export`) y se
// prueban sin navegador. Lo que se prueba es lo que la pantalla de permisos arma —orden, grupos, cambios sin guardar
// y su resumen—; la decisión de quién puede qué es del servidor (permisosPolitica.test.js).
function cargar() {
  const fuente = fs.readFileSync(path.join(__dirname, '../../frontend/src/utils/permisos.js'), 'utf8').replace(/export /g, '');
  const contexto = { module: { exports: {} } };
  vm.runInNewContext(
    `${fuente}\nmodule.exports = { ROLES_DEL_SISTEMA, RUTAS_DEL_PANEL, ordenarRoles, agruparRutas, filtrarRutas, claveDeCelda, conCelda, valorMostrado, cambiosPendientes, describirCambio, celdasModificadas, permisosDeRol, puedeUsar, puedeAlguna, TIPOS_DE_AUDITORIA, describirRegistro, etiquetaDeTipo };`,
    contexto
  );
  return contexto.module.exports;
}
const p = cargar();
const plano = (v) => JSON.parse(JSON.stringify(v));

const celda = (permitido, extra = {}) => ({ permitido, origen: 'codigo', porDefecto: permitido, bloqueada: false, ...extra });
const RUTAS = [
  { clave: 'GET /api/admin/ventas', grupo: 'Ventas', nota: 'Panel de ventas por intervalos (Cassandra)', editable: true, celdas: { comprador: celda(false), vendedor: celda(false), administrador: celda(true, { bloqueada: true, origen: 'administrador' }), auditor: celda(true, { origen: 'regla', porDefecto: false }) } },
  { clave: 'POST /api/categorias', grupo: 'Catálogo', nota: 'Crea una categoría', editable: true, celdas: { comprador: celda(false), vendedor: celda(true), administrador: celda(true, { bloqueada: true, origen: 'administrador' }), auditor: celda(false) } },
  { clave: 'GET /api/productos/:id/historial', grupo: 'Productos del vendedor', nota: 'Historial de precios y stock', editable: false, celdas: { comprador: celda(false, { bloqueada: true }), vendedor: celda(true, { bloqueada: true }), administrador: celda(true, { bloqueada: true, origen: 'administrador' }), auditor: celda(false, { bloqueada: true }) } },
  { clave: 'GET /api/admin/fraude', grupo: 'Fraude', nota: 'Señales de posible fraude (Neo4j)', editable: true, celdas: { comprador: celda(false), vendedor: celda(false), administrador: celda(true, { bloqueada: true, origen: 'administrador' }), auditor: celda(false) } },
  { clave: 'POST /api/categorias/:id/subcategorias', grupo: 'Catálogo', nota: 'Crea una subcategoría', editable: true, celdas: { comprador: celda(false), vendedor: celda(true), administrador: celda(true, { bloqueada: true, origen: 'administrador' }), auditor: celda(false) } },
];

// ── Orden y grupos ──────────────────────────────────────────────────────────────────────────────────────────────

test('los roles del sistema van primero y en su orden; los creados por un administrador, después y por nombre', () => {
  const roles = [{ nombre: 'soporte' }, { nombre: 'administrador' }, { nombre: 'auditor' }, { nombre: 'comprador' }, { nombre: 'vendedor' }, { nombre: 'ñoño' }];
  assert.deepEqual(plano(p.ordenarRoles(roles)).map((r) => r.nombre), ['comprador', 'vendedor', 'administrador', 'auditor', 'ñoño', 'soporte']);
  assert.deepEqual(roles.map((r) => r.nombre)[0], 'soporte', 'no modifica la lista original');
});

test('las rutas se agrupan por módulo en el orden en que aparece cada uno, sin partir un grupo', () => {
  const grupos = plano(p.agruparRutas(RUTAS));
  assert.deepEqual(grupos.map((g) => [g.grupo, g.rutas.length]), [['Ventas', 1], ['Catálogo', 2], ['Productos del vendedor', 1], ['Fraude', 1]]);
});

test('el buscador mira la nota, la clave y el grupo, sin importar acentos ni mayúsculas', () => {
  assert.equal(p.filtrarRutas(RUTAS, '').length, 5);
  assert.deepEqual(p.filtrarRutas(RUTAS, 'CATEGORÍA').map((r) => r.clave), ['POST /api/categorias', 'POST /api/categorias/:id/subcategorias']);
  assert.deepEqual(p.filtrarRutas(RUTAS, 'api/admin/fraude').map((r) => r.grupo), ['Fraude']);
  assert.deepEqual(p.filtrarRutas(RUTAS, 'catalogo').length, 2, 'por el grupo, aunque se escriba sin acento');
  assert.equal(p.filtrarRutas(RUTAS, 'zzz').length, 0);
});

test('«solo lo que se puede cambiar» deja afuera las filas fijas', () => {
  assert.equal(p.filtrarRutas(RUTAS, '', { soloEditables: true }).length, 4);
  assert.ok(p.filtrarRutas(RUTAS, '', { soloEditables: true }).every((r) => r.editable));
});

// ── El borrador ─────────────────────────────────────────────────────────────────────────────────────────────────

test('marcar una celda la anota en el borrador; volver a como estaba la quita (no cuenta como cambio)', () => {
  let b = new Map();
  b = p.conCelda(b, RUTAS, 'GET /api/admin/ventas', 'comprador', true);
  assert.equal(b.size, 1);
  assert.equal(p.valorMostrado(RUTAS[0].celdas.comprador, b, 'GET /api/admin/ventas', 'comprador'), true);
  assert.equal(p.valorMostrado(RUTAS[0].celdas.vendedor, b, 'GET /api/admin/ventas', 'vendedor'), false, 'las demás celdas muestran lo guardado');
  b = p.conCelda(b, RUTAS, 'GET /api/admin/ventas', 'comprador', false);
  assert.equal(b.size, 0);
});

test('una celda bloqueada (el administrador, o una ruta fija) no entra al borrador aunque se intente', () => {
  let b = new Map();
  b = p.conCelda(b, RUTAS, 'GET /api/admin/ventas', 'administrador', false);
  b = p.conCelda(b, RUTAS, 'GET /api/productos/:id/historial', 'comprador', true);
  b = p.conCelda(b, RUTAS, 'GET /api/no-existe', 'comprador', true);
  b = p.conCelda(b, RUTAS, 'GET /api/admin/ventas', 'rol-que-no-esta', true);
  assert.equal(b.size, 0);
});

test('conCelda no modifica el borrador que recibe (React lo compara por referencia)', () => {
  const original = new Map();
  const nuevo = p.conCelda(original, RUTAS, 'GET /api/admin/fraude', 'auditor', true);
  assert.equal(original.size, 0);
  assert.notEqual(nuevo, original);
});

test('lo que se le manda al servidor son solo las diferencias, con lo que había antes y lo que declara el código', () => {
  let b = new Map();
  b = p.conCelda(b, RUTAS, 'GET /api/admin/fraude', 'auditor', true); // conceder (el código no lo da)
  b = p.conCelda(b, RUTAS, 'POST /api/categorias', 'vendedor', false); // quitar lo que el código da
  b = p.conCelda(b, RUTAS, 'GET /api/admin/ventas', 'auditor', false); // quitar una regla que un administrador había puesto
  const cambios = plano(p.cambiosPendientes(RUTAS, b));
  assert.deepEqual(cambios.map((c) => [c.clave, c.rol, c.permitido, c.antes, c.porDefecto]), [
    ['GET /api/admin/ventas', 'auditor', false, true, false],
    ['POST /api/categorias', 'vendedor', false, true, true],
    ['GET /api/admin/fraude', 'auditor', true, false, false],
  ]);
  assert.ok(cambios.every((c) => c.nota && c.grupo));
});

test('un borrador desactualizado (la matriz cambió debajo) no genera cambios que ya están hechos', () => {
  const b = new Map([[p.claveDeCelda('GET /api/admin/ventas', 'auditor'), true]]); // el servidor ya lo tiene en true
  assert.deepEqual(plano(p.cambiosPendientes(RUTAS, b)), []);
});

test('el resumen de un cambio dice qué se concede o se quita, y avisa si quita algo que hoy se puede', () => {
  const concede = p.describirCambio({ clave: 'GET /api/admin/fraude', rol: 'auditor', permitido: true, antes: false, nota: 'Señales de posible fraude (Neo4j)', porDefecto: false });
  assert.deepEqual(plano(concede), { texto: 'Conceder «Señales de posible fraude (Neo4j)» al rol «auditor»', quita: false, contraElCodigo: true });
  const quita = p.describirCambio({ clave: 'POST /api/categorias', rol: 'vendedor', permitido: false, antes: true, nota: 'Crea una categoría', porDefecto: true });
  assert.deepEqual(plano(quita), { texto: 'Quitar «Crea una categoría» al rol «vendedor»', quita: true, contraElCodigo: true });
  const vuelve = p.describirCambio({ clave: 'GET /api/admin/ventas', rol: 'auditor', permitido: false, antes: true, nota: 'Panel de ventas', porDefecto: false });
  assert.equal(vuelve.contraElCodigo, false, 'quitar una regla de un administrador vuelve a lo que declara el código');
});

test('las celdas modificadas son las que un administrador cambió respecto del código (lo que «restaurar» deshace)', () => {
  assert.deepEqual(plano(p.celdasModificadas(RUTAS)), [{ clave: 'GET /api/admin/ventas', rol: 'auditor', nota: 'Panel de ventas por intervalos (Cassandra)', permitido: true }]);
});

test('«qué puede este rol» lista, por módulo, lo que hoy tiene permitido', () => {
  const vendedor = plano(p.permisosDeRol(RUTAS, 'vendedor'));
  assert.deepEqual(vendedor.map((g) => [g.grupo, g.rutas.map((r) => r.clave)]), [['Catálogo', ['POST /api/categorias', 'POST /api/categorias/:id/subcategorias']], ['Productos del vendedor', ['GET /api/productos/:id/historial']]]);
  assert.deepEqual(plano(p.permisosDeRol(RUTAS, 'comprador')), []);
  assert.deepEqual(plano(p.permisosDeRol(RUTAS, 'rol-que-no-esta')), []);
});

// ── Qué ve quien inició sesión ──────────────────────────────────────────────────────────────────────────────────

test('la interfaz decide qué ofrecer con los permisos que trae /auth/me; sin ellos, no ofrece nada', () => {
  const permisos = ['GET /api/admin/fraude'];
  assert.equal(p.puedeUsar(permisos, 'GET /api/admin/fraude'), true);
  assert.equal(p.puedeUsar(permisos, 'GET /api/admin/ventas'), false);
  assert.equal(p.puedeUsar(undefined, 'GET /api/admin/ventas'), false);
  assert.equal(p.puedeUsar(null, 'GET /api/admin/ventas'), false);
  assert.equal(p.puedeAlguna(permisos, Object.values(p.RUTAS_DEL_PANEL)), true);
  assert.equal(p.puedeAlguna([], Object.values(p.RUTAS_DEL_PANEL)), false);
});

test('las secciones del panel apuntan a rutas que existen en el servidor', () => {
  const { RUTAS } = require('../src/config/politicaRutas');
  const claves = new Set(RUTAS.map((r) => `${r.metodo} ${r.ruta}`));
  for (const clave of Object.values(p.RUTAS_DEL_PANEL)) assert.ok(claves.has(clave), `${clave} no está en la lista blanca de la API`);
});

// ── Auditoría ───────────────────────────────────────────────────────────────────────────────────────────────────

test('cada fila del registro se lee como una frase', () => {
  const frase = (r) => p.describirRegistro(plano(r));
  assert.equal(frase({ tipo: 'regla', objetivo: { tipo: 'ruta', id: 'GET /api/admin/ventas', nombre: 'Panel de ventas' }, antes: { rol: 'auditor', permitido: false }, despues: { rol: 'auditor', permitido: true } }), 'Concedió «Panel de ventas» al rol «auditor»');
  assert.equal(frase({ tipo: 'regla', objetivo: { id: 'POST /api/categorias', nombre: 'Crea una categoría' }, antes: { rol: 'vendedor', permitido: true }, despues: { rol: 'vendedor', permitido: false } }), 'Quitó «Crea una categoría» al rol «vendedor»');
  assert.equal(frase({ tipo: 'rol_cuenta', objetivo: { tipo: 'usuario', id: '11', nombre: 'Rosa Auditora' }, antes: { rol: 'comprador' }, despues: { rol: 'auditor' } }), 'Cambió el rol de Rosa Auditora de «comprador» a «auditor»');
  assert.equal(frase({ tipo: 'rol_cuenta', objetivo: { tipo: 'usuario', id: '404' }, antes: { rol: 'a' }, despues: { rol: 'b' } }), 'Cambió el rol de la cuenta #404 de «a» a «b»', 'una cuenta que ya no existe se nombra por su número');
  assert.equal(frase({ tipo: 'rol_creado', objetivo: { nombre: 'soporte' } }), 'Creó el rol «soporte»');
  assert.equal(frase({ tipo: 'rol_eliminado', objetivo: { nombre: 'soporte' }, detalle: 'Se borraron 2 regla(s) de permisos del rol' }), 'Borró el rol «soporte» (se borraron 2 regla(s) de permisos del rol)');
  assert.equal(frase({ tipo: 'denegacion', objetivo: { id: 'GET /api/admin/fraude' } }), 'Intentó «GET /api/admin/fraude» y se le negó');
  assert.equal(frase({ tipo: 'restaurar', detalle: 'Se volvió a lo que declara el código en la ruta X', antes: [{}, {}] }), 'Se volvió a lo que declara el código en la ruta X (2 reglas)');
  assert.equal(frase({ tipo: 'restaurar', antes: [{}] }), 'Volvió a lo que declara el código (1 regla)');
  assert.equal(frase({ tipo: 'algo-nuevo' }), 'algo-nuevo', 'un tipo que la pantalla no conoce no la rompe');
});

test('los tipos del filtro son los que el servidor acepta', () => {
  const AuditoriaAcceso = require('../src/models/mongo/AuditoriaAcceso');
  const validos = new Set(['', 'cambios', ...AuditoriaAcceso.TIPOS]);
  for (const t of p.TIPOS_DE_AUDITORIA) assert.ok(validos.has(t.valor), `el filtro «${t.valor}» no lo entiende el servidor`);
  for (const tipo of AuditoriaAcceso.TIPOS) assert.ok(p.TIPOS_DE_AUDITORIA.some((t) => t.valor === tipo), `el tipo «${tipo}» no se puede filtrar desde la pantalla`);
  assert.equal(p.etiquetaDeTipo('denegacion'), 'Accesos denegados');
  assert.equal(p.etiquetaDeTipo('otro'), 'otro');
});
