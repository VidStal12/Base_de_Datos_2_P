import { api } from './client';

export const adminApi = {
  sincronizarCatalogo: (token) => api.post('/admin/sync-catalogo', undefined, token),
};
