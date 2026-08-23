import { api } from './client';

export const direccionesApi = {
  listar: (token) => api.get('/direcciones', token),
  crear: (datos, token) => api.post('/direcciones', datos, token),
  eliminar: (id, token) => api.delete(`/direcciones/${id}`, token),
};

export const metodosPagoApi = {
  listar: (token) => api.get('/metodos-pago', token),
  crear: (datos, token) => api.post('/metodos-pago', datos, token),
  eliminar: (id, token) => api.delete(`/metodos-pago/${id}`, token),
};

export const checkoutApi = {
  confirmar: (datos, token) => api.post('/checkout', datos, token),
};

export const comprasApi = {
  listar: (token) => api.get('/compras', token),
  obtener: (id, token) => api.get(`/compras/${id}`, token),
};
