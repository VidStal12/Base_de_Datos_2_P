import { api } from './client';

export const authApi = {
  registrar: (datos) => api.post('/auth/registro', datos),
  login: (credenciales) => api.post('/auth/login', credenciales),
  perfil: (token) => api.get('/auth/me', token),
};
