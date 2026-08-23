const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../config/prisma');

const JWT_SECRET = process.env.JWT_SECRET;

// El rol nunca se toma del body: si el cliente pudiera pasar rol_id libremente,
// cualquiera podría autoregistrarse como "administrador". El auto-registro
// siempre asigna "comprador"; otros roles se asignan por otra vía (fuera de
// alcance de la Fase Inicial).
async function registrar({ nombres, apellidos, correo, contrasena, fecha_nacimiento }) {
  const rolComprador = await prisma.rol_usuario.findFirst({ where: { tipo_rol: 'comprador' } });
  if (!rolComprador) throw new Error('El rol "comprador" no está configurado. Corré el seed primero.');

  const hash = await bcrypt.hash(contrasena, 10);
  const usuario = await prisma.usuarios.create({
    data: {
      nombres,
      apellidos,
      correo,
      contrasena: hash,
      fecha_nacimiento: new Date(fecha_nacimiento),
      rol_id: rolComprador.id,
    },
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

async function login({ correo, contrasena }) {
  const usuario = await prisma.usuarios.findUnique({ where: { correo } });
  if (!usuario) throw new Error('Credenciales inválidas');

  const valido = await bcrypt.compare(contrasena, usuario.contrasena);
  if (!valido) throw new Error('Credenciales inválidas');

  const token = jwt.sign(
    { id_usuario: usuario.id_usuario, rol_id: usuario.rol_id },
    JWT_SECRET,
    { expiresIn: '2h' }
  );

  return { token };
}

module.exports = { registrar, login, obtenerPerfil };
