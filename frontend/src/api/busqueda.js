import { api } from './client';

// Búsqueda de productos (Entrega 3, ver IA/PLAN-ELASTICSEARCH-BUSQUEDA.md) —
// Elasticsearch: tolerancia ortográfica + relevancia + facetas agregadas.
// Público (no requiere token), pero si se pasa uno, permite personalizar la
// respuesta cuando la búsqueda no encuentra nada (ver catalogoLecturaService.js).
export const busquedaApi = {
  buscar: (filtros = {}, token) => {
    const params = new URLSearchParams(filtros);
    const query = params.toString() ? `?${params.toString()}` : '';
    return api.get(`/busqueda${query}`, token);
  },
  // Autocompletado (completion suggester) — respuesta { sugerencias: string[] }.
  sugerir: (q) => api.get(`/busqueda/sugerencias?q=${encodeURIComponent(q)}`),
};
