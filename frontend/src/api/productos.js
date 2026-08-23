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
};

export const categoriasApi = {
  listar: () => api.get('/categorias'),
  crear: (datos, token) => api.post('/categorias', datos, token),
  crearSubcategoria: (categoriaId, datos, token) => api.post(`/categorias/${categoriaId}/subcategorias`, datos, token),
  crearAtributo: (subcategoriaId, datos, token) =>
    api.post(`/categorias/subcategorias/${subcategoriaId}/atributos`, datos, token),
};
