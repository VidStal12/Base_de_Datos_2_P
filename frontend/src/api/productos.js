import { api } from './client';

export const productosApi = {
  listar: (filtros = {}) => {
    const params = new URLSearchParams(filtros);
    const query = params.toString() ? `?${params.toString()}` : '';
    return api.get(`/productos${query}`);
  },
  obtener: (id) => api.get(`/productos/${id}`),
  crear: (datos, token) => api.post('/productos', datos, token),
  actualizar: (id, datos, token) => api.patch(`/productos/${id}`, datos, token),
  historial: (id) => api.get(`/productos/${id}/historial`),
  historialEnFecha: (id, fecha) => api.get(`/productos/${id}/historial?fecha=${fecha}`),
  estadisticasEdiciones: (desde) =>
    api.get(`/productos/estadisticas/ediciones${desde ? `?desde=${desde}` : ''}`),
};

export const categoriasApi = {
  listar: () => api.get('/categorias'),
  crear: (datos, token) => api.post('/categorias', datos, token),
  crearSubcategoria: (categoriaId, datos, token) => api.post(`/categorias/${categoriaId}/subcategorias`, datos, token),
  crearAtributo: (subcategoriaId, datos, token) =>
    api.post(`/categorias/subcategorias/${subcategoriaId}/atributos`, datos, token),
};
