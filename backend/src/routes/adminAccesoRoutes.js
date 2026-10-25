const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const politica = require('../services/politicaAccesoService');
const usuarioAdmin = require('../services/usuarioAdminService');
const auditoria = require('../services/auditoriaAccesoService');
const { responderError } = require('../utils/http');
const { componenteCaido, esErrorDeAcceso, registrarFallo } = require('../utils/resiliencia');

// La pantalla /admin/permisos (IA/ADR-007 §9): la matriz de permisos, el simulador, las cuentas con sus roles y el
// registro de auditoría. TODAS son solo de administrador y ninguna se puede conceder a otro rol (fijas en
// config/politicaRutas.js): quien pudiera administrar permisos podría concederse todo lo demás.
const router = express.Router();

const texto = (valor) => (typeof valor === 'string' ? valor : undefined);
const sinGuardar = (res) => res.set('Cache-Control', 'no-store');

// Los errores previstos de los servicios (con `status`: 400, 404, 409) salen tal cual; una base apagada, como en el resto de la
// API (503); y cualquier otra cosa es un error del servidor: se anota en el log y al cliente le llega un mensaje genérico
// (nunca el texto crudo de Prisma, que trae rutas de archivo).
function responder(res, err) {
  if (err.status || componenteCaido(err) || esErrorDeAcceso(err)) return responderError(res, err);
  registrarFallo('No se pudo completar una operación de permisos', err);
  return res.status(500).json({ error: 'No se pudo completar la operación. Probá de nuevo en unos instantes.' });
}

router.get('/permisos', requireAuth, requireRole('administrador'), async (req, res) => {
  try {
    sinGuardar(res).json(await politica.matriz());
  } catch (err) {
    responder(res, err);
  }
});

// Un lote de cambios, todo o nada: { cambios: [{ clave, rol, permitido }] }.
router.put('/permisos', requireAuth, requireRole('administrador'), async (req, res) => {
  try {
    res.json(await politica.aplicarCambios(req.usuario, req.body?.cambios));
  } catch (err) {
    responder(res, err);
  }
});

// { clave?, rol? }: sin ninguno de los dos, toda la política vuelve a lo que declara el código.
router.post('/permisos/restaurar', requireAuth, requireRole('administrador'), async (req, res) => {
  try {
    res.json(await politica.restaurar(req.usuario, { clave: texto(req.body?.clave), rol: texto(req.body?.rol) }));
  } catch (err) {
    responder(res, err);
  }
});

// ?clave=GET /api/admin/ventas&rol=vendedor  —o—  ?clave=…&usuarioId=12
router.get('/permisos/simular', requireAuth, requireRole('administrador'), async (req, res) => {
  try {
    const { clave, rol, usuarioId } = req.query;
    if (typeof clave !== 'string' || !clave) return res.status(400).json({ error: 'Indicá la ruta a simular (clave).' });
    if ((rol !== undefined && typeof rol !== 'string') || (usuarioId !== undefined && typeof usuarioId !== 'string')) {
      return res.status(400).json({ error: 'El rol y la cuenta se indican una sola vez.' });
    }
    sinGuardar(res).json(await politica.simular({ clave, rol, usuarioId }));
  } catch (err) {
    responder(res, err);
  }
});

router.post('/roles', requireAuth, requireRole('administrador'), async (req, res) => {
  try {
    res.status(201).json(await usuarioAdmin.crearRol(req.usuario, req.body?.nombre));
  } catch (err) {
    responder(res, err);
  }
});

router.delete('/roles/:id', requireAuth, requireRole('administrador'), async (req, res) => {
  try {
    res.json(await usuarioAdmin.eliminarRol(req.usuario, req.params.id));
  } catch (err) {
    responder(res, err);
  }
});

router.get('/usuarios', requireAuth, requireRole('administrador'), async (req, res) => {
  try {
    sinGuardar(res).json(await usuarioAdmin.listarUsuarios({ q: texto(req.query.q), pagina: texto(req.query.pagina), tamano: texto(req.query.tamano) }));
  } catch (err) {
    responder(res, err);
  }
});

router.patch('/usuarios/:id/rol', requireAuth, requireRole('administrador'), async (req, res) => {
  try {
    res.json(await usuarioAdmin.cambiarRol(req.usuario, req.params.id, req.body?.rol));
  } catch (err) {
    responder(res, err);
  }
});

const filtrosDeAuditoria = (q) => ({ tipo: texto(q.tipo), actor: texto(q.actor), desde: texto(q.desde), hasta: texto(q.hasta), pagina: texto(q.pagina), tamano: texto(q.tamano) });

router.get('/auditoria', requireAuth, requireRole('administrador'), async (req, res) => {
  try {
    sinGuardar(res).json(await auditoria.listar(filtrosDeAuditoria(req.query)));
  } catch (err) {
    responder(res, err);
  }
});

router.get('/auditoria/exportar', requireAuth, requireRole('administrador'), async (req, res) => {
  try {
    const csv = await auditoria.exportarCsv(filtrosDeAuditoria(req.query));
    const dia = new Date().toISOString().slice(0, 10);
    sinGuardar(res)
      .type('text/csv; charset=utf-8')
      .set('Content-Disposition', `attachment; filename="auditoria-acceso-${dia}.csv"`)
      .send(`\uFEFF${csv}`); // la marca de orden de bytes hace que Excel lea los acentos como UTF-8
  } catch (err) {
    responder(res, err);
  }
});

module.exports = router;
