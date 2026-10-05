const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../config/prisma');
const { esCorreoValido, validarPassword } = require('../utils/validation');
const { exigirCuentaActiva } = require('./suspensionService');

const JWT_SECRET = process.env.JWT_SECRET;

// El rol nunca se toma del body: si el cliente pudiera pasar rol_id libremente,
// cualquiera podría autoregistrarse como "administrador". El auto-registro
// siempre asigna "comprador"; otros roles se asignan por otra vía (fuera de
// alcance de la Fase Inicial).
async function registrar({ nombres, apellidos, correo, contrasena, fecha_nacimiento }) {
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

async function login({ correo, contrasena }) {
  const usuario = await prisma.usuarios.findUnique({ where: { correo }, include: { rol: true } });
  if (!usuario) throw new Error('Credenciales inválidas');

  const valido = await bcrypt.compare(contrasena, usuario.contrasena);
  if (!valido) throw new Error('Credenciales inválidas');

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
