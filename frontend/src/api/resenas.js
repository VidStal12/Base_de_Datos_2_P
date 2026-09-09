import { api } from './client';

export const resenasApi = {
  listar: (productoId) => api.get(`/productos/${productoId}/resenas`),
  crear: (productoId, datos, token) => api.post(`/productos/${productoId}/resenas`, datos, token),
};