import { api } from './client';

// Carrito persistente en MySQL con caché Redis (requiere sesión iniciada — ver
// IA/ENTREGA-2-PLAN.md §4.1) — todas las llamadas necesitan token.
export const carritoApi = {
  obtener: (token) => api.get('/carrito', token),
  revisar: (token) => api.post('/carrito/revisar', {}, token),
  agregar: (productoId, cantidad, token) => api.post('/carrito/items', { productoId, cantidad }, token),
  actualizarCantidad: (productoId, cantidad, token) => api.patch(`/carrito/items/${productoId}`, { cantidad }, token),
  quitar: (productoId, token) => api.delete(`/carrito/items/${productoId}`, token),
  vaciar: (token) => api.delete('/carrito', token),
};
