import { CODIGO_CUENTA_SUSPENDIDA, EVENTO_CUENTA_SUSPENDIDA } from '../utils/suspension';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';

async function request(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return null;

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const err = new Error(data?.error || `Error ${res.status}`);
    err.status = res.status;
    // Código estable que algunos rechazos del servidor traen además del mensaje
    // (p. ej. COMPROMISO_NO_REVENTA, ver utils/compromiso.js): la interfaz
    // reacciona al código, no al texto.
    if (data?.codigo) err.codigo = data.codigo;
    // Una cuenta con la sesión abierta quedó suspendida: AuthContext cierra la
    // sesión y muestra el aviso. En el login no hace falta: el propio formulario
    // ya muestra el mensaje del error.
    if (data?.codigo === CODIGO_CUENTA_SUSPENDIDA && path !== '/auth/login') {
      window.dispatchEvent(new CustomEvent(EVENTO_CUENTA_SUSPENDIDA, { detail: { mensaje: data.error, hasta: data.hasta ?? null } }));
    }
    throw err;
  }

  return data;
}

export const api = {
  get: (path, token) => request(path, { token }),
  post: (path, body, token) => request(path, { method: 'POST', body, token }),
  patch: (path, body, token) => request(path, { method: 'PATCH', body, token }),
  delete: (path, token) => request(path, { method: 'DELETE', token }),
};
