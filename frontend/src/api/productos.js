import { api } from './client';

export const productosApi = {
  // token opcional: sin él (navegación pública) el backend solo devuelve
  // productos activos. Con un token de vendedor/administrador válido, también
  // incluye los inactivos que ese token autoriza a ver (ver productoRoutes.js).
  listar: (filtros = {}, token) => {
    const params = new URLSearchParams(filtros);
    const query = params.toString() ? `?${params.toString()}` : '';
    return api.get(`/productos${query}`, token);
  },
  obtener: (id) => api.get(`/productos/${id}`),
  crear: (datos, token) => api.post('/productos', datos, token),
  actualizar: (id, datos, token) => api.patch(`/productos/${id}`, datos, token),
  // Solo vendedor/administrador (ver productoRoutes.js) — requiere token.
  historial: (id, token) => api.get(`/productos/${id}/historial`, token),
  historialEnFecha: (id, fecha, token) => api.get(`/productos/${id}/historial?fecha=${fecha}`, token),
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
