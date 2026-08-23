const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../config/prisma');

const JWT_SECRET = process.env.JWT_SECRET;

async function registrar({ nombres, apellidos, correo, contrasena, fecha_nacimiento, rol_id }) {
  const hash = await bcrypt.hash(contrasena, 10);
  const usuario = await prisma.usuarios.create({
    data: {
      nombres,
      apellidos,
      correo,
      contrasena: hash,
      fecha_nacimiento: new Date(fecha_nacimiento),
      rol_id,
    },
  });

  const { contrasena: _omit, ...usuarioSinPassword } = usuario;
  return usuarioSinPassword;
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

module.exports = { registrar, login };
