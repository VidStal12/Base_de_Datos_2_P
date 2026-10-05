// Compromiso de no reventa (ver backend/src/services/compromisoService.js e
// IA/PLAN-NEO4J-DETECCION-FRAUDE.md §19): una cuenta que puede vender en
// TiendaYa puede comprar productos de otros vendedores, pero no revenderlos.
// Antes de pagar tiene que aceptar ese compromiso en un aviso, y el servidor
// deja constancia de la aceptación en el pedido.

// Las cuentas que pueden publicar productos — las mismas que el servidor obliga
// a aceptar (compromisoService.ROLES_QUE_VENDEN). El servidor es quien decide de
// verdad: esto solo evita un viaje de ida y vuelta para mostrar el aviso a quien
// seguro le toca.
const ROLES_QUE_VENDEN = ['vendedor', 'administrador'];

// Código que trae el rechazo del servidor cuando falta la aceptación (400). Si la
// interfaz tenía un rol desactualizado y no mostró el aviso, esto lo reabre en
// vez de enseñar un error suelto.
export const CODIGO_COMPROMISO = 'COMPROMISO_NO_REVENTA';

// `usuario` es el perfil de AuthContext: el rol viaja como { tipo_rol }.
export function puedeVender(usuario) {
  return ROLES_QUE_VENDEN.includes(usuario?.rol?.tipo_rol);
}
