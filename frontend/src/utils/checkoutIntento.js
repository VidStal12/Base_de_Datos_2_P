import { checkoutApi } from '../api/cuenta';

export const claveIntento = (usuarioId, productoId) => `tiendaya_checkout:${usuarioId}:${productoId ? `flash:${productoId}` : 'normal'}`;

// sessionStorage conserva el intento en una recarga; la sesión del servidor
// comparte el mismo intento entre ventanas, sin carreras de localStorage.
export async function cargarIntento(clave, preparar, token) {
  const guardado = sessionStorage.getItem(clave);
  if (guardado) {
    try { return { ...await checkoutApi.intento(guardado, token), recuperado: true }; }
    catch (err) {
      if (err.status !== 404) throw err; // Una caída no autoriza crear otra compra.
      sessionStorage.removeItem(clave);
    }
  }
  const intento = await preparar({});
  sessionStorage.setItem(clave, intento.intentoId);
  return intento;
}

export async function renovarIntento(clave, anterior, preparar, token) {
  const estado = await checkoutApi.cancelar(anterior.intentoId, token);
  // Pudo confirmarse mientras se solicitaba revisar: mostrar ese pedido.
  if (anterior.estado !== 'completado' && estado.estado === 'completado') return { ...estado, recuperado: true };
  const nuevo = await preparar({ anteriorIntentoId: anterior.intentoId });
  sessionStorage.setItem(clave, nuevo.intentoId);
  return nuevo;
}
