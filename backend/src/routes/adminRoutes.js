const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { recalcularVentas, recalcularInventario } = require('../services/catalogoSyncService');
const { consultarVentas } = require('../services/ventasService');
const { consultarFraude } = require('../services/fraudeService');
const bloqueoService = require('../services/bloqueoService');
const { mapaBloqueadas } = require('../services/suspensionService');
const { mapaRestringidas } = require('../services/restriccionService');
const limitePedidos = require('../services/limitePedidosService');
const { responderError } = require('../utils/http');
const { registrarFallo } = require('../utils/resiliencia');

const router = express.Router();

// Errores previstos del servicio (400/404) se devuelven tal cual; cualquier otra
// cosa es una dependencia caída y se informa sin detalles internos.
function responderErrorBloqueo(res, err, contexto) {
  if ([400, 404].includes(err.status)) return res.status(err.status).json({ error: err.message });
  registrarFallo(contexto, err);
  return res.status(503).json({ error: 'No se pudo completar la operación. Intenta nuevamente en unos momentos.' });
}

function idDeUsuario(req, res) {
  const id = Number(req.params.usuarioId);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'El id de usuario no es válido' });
    return null;
  }
  return id;
}

// Solo administradores pueden leer el informe. Cassandra caída es un error
// explícito: una respuesta vacía no debe confundirse con cero ventas.
router.get('/ventas', requireAuth, requireRole('administrador'), async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await consultarVentas(req.query));
  } catch (err) {
    const status = [400, 422].includes(err.status) ? err.status : 503;
    if (status === 503) registrarFallo('No se pudo consultar el panel de ventas', err);
    res.status(status).json({ error: status === 503 ? 'El informe de ventas no está disponible. Intenta nuevamente en unos momentos.' : err.message });
  }
});

// Señales de posible fraude (ver IA/PLAN-NEO4J-DETECCION-FRAUDE.md) — nunca
// una acusación, candidatos para revisión humana. Solo administrador, mismo
// criterio que /ventas.
router.get('/fraude', requireAuth, requireRole('administrador'), async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    // `bloqueadas` y `restringidas` ({ id → hasta cuándo }) dejan marcar en el panel las
    // cuentas que ya están suspendidas o con límites suaves; si Redis no responde el
    // panel sigue, sin las marcas.
    const [datos, bloqueadas, restringidas] = await Promise.all([
      consultarFraude(),
      mapaBloqueadas().catch(() => ({})),
      mapaRestringidas().catch(() => ({})),
    ]);
    res.json({ ...datos, bloqueadas, restringidas });
  } catch (err) {
    registrarFallo('No se pudo consultar las señales de fraude', err);
    res.status(503).json({ error: 'Las señales de fraude no están disponibles. Intenta nuevamente en unos momentos.' });
  }
});

// Suspensión temporal de cuentas por fraude de confianza alta (ver
// bloqueoService.js e IA/PLAN-NEO4J-DETECCION-FRAUDE.md §20). Todo esto es SOLO de
// administrador: la revisión de cada caso es una decisión humana.
router.get('/bloqueos', requireAuth, requireRole('administrador'), async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const datos = await bloqueoService.listar();
    // El tope general de pedidos por hora no es del bloqueo de cuentas, pero el panel lo
    // muestra junto a lo demás que el sistema hace solo (0 = sin tope).
    const advertencias = [...datos.advertencias];
    let pedidosPorHora = null;
    try {
      pedidosPorHora = limitePedidos.configuracion().porHora;
    } catch (err) {
      advertencias.push(err.message);
    }
    res.json({ ...datos, advertencias, configuracion: { ...datos.configuracion, pedidosPorHora } });
  } catch (err) {
    responderErrorBloqueo(res, err, 'No se pudo listar las cuentas bloqueadas');
  }
});

// Corre el barrido ahora (el mismo que corre el temporizador) en vez de esperar
// al siguiente.
router.post('/bloqueos/evaluar', requireAuth, requireRole('administrador'), async (req, res) => {
  try {
    res.json(await bloqueoService.evaluar());
  } catch (err) {
    responderErrorBloqueo(res, err, 'No se pudo evaluar el bloqueo de cuentas');
  }
});

// "Dar el visto bueno": levanta la suspensión ahora (era un falso positivo).
router.post('/bloqueos/:usuarioId/liberar', requireAuth, requireRole('administrador'), async (req, res) => {
  const usuarioId = idDeUsuario(req, res);
  if (usuarioId === null) return;
  try {
    res.json(await bloqueoService.liberar(usuarioId, req.usuario.id_usuario, req.body?.nota));
  } catch (err) {
    responderErrorBloqueo(res, err, 'No se pudo levantar el bloqueo');
  }
});

// Quita los límites suaves de una cuenta bajo vigilancia (hallazgo «posible») antes
// de que venzan solos.
router.post('/bloqueos/:usuarioId/quitar-restriccion', requireAuth, requireRole('administrador'), async (req, res) => {
  const usuarioId = idDeUsuario(req, res);
  if (usuarioId === null) return;
  try {
    res.json(await bloqueoService.quitarRestriccion(usuarioId, req.usuario.id_usuario, req.body?.nota));
  } catch (err) {
    responderErrorBloqueo(res, err, 'No se pudo quitar la restricción');
  }
});

// Mantiene la suspensión y le suma `horas`.
router.post('/bloqueos/:usuarioId/extender', requireAuth, requireRole('administrador'), async (req, res) => {
  const usuarioId = idDeUsuario(req, res);
  if (usuarioId === null) return;
  try {
    res.json(await bloqueoService.extender(usuarioId, req.usuario.id_usuario, Number(req.body?.horas), req.body?.nota));
  } catch (err) {
    responderErrorBloqueo(res, err, 'No se pudo extender el bloqueo');
  }
});

// Reconciliación, no adición: recalcula total_vendido desde compra_detalle
// (MySQL) y SOBRESCRIBE el valor cacheado en Mongo. Ver catalogoSyncService.js.
router.post('/recalcular-ventas', requireAuth, requireRole('administrador'), async (req, res) => {
  try {
    const resultado = await recalcularVentas();
    res.json(resultado);
  } catch (err) {
    responderError(res, err, 500);
  }
});

// Reconciliación de precio/cantidad (caché en Mongo) desde inventario
// (MySQL) — mismo espíritu que recalcular-ventas. Ver catalogoSyncService.js.
router.post('/recalcular-inventario', requireAuth, requireRole('administrador'), async (req, res) => {
  try {
    const resultado = await recalcularInventario();
    res.json(resultado);
  } catch (err) {
    responderError(res, err, 500);
  }
});

module.exports = router;
