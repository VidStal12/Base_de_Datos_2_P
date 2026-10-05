// Suspensión temporal de cuentas por fraude de confianza alta (ver
// backend/src/services/suspensionService.js y bloqueoService.js).
//
// El servidor responde 403 con `codigo: CUENTA_SUSPENDIDA` a cualquier petición de
// una cuenta suspendida, y a su login. La interfaz reacciona al código, no al texto:
// api/client.js avisa con un evento de ventana (así no hace falta tocar cada pantalla
// que llama a la API) y AuthContext cierra la sesión y guarda el aviso que muestra
// el banner de components/layout/AvisoSuspension.jsx.
export const CODIGO_CUENTA_SUSPENDIDA = 'CUENTA_SUSPENDIDA';
export const EVENTO_CUENTA_SUSPENDIDA = 'tiendaya:cuenta-suspendida';
