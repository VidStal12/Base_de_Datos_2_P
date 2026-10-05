// Cuenta bajo revisión (límites suaves, ver backend/src/services/restriccionService.js
// e IA/PLAN-NEO4J-DETECCION-FRAUDE.md §21): una cuenta con un hallazgo de fraude de
// confianza «posible» sigue comprando, pero con límites — su contraseña en cada pedido,
// un tope de monto por pedido y menos pedidos por hora. Los hace cumplir el servidor
// (middleware/controlPedidos.js); la interfaz solo reacciona a sus rechazos, sin
// saber de antemano si la cuenta está en revisión.
//
// El tope de monto (403 LIMITE_MONTO) y el de pedidos por hora (429 LIMITE_PEDIDOS)
// traen su explicación en el mensaje, que las pantallas de compra ya muestran tal
// cual; lo único que pide un paso propio es la contraseña.

// Falta la contraseña (la primera vez que una cuenta restringida confirma un pedido).
export const CODIGO_REQUIERE_CONTRASENA = 'REQUIERE_CONTRASENA';
// La contraseña escrita no es la de la cuenta.
export const CODIGO_CONTRASENA_INCORRECTA = 'CONTRASENA_INCORRECTA';
// Demasiados intentos fallidos seguidos: el servidor frena un rato.
export const CODIGO_DEMASIADOS_INTENTOS = 'DEMASIADOS_INTENTOS';

const CODIGOS_CONTRASENA = new Set([CODIGO_REQUIERE_CONTRASENA, CODIGO_CONTRASENA_INCORRECTA, CODIGO_DEMASIADOS_INTENTOS]);

// ¿El rechazo es del paso de la contraseña? Entonces la pantalla deja abierto (o abre)
// el diálogo que la pide, en vez de enseñar un error suelto.
export const esRechazoDeContrasena = (err) => CODIGOS_CONTRASENA.has(err?.codigo);

// Lo que el diálogo muestra como error: nada la primera vez que se la pide (no hay
// nada que reprochar todavía), y el motivo del servidor si ya se intentó.
export const errorDeContrasena = (err) => (err.codigo === CODIGO_REQUIERE_CONTRASENA ? '' : err.message);
