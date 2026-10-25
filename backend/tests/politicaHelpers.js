// Dobles compartidos por las pruebas de la política de permisos (permisos*):
// un Prisma en memoria que sabe lo justo de las consultas que usan esos servicios, un reloj que se mueve a mano y
// un registro de auditoría que anota lo que se le manda. No abren ninguna conexión.

// ── Un Prisma en memoria ────────────────────────────────────────────────────────────────────────────────────────
function coincide(fila, donde = {}) {
  return Object.entries(donde).every(([campo, condicion]) => {
    if (campo === 'OR') return condicion.some((c) => coincide(fila, c));
    const valor = fila[campo];
    if (condicion !== null && typeof condicion === 'object' && !(condicion instanceof Date)) {
      if ('in' in condicion) return condicion.in.includes(valor);
      if ('not' in condicion) return valor !== condicion.not;
      if ('contains' in condicion) return String(valor ?? '').toLowerCase().includes(String(condicion.contains).toLowerCase());
      return coincide(valor ?? {}, condicion); // una relación: { rol: { tipo_rol: 'x' } }
    }
    return valor === condicion;
  });
}

// `falla` hace que toda consulta lance (MySQL apagado); `cuelga` hace que no responda nunca (MySQL colgado).
function prismaFalso({ roles = [], usuarios = [], reglas = [] } = {}) {
  const estado = {
    roles: roles.map((r) => ({ ...r })),
    usuarios: usuarios.map((u) => ({ ...u })),
    reglas: reglas.map((r, i) => ({ id: i + 1, actualizado_por: null, actualizado_en: new Date('2026-10-20T12:00:00Z'), ...r })),
    consultas: [],
    falla: null,
    cuelga: false,
    siguienteRol: Math.max(0, ...roles.map((r) => r.id)) + 1,
    siguienteRegla: reglas.length + 1,
  };
  const registrar = (nombre) => async (fn) => {
    estado.consultas.push(nombre);
    if (estado.cuelga) return new Promise(() => {});
    if (estado.falla) throw estado.falla;
    return fn();
  };
  const rolDe = (u) => ({ id: u.rol_id, tipo_rol: estado.roles.find((r) => r.id === u.rol_id)?.tipo_rol });
  const conRelaciones = (u) => ({ ...u, rol: rolDe(u) });
  const elegir = (fila, select) => (select ? Object.fromEntries(Object.entries(select).filter(([, v]) => v).map(([k]) => [k, fila[k]])) : fila);

  const prisma = {
    estado,
    acl_regla: {
      findMany: ({ where, select } = {}) => registrar('acl_regla.findMany')(() => estado.reglas.filter((r) => coincide(r, where)).map((r) => elegir(r, select))),
      deleteMany: ({ where }) => registrar('acl_regla.deleteMany')(() => {
        const antes = estado.reglas.length;
        estado.reglas = estado.reglas.filter((r) => !coincide(r, where));
        return { count: antes - estado.reglas.length };
      }),
      upsert: ({ where, update, create }) => registrar('acl_regla.upsert')(() => {
        const { rol_id, ruta } = where.rol_id_ruta;
        const existente = estado.reglas.find((r) => r.rol_id === rol_id && r.ruta === ruta);
        if (existente) return Object.assign(existente, update);
        const nueva = { id: estado.siguienteRegla++, ...create };
        estado.reglas.push(nueva);
        return nueva;
      }),
    },
    rol_usuario: {
      findMany: ({ select } = {}) => registrar('rol_usuario.findMany')(() => estado.roles.map((r) => elegir(r, select))),
      findFirst: ({ where }) => registrar('rol_usuario.findFirst')(() => estado.roles.find((r) => coincide(r, where)) ?? null),
      findUnique: ({ where, include }) => registrar('rol_usuario.findUnique')(() => {
        const rol = estado.roles.find((r) => r.id === where.id);
        if (!rol) return null;
        if (!include?._count) return rol;
        return { ...rol, _count: { usuarios: estado.usuarios.filter((u) => u.rol_id === rol.id).length, reglas: estado.reglas.filter((r) => r.rol_id === rol.id).length } };
      }),
      create: ({ data }) => registrar('rol_usuario.create')(() => {
        const rol = { id: estado.siguienteRol++, ...data };
        estado.roles.push(rol);
        return rol;
      }),
      delete: ({ where }) => registrar('rol_usuario.delete')(() => {
        estado.roles = estado.roles.filter((r) => r.id !== where.id);
        estado.reglas = estado.reglas.filter((r) => r.rol_id !== where.id); // ON DELETE CASCADE
        return {};
      }),
    },
    usuarios: {
      findUnique: ({ where, select }) => registrar('usuarios.findUnique')(() => {
        const u = estado.usuarios.find((x) => x.id_usuario === where.id_usuario);
        return u ? (select ? { ...elegir(u, select), ...(select.rol && { rol: rolDe(u) }) } : conRelaciones(u)) : null;
      }),
      findMany: ({ where, select, orderBy, skip = 0, take } = {}) => registrar('usuarios.findMany')(() => {
        let filas = estado.usuarios.filter((u) => coincide(conRelaciones(u), where));
        if (orderBy) filas = [...filas].sort((a, b) => a.id_usuario - b.id_usuario);
        filas = filas.slice(skip, take === undefined ? undefined : skip + take);
        return filas.map((u) => ({ ...elegir(u, select), ...(select?.rol && { rol: rolDe(u) }) }));
      }),
      count: ({ where } = {}) => registrar('usuarios.count')(() => estado.usuarios.filter((u) => coincide(conRelaciones(u), where)).length),
      update: ({ where, data }) => registrar('usuarios.update')(() => Object.assign(estado.usuarios.find((u) => u.id_usuario === where.id_usuario), data)),
      groupBy: () => registrar('usuarios.groupBy')(() => {
        const cuentas = new Map();
        for (const u of estado.usuarios) cuentas.set(u.rol_id, (cuentas.get(u.rol_id) ?? 0) + 1);
        return [...cuentas].map(([rol_id, n]) => ({ rol_id, _count: { _all: n } }));
      }),
    },
    // Con deshacer: si el lote falla a medias, no queda nada escrito (como la transacción de verdad).
    $transaction: async (fn) => {
      const copia = JSON.parse(JSON.stringify({ r: estado.reglas, ro: estado.roles, u: estado.usuarios }));
      try {
        return await fn(prisma);
      } catch (err) {
        estado.reglas = copia.r.map((x) => ({ ...x, actualizado_en: new Date(x.actualizado_en) }));
        estado.roles = copia.ro;
        estado.usuarios = copia.u;
        throw err;
      }
    },
  };
  return prisma;
}

// ── Un reloj que se mueve a mano ────────────────────────────────────────────────────────────────────────────────
function relojFalso(inicio = Date.parse('2026-10-25T12:00:00Z')) {
  const reloj = { t: inicio, avanzar(ms) { reloj.t += ms; } };
  class FechaFalsa extends Date {
    constructor(...args) { super(...(args.length ? args : [reloj.t])); }
    static now() { return reloj.t; }
  }
  return { reloj, Date: FechaFalsa };
}

// ── La auditoría ────────────────────────────────────────────────────────────────────────────────────────────────
function auditoriaRegistro({ falla = false } = {}) {
  const eventos = [];
  const estado = { falla };
  return {
    eventos,
    estado,
    registrar: async (evento) => { if (estado.falla) return false; eventos.push(evento); return true; },
    registrarVarios: async (lista) => { if (estado.falla) return false; eventos.push(...lista); return true; },
    registrarDenegacion: () => false,
  };
}

// Los tres roles del sistema, un rol propio, y las cuentas de ejemplo de las pruebas.
const ROLES_BASE = [
  { id: 1, tipo_rol: 'comprador' },
  { id: 2, tipo_rol: 'vendedor' },
  { id: 3, tipo_rol: 'administrador' },
  { id: 4, tipo_rol: 'auditor' },
];
const USUARIOS_BASE = [
  { id_usuario: 1, rol_id: 1, nombres: 'Ana', apellidos: 'Gómez', correo: 'ana@example.com', creado_en: new Date('2026-09-01T00:00:00Z') },
  { id_usuario: 2, rol_id: 2, nombres: 'Luis', apellidos: 'Ramírez', correo: 'luis@example.com', creado_en: new Date('2026-09-02T00:00:00Z') },
  { id_usuario: 9, rol_id: 3, nombres: 'Admin', apellidos: 'Uno', correo: 'admin@example.com', creado_en: new Date('2026-09-03T00:00:00Z') },
  { id_usuario: 10, rol_id: 3, nombres: 'Admin', apellidos: 'Dos', correo: 'admin2@example.com', creado_en: new Date('2026-09-04T00:00:00Z') },
  { id_usuario: 11, rol_id: 4, nombres: 'Rosa', apellidos: 'Auditora', correo: 'rosa@example.com', creado_en: new Date('2026-09-05T00:00:00Z') },
];

module.exports = { prismaFalso, relojFalso, auditoriaRegistro, ROLES_BASE, USUARIOS_BASE };
