const express = require('express');
const { registrar, login, obtenerPerfil } = require('../services/authService');
const politica = require('../services/politicaAccesoService');
const { desdeCabeceras } = require('../services/dispositivoService');
const { requireAuth } = require('../middleware/auth');
const { responderError } = require('../utils/http');
const { componenteCaido, esErrorDeAcceso } = require('../utils/resiliencia');

const router = express.Router();

// El dispositivo desde el que se registra o entra una cuenta lo manda el frontend en las cabeceras
// X-Dispositivo y X-Dispositivo-Perfil (ver services/dispositivoService.js); sin ellas (un script, un cliente
// viejo) simplemente no se anota nada.
router.post('/registro', async (req, res) => {
  try {
    const usuario = await registrar(req.body, { dispositivo: desdeCabeceras((nombre) => req.get(nombre)) });
    res.status(201).json(usuario);
  } catch (err) {
    responderError(res, err, 400);
  }
});

router.post('/login', async (req, res) => {
  try {
    const resultado = await login(req.body, { dispositivo: desdeCabeceras((nombre) => req.get(nombre)) });
    res.json(resultado);
  } catch (err) {
    // Una base apagada NO es «credenciales inválidas»: 503 con el aviso de qué falta
    // (antes devolvía 401 con el mensaje crudo de Prisma, y la interfaz mostraba eso).
    // (Y una base que rechaza las credenciales del backend tampoco es «credenciales inválidas» de la persona.)
    if (componenteCaido(err) || esErrorDeAcceso(err)) return responderError(res, err);
    // 401 para credenciales inválidas; 403 con `codigo` si la cuenta está
    // suspendida (la interfaz reacciona al código, no al texto).
    res.status(err.status ?? 401).json({ error: err.message, ...(err.codigo && { codigo: err.codigo, hasta: err.hasta }) });
  }
});

router.get('/me', requireAuth, async (req, res) => {
  try {
    const usuario = await obtenerPerfil(req.usuario.id_usuario);
    // Las rutas por roles que ESTE rol puede usar hoy (la lista blanca más lo que ajustó un administrador): la interfaz
    // las usa para decidir qué secciones ofrece. Quien manda es la API: esto no concede nada.
    const permisos = await politica.permisosDe(usuario.rol.tipo_rol);
    res.json({ ...usuario, permisos });
  } catch (err) {
    // 404 solo si la cuenta no existe: con MySQL apagado es 503, y la interfaz NO debe
    // interpretarlo como «sesión inválida» y cerrarla.
    responderError(res, err, 404);
  }
});

module.exports = router;
