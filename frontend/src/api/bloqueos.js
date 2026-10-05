import { api } from './client';

// Respuesta escalonada al fraude — solo administrador (ver backend/src/services/bloqueoService.js):
// cuentas suspendidas por un hallazgo de confianza alta y cuentas bajo vigilancia (límites
// suaves) por uno «posible».
export const bloqueosApi = {
  listar: (token) => api.get('/admin/bloqueos', token),
  // Corre el barrido ahora, el mismo que corre el servidor cada cierto tiempo.
  evaluar: (token) => api.post('/admin/bloqueos/evaluar', {}, token),
  // El visto bueno: levanta la suspensión (era un falso positivo).
  liberar: (usuarioId, nota, token) => api.post(`/admin/bloqueos/${usuarioId}/liberar`, { nota }, token),
  // Quita los límites suaves de una cuenta bajo vigilancia (era un falso positivo).
  quitarRestriccion: (usuarioId, nota, token) => api.post(`/admin/bloqueos/${usuarioId}/quitar-restriccion`, { nota }, token),
  // Mantiene la suspensión y le suma horas.
  extender: (usuarioId, horas, nota, token) => api.post(`/admin/bloqueos/${usuarioId}/extender`, { horas, nota }, token),
};
