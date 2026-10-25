const prisma = require('../config/prisma');
const politica = require('./politicaAccesoService');
const auditoria = require('./auditoriaAccesoService');

// La parte de «cuentas y roles» de la pantalla /admin/permisos (IA/ADR-007 §9): ver las cuentas, cambiarles el rol y
// crear o borrar roles propios. Solo la usa un administrador (las rutas son fijas, ver config/politicaRutas.js).
//
// Un rol nuevo NO trae permisos: es un comprador (puede todo lo que pide solo sesión) al que el administrador le
// concede, una por una, las rutas editables. Los tres roles del sistema no se borran.

const ADMINISTRADOR = 'administrador';
const NOMBRE_DE_ROL = /^[a-z][a-z0-9_-]{2,29}$/;
const TAMANO_MAXIMO = 100;

const error = (status, mensaje) => Object.assign(new Error(mensaje), { status });
const actorDe = (u) => ({ id: u.id_usuario, rol: u.rol });
const entero = (valor, mensaje) => {
  const n = Number(valor);
  if (!Number.isInteger(n) || n <= 0) throw error(400, mensaje);
  return n;
};

async function listarUsuarios({ q, pagina, tamano } = {}) {
  const limite = Math.min(TAMANO_MAXIMO, Math.max(1, Math.trunc(Number(tamano)) || 20));
  const numero = Math.max(1, Math.trunc(Number(pagina)) || 1);
  const texto = typeof q === 'string' ? q.trim().slice(0, 100) : '';
  const donde = texto
    ? { OR: [{ correo: { contains: texto } }, { nombres: { contains: texto } }, { apellidos: { contains: texto } }, ...(/^\d+$/.test(texto) ? [{ id_usuario: Number(texto) }] : [])] }
    : {};
  const [total, filas] = await Promise.all([
    prisma.usuarios.count({ where: donde }),
    prisma.usuarios.findMany({
      where: donde,
      orderBy: { id_usuario: 'asc' },
      skip: (numero - 1) * limite,
      take: limite,
      select: { id_usuario: true, nombres: true, apellidos: true, correo: true, creado_en: true, rol: { select: { id: true, tipo_rol: true } } },
    }),
  ]);
  return {
    total,
    pagina: numero,
    tamano: limite,
    paginas: Math.max(1, Math.ceil(total / limite)),
    usuarios: filas.map((f) => ({
      id: f.id_usuario, nombre: `${f.nombres} ${f.apellidos}`.trim(), correo: f.correo, creadoEn: f.creado_en, rol: f.rol.tipo_rol, rolId: f.rol.id,
    })),
  };
}

// Cambiar el rol de una cuenta. Nadie cambia el suyo (un administrador que se quita el rol a sí mismo se quedaría sin
// acceso, o se lo quitaría a todos si fuera el único), y siempre queda al menos un administrador.
async function cambiarRol(actor, usuarioId, rolNombre) {
  const id = entero(usuarioId, 'El id de cuenta no es válido.');
  if (typeof rolNombre !== 'string' || !rolNombre) throw error(400, 'Indicá el rol nuevo.');
  if (id === actor.id_usuario) throw error(400, 'No podés cambiar tu propio rol: pedíselo a otro administrador.');
  const [cuenta, rol] = await Promise.all([
    prisma.usuarios.findUnique({ where: { id_usuario: id }, select: { id_usuario: true, nombres: true, apellidos: true, rol: { select: { id: true, tipo_rol: true } } } }),
    prisma.rol_usuario.findFirst({ where: { tipo_rol: rolNombre } }),
  ]);
  if (!cuenta) throw error(404, 'Esa cuenta no existe.');
  if (!rol) throw error(404, `El rol «${rolNombre}» no existe.`);
  const antes = cuenta.rol.tipo_rol;
  if (antes === rol.tipo_rol) return { sinCambios: true, rol: antes, auditado: true };
  if (antes === ADMINISTRADOR) {
    const otros = await prisma.usuarios.count({ where: { rol: { tipo_rol: ADMINISTRADOR }, id_usuario: { not: id } } });
    if (otros < 1) throw error(409, 'Tiene que quedar al menos un administrador.');
  }
  await prisma.usuarios.update({ where: { id_usuario: id }, data: { rol_id: rol.id } });
  politica.olvidarRol(id);
  const auditado = await auditoria.registrar({
    tipo: 'rol_cuenta',
    actor: actorDe(actor),
    objetivo: { tipo: 'usuario', id: String(id) },
    antes: { rol: antes },
    despues: { rol: rol.tipo_rol },
  });
  return { sinCambios: false, rol: rol.tipo_rol, anterior: antes, auditado };
}

async function crearRol(actor, nombre) {
  const limpio = typeof nombre === 'string' ? nombre.trim().toLowerCase() : '';
  if (!NOMBRE_DE_ROL.test(limpio)) {
    throw error(400, 'El nombre del rol va en minúsculas, de 3 a 30 caracteres: letras, números, guion o guion bajo, y empieza con una letra.');
  }
  if (await prisma.rol_usuario.findFirst({ where: { tipo_rol: limpio } })) throw error(409, `Ya existe el rol «${limpio}».`);
  const rol = await prisma.rol_usuario.create({ data: { tipo_rol: limpio } });
  politica.invalidar();
  const auditado = await auditoria.registrar({ tipo: 'rol_creado', actor: actorDe(actor), objetivo: { tipo: 'rol', id: String(rol.id), nombre: rol.tipo_rol } });
  return { id: rol.id, nombre: rol.tipo_rol, sistema: false, usuarios: 0, auditado };
}

async function eliminarRol(actor, rolId) {
  const id = entero(rolId, 'El id de rol no es válido.');
  const rol = await prisma.rol_usuario.findUnique({ where: { id }, include: { _count: { select: { usuarios: true, reglas: true } } } });
  if (!rol) throw error(404, 'Ese rol no existe.');
  if (politica.esRolDelSistema(rol.tipo_rol)) throw error(400, `«${rol.tipo_rol}» es un rol del sistema: no se borra.`);
  if (rol._count.usuarios > 0) {
    throw error(409, `${rol._count.usuarios === 1 ? 'Una cuenta tiene' : `${rol._count.usuarios} cuentas tienen`} este rol: cambiales el rol primero.`);
  }
  await prisma.rol_usuario.delete({ where: { id } }); // sus reglas se borran con él (ON DELETE CASCADE)
  politica.invalidar();
  const auditado = await auditoria.registrar({
    tipo: 'rol_eliminado',
    actor: actorDe(actor),
    objetivo: { tipo: 'rol', id: String(id), nombre: rol.tipo_rol },
    detalle: `Se borraron ${rol._count.reglas} regla(s) de permisos del rol`,
  });
  return { eliminado: rol.tipo_rol, reglasBorradas: rol._count.reglas, auditado };
}

module.exports = { listarUsuarios, cambiarRol, crearRol, eliminarRol, NOMBRE_DE_ROL };
