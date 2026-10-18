import { api } from './client';

// Oferta flash (Entrega 2, ver IA/ENTREGA-2-PLAN.md §4.2) — endpoints propios,
// separados de /carrito y /checkout a propósito: no reemplazan el checkout
// normal (ver backend/src/services/ofertaFlashService.js).
export const ofertasApi = {
  preparar: (productoId, datos, token) => api.post(`/ofertas/${productoId}/intentos`, datos, token),
  consultarStock: (productoId) => api.get(`/ofertas/${productoId}/stock`),
  actualizar: (productoId, datos, token) => api.patch(`/ofertas/${productoId}`, datos, token),
  comprar: (productoId, datos, token) => api.post(`/ofertas/${productoId}/comprar`, datos, token),
};
