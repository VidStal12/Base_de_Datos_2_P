import { api } from './client';

// La pantalla /admin/permisos (ver IA/ADR-007 §9). Todo es solo de administrador: el servidor lo exige en cada ruta.
const consulta = (filtros) => {
  const parametros = new URLSearchParams();
  for (const [campo, valor] of Object.entries(filtros)) if (valor !== undefined && valor !== null && String(valor) !== '') parametros.set(campo, valor);
  const texto = parametros.toString();
  return texto ? `?${texto}` : '';
};

export const permisosApi = {
  // La matriz: roles, rutas, lo que declara el código y lo que cambió un administrador.
  matriz: (token) => api.get('/admin/permisos', token),
  // Un lote de cambios, todo o nada: [{ clave, rol, permitido }].
  aplicar: (cambios, token) => api.put('/admin/permisos', { cambios }, token),
  // Vuelve a lo que declara el código: una ruta, un rol o (sin filtros) todo.
  restaurar: (filtro, token) => api.post('/admin/permisos/restaurar', filtro, token),
  // ¿Puede este rol (o esta cuenta) usar esta ruta? Es la misma decisión que aplica la API.
  simular: ({ clave, rol, usuarioId }, token) => api.get(`/admin/permisos/simular${consulta({ clave, rol, usuarioId })}`, token),
  crearRol: (nombre, token) => api.post('/admin/roles', { nombre }, token),
  borrarRol: (id, token) => api.delete(`/admin/roles/${id}`, token),
  usuarios: (filtros, token) => api.get(`/admin/usuarios${consulta(filtros)}`, token),
  cambiarRol: (usuarioId, rol, token) => api.patch(`/admin/usuarios/${usuarioId}/rol`, { rol }, token),
  auditoria: (filtros, token) => api.get(`/admin/auditoria${consulta(filtros)}`, token),
  exportarAuditoria: (filtros, token) => api.descargar(`/admin/auditoria/exportar${consulta(filtros)}`, token),
};
