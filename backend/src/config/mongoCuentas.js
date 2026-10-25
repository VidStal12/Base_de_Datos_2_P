// Cuentas y roles de MongoDB — la LISTA BLANCA de IA/PLAN-ENTREGA-FINAL.md §4.0 y §4.2.
//
// En Mongo los roles solo PERMITEN (no existe «negar»): la lista blanca es lo que cada rol suma, y lo que no
// figura no se puede. El servidor web entra con `mg_app`, cuyo rol `app_tiendaya`:
//   - lee, inserta y actualiza las colecciones del catálogo y las reseñas, sin poder borrar nada;
//   - sobre `producto_eventos` (el historial de cambios, ADR-003) y `auditoria_acceso` (quién cambió qué permiso y
//     qué accesos se denegaron, ADR-007 §9) solo puede LEER e INSERTAR: son append-only por garantía de la base
//     de datos, no por convención del código — un registro no se puede modificar ni borrar ni siquiera con un bug
//     o una inyección en la aplicación;
//   - no administra nada: ni usuarios, ni roles, ni índices fuera de sus colecciones, ni borrar bases.
// `mg_admin` (root) es solo para mantenimiento y para crear estos usuarios; el servidor web nunca la usa.
//
// `createIndex`, `createCollection` y `listIndexes` se piden porque Mongoose los usa al cargar cada modelo
// (Model.init); son acciones de esquema sobre las colecciones de la aplicación, no de datos.
//
// Esta es la única fuente de la verdad: config/mongo.js la usa para conectar, scripts/seguridad/mongoUsuarios.js
// la vuelca en el servidor y `npm run verificar:acceso` comprueba que el servidor coincida con ella.

const BASE_DE_DATOS = 'tiendaya';
const COLECCIONES_CON_ESCRITURA = ['productos', 'categorias', 'subcategorias', 'resenas'];
const COLECCIONES_SOLO_ALTA = ['producto_eventos', 'auditoria_acceso'];
const ACCIONES_DE_ESQUEMA = ['createIndex', 'createCollection', 'listIndexes'];

const ROLES = {
  app_tiendaya: {
    db: BASE_DE_DATOS,
    uso: 'La API: catálogo y reseñas con lectura/alta/edición (sin borrar); el historial de cambios y la auditoría de accesos, solo con lectura y alta.',
    privilegios: [
      ...COLECCIONES_CON_ESCRITURA.map((coleccion) => ({ coleccion, acciones: ['find', 'insert', 'update', ...ACCIONES_DE_ESQUEMA] })),
      ...COLECCIONES_SOLO_ALTA.map((coleccion) => ({ coleccion, acciones: ['find', 'insert', ...ACCIONES_DE_ESQUEMA] })),
    ],
  },
};

const USUARIOS = {
  app: {
    usuario: 'mg_app',
    db: BASE_DE_DATOS,
    uso: 'El servidor web (src/config/mongo.js).',
    roles: [{ role: 'app_tiendaya', db: BASE_DE_DATOS }],
  },
  admin: {
    usuario: 'mg_admin',
    db: 'admin',
    uso: 'Mantenimiento y creación de usuarios. El servidor web nunca la usa.',
    roles: [{ role: 'root', db: 'admin' }],
  },
};

// Lo que se prueba contra el servidor: `denegado` son órdenes que `mg_app` NO puede hacer. Se ejecutan de verdad
// (si Mongo las dejara pasar no tocarían ningún dato: filtros que no coinciden con nada, otra base) y tienen que
// responder «not authorized». `permitido` se comprueba leyendo los privilegios del usuario en el servidor.
const NO_EXISTE = '000000000000000000000000';
const PRUEBAS_APP = {
  denegado: [
    { texto: 'modificar un evento del historial', db: BASE_DE_DATOS, comando: { update: 'producto_eventos', updates: [{ q: { _id: { $oid: NO_EXISTE } }, u: { $set: { tipo: 'x' } } }] } },
    { texto: 'borrar un evento del historial', db: BASE_DE_DATOS, comando: { delete: 'producto_eventos', deletes: [{ q: { _id: { $oid: NO_EXISTE } }, limit: 1 }] } },
    { texto: 'borrar la colección del historial', db: BASE_DE_DATOS, comando: { drop: 'producto_eventos' } },
    { texto: 'modificar un registro de la auditoría de accesos', db: BASE_DE_DATOS, comando: { update: 'auditoria_acceso', updates: [{ q: { _id: { $oid: NO_EXISTE } }, u: { $set: { tipo: 'x' } } }] } },
    { texto: 'borrar un registro de la auditoría de accesos', db: BASE_DE_DATOS, comando: { delete: 'auditoria_acceso', deletes: [{ q: { _id: { $oid: NO_EXISTE } }, limit: 1 }] } },
    { texto: 'borrar la colección de la auditoría de accesos', db: BASE_DE_DATOS, comando: { drop: 'auditoria_acceso' } },
    { texto: 'borrar un producto', db: BASE_DE_DATOS, comando: { delete: 'productos', deletes: [{ q: { _id: { $oid: NO_EXISTE } }, limit: 1 }] } },
    { texto: 'borrar una base de datos', db: 'tiendaya_acceso_prueba', comando: { dropDatabase: 1 } },
    { texto: 'crear un usuario', db: BASE_DE_DATOS, comando: { createUser: 'intruso', pwd: 'x-no-se-crea-123456', roles: [] } },
    { texto: 'leer otra colección', db: BASE_DE_DATOS, comando: { find: 'coleccion_ajena', filter: {}, limit: 1 } },
    { texto: 'leer otra base', db: 'admin', comando: { find: 'system.users', filter: {}, limit: 1 } },
  ],
};

const variableContrasena = (cuenta) => `MONGO_CONTRASENA_${cuenta.toUpperCase()}`;

function definicion(cuenta) {
  const d = USUARIOS[cuenta];
  if (!d) throw new Error(`Cuenta de Mongo desconocida: «${cuenta}». Las cuentas son: ${Object.keys(USUARIOS).join(', ')}.`);
  return d;
}

// Los privilegios de un rol en el formato de `createRole` de Mongo.
function privilegiosDe(rol) {
  const d = ROLES[rol];
  if (!d) throw new Error(`Rol de Mongo desconocido: «${rol}»`);
  return d.privilegios.map(({ coleccion, acciones }) => ({ resource: { db: d.db, collection: coleccion }, actions: [...acciones] }));
}

// { 'db.coleccion': [acciones ordenadas] } — para comparar lo declarado con lo que el servidor devuelve.
function normalizarPrivilegios(privilegios) {
  const mapa = {};
  for (const { resource, actions } of privilegios) {
    const clave = resource.cluster ? 'cluster' : `${resource.db}.${resource.collection || '*'}`;
    mapa[clave] = [...new Set([...(mapa[clave] ?? []), ...actions])].sort();
  }
  return mapa;
}

module.exports = { BASE_DE_DATOS, ROLES, USUARIOS, PRUEBAS_APP, variableContrasena, definicion, privilegiosDe, normalizarPrivilegios };
