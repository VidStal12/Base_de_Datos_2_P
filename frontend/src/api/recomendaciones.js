import { api } from './client';

// Recomendaciones por tendencia (Entrega 2, ver IA/ENTREGA-2-PLAN.md §4.5) —
// analiza el historial de compras del usuario y encuentra productos
// similares de otros vendedores, sin que nadie las configure a mano
// (distinto de /ofertas, que sí requiere que un vendedor la active).
export const recomendacionesApi = {
  obtener: (token) => api.get('/recomendaciones', token),
  comprar: (productoId, datos, token) => api.post(`/recomendaciones/${productoId}/comprar`, datos, token),
};
