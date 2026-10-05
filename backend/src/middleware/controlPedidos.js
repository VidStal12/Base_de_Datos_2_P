const limitePedidos = require('../services/limitePedidosService');
const restriccionService = require('../services/restriccionService');
const reautenticacion = require('../services/reautenticacionService');

// Control de un pedido ANTES de que se complete (IA/PLAN-NEO4J-DETECCION-FRAUDE.md §21),
// en las tres rutas de compra (checkout, oferta flash, recomendación), después de
// requireAuth. Hace dos cosas, en este orden:
//
//   1. Límites suaves de una cuenta bajo revisión (hallazgo «posible», ver
//      restriccionService.js): pide la contraseña en cada pedido y deja pasado a los
//      servicios el tope de monto (req.limitesPedido), que ellos hacen cumplir dentro de
//      la transacción — es donde se conoce el total.
//   2. El tope de pedidos por hora (limitePedidosService.js): se RESERVA un pedido de la
//      ventana de la cuenta y, si la respuesta termina siendo un error (stock, precio,
//      dirección…), se devuelve — un pedido que falla no gasta el cupo. Para una cuenta
//      con límites suaves rige el menor entre el tope general y el suyo.
//
// La contraseña se comprueba ANTES de reservar: un intento fallido no gasta un pedido.
// Está en las rutas y no en los servicios a propósito: es una protección del canal HTTP,
// y así los scripts y las pruebas que llaman a los servicios no la sienten. Falla abierto:
// sin Redis, o con una configuración mal escrita, no se frena a nadie.

const CODIGO_REQUIERE_CONTRASENA = 'REQUIERE_CONTRASENA';
const CODIGO_CONTRASENA_INCORRECTA = 'CONTRASENA_INCORRECTA';
const CODIGO_DEMASIADOS_INTENTOS = 'DEMASIADOS_INTENTOS';
const CODIGO_LIMITE_PEDIDOS = 'LIMITE_PEDIDOS';

const minutosTexto = (segundos) => {
  const minutos = Math.max(1, Math.ceil(segundos / 60));
  return `${minutos} ${minutos === 1 ? 'minuto' : 'minutos'}`;
};

let ultimoAviso = 0;
function avisarFallo(err) {
  if (Date.now() - ultimoAviso < 30000) return;
  ultimoAviso = Date.now();
  console.error('No se pudo aplicar el control de pedidos (se deja pasar):', err.message);
}

function rechazarPorTiempo(res, error, codigo, segundos) {
  res.set('Retry-After', String(segundos));
  return res.status(429).json({ error, codigo, reintentarEnSegundos: segundos });
}

function limiteGeneral() {
  try {
    return limitePedidos.configuracion().porHora;
  } catch (err) {
    avisarFallo(err);
    return 0;
  }
}

async function controlPedidos(req, res, next) {
  const usuarioId = req.usuario.id_usuario;
  try {
    const limites = await restriccionService.limitesDe(usuarioId, req.usuario.rol);

    if (limites) {
      const contrasena = req.body?.contrasena;
      if (typeof contrasena !== 'string' || contrasena === '') {
        return res.status(403).json({ error: 'Tu cuenta está en revisión: confirmá este pedido con tu contraseña.', codigo: CODIGO_REQUIERE_CONTRASENA });
      }
      const verificacion = await reautenticacion.verificarContrasena(usuarioId, contrasena);
      if (!verificacion.ok) {
        if (verificacion.motivo === 'demasiados') {
          return rechazarPorTiempo(
            res,
            `Demasiados intentos con la contraseña. Probá de nuevo en ${minutosTexto(verificacion.reintentarEnSegundos)}.`,
            CODIGO_DEMASIADOS_INTENTOS,
            verificacion.reintentarEnSegundos
          );
        }
        return res.status(403).json({ error: 'La contraseña no es correcta.', codigo: CODIGO_CONTRASENA_INCORRECTA });
      }
      // Los servicios hacen cumplir el tope de monto: solo ellos conocen el total.
      req.limitesPedido = { montoMaximo: limites.montoMaximo };
    }

    // El menor de los topes que apliquen (0 / null = ese tope no existe).
    const topes = [limiteGeneral(), limites?.pedidosPorHora].filter((n) => n > 0);
    if (topes.length > 0) {
      const limite = Math.min(...topes);
      let reserva = null;
      try {
        reserva = await limitePedidos.reservar(usuarioId, limite);
      } catch (err) {
        avisarFallo(err);
      }
      if (reserva && !reserva.admitido) {
        return rechazarPorTiempo(
          res,
          `Llegaste al máximo de ${limite} ${limite === 1 ? 'pedido' : 'pedidos'} por hora${limites ? ' (tu cuenta está en revisión)' : ''}. Podés volver a intentarlo en ${minutosTexto(reserva.reintentarEnSegundos)}.`,
          CODIGO_LIMITE_PEDIDOS,
          reserva.reintentarEnSegundos
        );
      }
      if (reserva) {
        // El pedido que termina en error no gasta el cupo (best-effort: si Redis
        // falla acá, a lo sumo la ventana queda con un pedido de más).
        res.on('finish', () => {
          if (res.statusCode >= 400) limitePedidos.liberar(usuarioId).catch(() => {});
        });
      }
    }
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = {
  controlPedidos,
  CODIGO_REQUIERE_CONTRASENA,
  CODIGO_CONTRASENA_INCORRECTA,
  CODIGO_DEMASIADOS_INTENTOS,
  CODIGO_LIMITE_PEDIDOS,
};
