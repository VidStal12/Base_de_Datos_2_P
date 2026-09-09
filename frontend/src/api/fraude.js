import { api } from './client';

// Señales de fraude (Neo4j, ver IA/PLAN-NEO4J-DETECCION-FRAUDE.md) — solo
// administrador.
export const fraudeApi = {
  consultar: (token) => api.get('/admin/fraude', token),
};
