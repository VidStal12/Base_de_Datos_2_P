const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../config/prisma');
const { esCorreoValido, validarPassword } = require('../utils/validation');
const { exigirCuentaActiva } = require('./suspensionService');
const dispositivos = require('./dispositivoService');

const JWT_SECRET = process.env.JWT_SECRET;

// El rol nunca se toma del body: si el cliente pudiera pasar rol_id libremente,
// cualquiera podría autoregistrarse como "administrador". El auto-registro
// siempre asigna "comprador"; otros roles se asignan por otra vía (fuera de
// alcance de la Fase Inicial).
//
// `dispositivo` (lo que devuelve dispositivoService.desdeCabeceras, o nada): desde dónde se registra la cuenta.
// Queda anotado como su primer dispositivo (antifraude por dispositivo, PLAN-NEO4J §22).
async function registrar({ nombres, apellidos, correo, contrasena, fecha_nacimiento }, { dispositivo } = {}) {
  if (!nombres || !apellidos) {
    throw new Error('Nombres y apellidos son obligatorios');
  }
  if (!esCorreoValido(correo)) {
    throw new Error('El correo no tiene un formato válido');
  }
  validarPassword(contrasena);
  const fechaNac = new Date(fecha_nacimiento);
  if (Number.isNaN(fechaNac.getTime())) {
    throw new Error('Fecha de nacimiento inválida');
  }

  const rolComprador = await prisma.rol_usuario.findFirst({ where: { tipo_rol: 'comprador' } });
  if (!rolComprador) throw new Error('El rol "comprador" no está configurado. Corré el seed primero.');

  const hash = await bcrypt.hash(contrasena, 10);

  let usuario;
  try {
    usuario = await prisma.usuarios.create({
      data: {
        nombres,
        apellidos,
        correo,
        contrasena: hash,
        fecha_nacimiento: fechaNac,
        rol_id: rolComprador.id,
      },
    });
  } catch (err) {
    // P2002 = violación de restricción unique (correo ya registrado).
    // Sin esto, el cliente vería el error crudo de Prisma en vez de un mensaje claro.
    if (err.code === 'P2002') {
      throw new Error('Ya existe una cuenta registrada con ese correo');
    }
    throw err;
  }

  await dispositivos.registrarInicioSeguro({
    usuarioId: usuario.id_usuario,
    usuarioNombre: `${nombres} ${apellidos}`,
    usuarioRol: 'comprador',
    dispositivo,
  });

  const { contrasena: _omit, ...usuarioSinPassword } = usuario;
  return usuarioSinPassword;
}

async function obtenerPerfil(id_usuario) {
  const usuario = await prisma.usuarios.findUnique({
    where: { id_usuario },
    select: {
      id_usuario: true,
      nombres: true,
      apellidos: true,
      correo: true,
      fecha_nacimiento: true,
      rol: { select: { tipo_rol: true } },
    },
  });
  if (!usuario) throw new Error('Usuario no encontrado');
  return usuario;
}

async function login({ correo, contrasena }, { dispositivo } = {}) {
  const usuario = await prisma.usuarios.findUnique({ where: { correo }, include: { rol: true } });
  if (!usuario) throw new Error('Credenciales inválidas');

  const valido = await bcrypt.compare(contrasena, usuario.contrasena);
  if (!valido) throw new Error('Credenciales inválidas');

  // Con la contraseña ya comprobada, esta cuenta entró desde este dispositivo (antifraude, PLAN-NEO4J §22).
  // Se anota ANTES de la suspensión a propósito: una cuenta suspendida que intenta entrar desde un dispositivo
  // nuevo es justo la pista que sirve para vincularla con otras. Quien no sabe la contraseña no llega acá, así
  // que nadie puede ensuciar el historial de una cuenta ajena. Una falla se registra y no impide entrar.
  await dispositivos.registrarInicioSeguro({
    usuarioId: usuario.id_usuario,
    usuarioNombre: `${usuario.nombres} ${usuario.apellidos}`,
    usuarioRol: usuario.rol.tipo_rol,
    dispositivo,
  });

  // Una cuenta suspendida (ver suspensionService.js) no recibe token nuevo. Se
  // revisa DESPUÉS de la contraseña: quien no la sabe no se entera de que la
  // cuenta existe ni de que está suspendida.
  await exigirCuentaActiva(usuario.id_usuario, usuario.rol.tipo_rol);

  const token = jwt.sign(
    { id_usuario: usuario.id_usuario, rol_id: usuario.rol_id, rol: usuario.rol.tipo_rol },
    JWT_SECRET,
    { expiresIn: '2h' }
  );

  return { token };
}

module.exports = { registrar, login, obtenerPerfil };
