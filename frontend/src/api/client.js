import { CODIGO_CUENTA_SUSPENDIDA, EVENTO_CUENTA_SUSPENDIDA } from '../utils/suspension';
import { cabecerasDeDispositivo } from '../utils/dispositivo';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';

// Solo al entrar o registrarse viaja el identificador del dispositivo (antifraude, utils/dispositivo.js). Son POST con
// cuerpo, así que ya pagan su pre-vuelo: la cabecera propia no les cuesta nada, y las lecturas no la llevan.
const RUTAS_CON_DISPOSITIVO = new Set(['/auth/login', '/auth/registro']);

async function request(path, { method = 'GET', body, token } = {}) {
  // Una lectura (GET) no lleva cuerpo, así que no declara tipo de contenido: con ese encabezado el navegador pide permiso al
  // servidor (OPTIONS) antes de CADA dirección distinta, y las pantallas que leen muchas (el stock de cada oferta de la
  // portada) pagaban el doble. Sin sesión, un GET es una petición «simple» y viaja directo.
  const headers = method === 'GET' ? {} : { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (RUTAS_CON_DISPOSITIVO.has(path)) Object.assign(headers, cabecerasDeDispositivo());

  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    // El servidor no contestó (apagado, sin red): sin esto, cada pantalla mostraba el
    // «Failed to fetch» crudo del navegador. `status` queda sin definir a propósito:
    // AuthContext distingue «no hay conexión» de «tu sesión no sirve».
    const err = new Error('No se pudo conectar con el servidor. Revisá tu conexión o probá de nuevo en unos instantes.');
    err.codigo = 'SIN_CONEXION';
    throw err;
  }

  if (res.status === 204) return null;

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const err = new Error(data?.error || `Error ${res.status}`);
    err.status = res.status;
    // Código estable que algunos rechazos del servidor traen además del mensaje
    // (p. ej. COMPROMISO_NO_REVENTA, ver utils/compromiso.js): la interfaz
    // reacciona al código, no al texto.
    if (data?.codigo) err.codigo = data.codigo;
    // Con una base apagada el servidor responde 503 SERVICIO_NO_DISPONIBLE y dice cuál
    // (mysql, mongo, redis…): la interfaz puede avisar qué función está limitada.
    if (data?.componente) err.componente = data.componente;
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
  put: (path, body, token) => request(path, { method: 'PUT', body, token }),
  patch: (path, body, token) => request(path, { method: 'PATCH', body, token }),
  delete: (path, token) => request(path, { method: 'DELETE', token }),
  // Un archivo que el servidor entrega con la sesión (el CSV de la auditoría): un enlace normal no manda el token.
  // Devuelve { blob, nombre } para que quien llama lo guarde.
  descargar: async (path, token) => {
    let res;
    try {
      res = await fetch(`${BASE_URL}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    } catch {
      const err = new Error('No se pudo conectar con el servidor. Revisá tu conexión o probá de nuevo en unos instantes.');
      err.codigo = 'SIN_CONEXION';
      throw err;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      const err = new Error(data?.error || `Error ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const nombre = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'descarga.csv';
    return { blob: await res.blob(), nombre };
  },
};
