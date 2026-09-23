import { api } from './client';

// Búsqueda de productos (Entrega 3, ver IA/PLAN-ELASTICSEARCH-BUSQUEDA.md) —
// Elasticsearch: tolerancia ortográfica + relevancia + facetas agregadas.
// Público, mismo criterio que productosApi.listar.
export const busquedaApi = {
  buscar: (filtros = {}) => {
    const params = new URLSearchParams(filtros);
    const query = params.toString() ? `?${params.toString()}` : '';
    return api.get(`/busqueda${query}`);
  },
};
