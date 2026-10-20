import { createContext, useContext, useEffect, useState } from 'react';
import { authApi } from '../api/auth';
import { EVENTO_CUENTA_SUSPENDIDA } from '../utils/suspension';

const AuthContext = createContext(null);
const STORAGE_KEY = 'tiendaya_token';
const REINTENTO_PERFIL_MS = 10000;

// El token ya dice quién es y qué rol tiene. Si el perfil completo no se puede leer ahora
// (la base de cuentas está apagada, o no hay red), se arma con eso un perfil mínimo para que la
// sesión siga siendo usable — el rol decide qué secciones ve — en vez de sacar a la persona.
function usuarioDesdeToken(token) {
  try {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const datos = JSON.parse(atob(base64));
    if (!datos.id_usuario) return null;
    return { id_usuario: datos.id_usuario, rol: { tipo_rol: datos.rol }, nombres: '', apellidos: '', perfilIncompleto: true };
  } catch {
    return null;
  }
}

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => localStorage.getItem(STORAGE_KEY));
  const [usuario, setUsuario] = useState(null);
  const [cargando, setCargando] = useState(true);
  // Aviso de una suspensión que le llegó a la persona con la sesión abierta
  // (ver utils/suspension.js); lo muestra components/layout/AvisoSuspension.jsx.
  const [suspension, setSuspension] = useState(null);

  // api/client.js avisa con este evento cuando el servidor responde que la cuenta
  // quedó suspendida: se cierra la sesión (el token ya no sirve) y se guarda el
  // mensaje, en vez de dejar a la persona con pantallas que fallan sin explicación.
  useEffect(() => {
    function alSuspender(evento) {
      localStorage.removeItem(STORAGE_KEY);
      setToken(null);
      setUsuario(null);
      setSuspension(evento.detail);
    }
    window.addEventListener(EVENTO_CUENTA_SUSPENDIDA, alSuspender);
    return () => window.removeEventListener(EVENTO_CUENTA_SUSPENDIDA, alSuspender);
  }, []);

  useEffect(() => {
    if (!token) {
      setUsuario(null);
      setCargando(false);
      return;
    }
    let vigente = true;
    let reintento;
    function cerrarSesion() {
      setToken(null);
      localStorage.removeItem(STORAGE_KEY);
    }
    function cargarPerfil() {
      authApi
        .perfil(token)
        .then((perfil) => {
          if (vigente) setUsuario(perfil);
        })
        .catch((err) => {
          if (!vigente) return;
          // 401/403/404: la sesión no sirve (token vencido, cuenta suspendida o borrada). Un 503
          // o la falta de conexión NO dicen nada de la sesión: antes cualquier error la cerraba,
          // así que apagar la base de cuentas sacaba a todas las personas del sitio.
          if ([401, 403, 404].includes(err.status)) return cerrarSesion();
          const minimo = usuarioDesdeToken(token);
          if (!minimo) return cerrarSesion();
          setUsuario((actual) => actual ?? minimo);
          reintento = setTimeout(cargarPerfil, REINTENTO_PERFIL_MS);
        })
        .finally(() => {
          if (vigente) setCargando(false);
        });
    }
    cargarPerfil();
    return () => {
      vigente = false;
      clearTimeout(reintento);
    };
  }, [token]);

  async function login(correo, contrasena) {
    const { token: nuevoToken } = await authApi.login({ correo, contrasena });
    localStorage.setItem(STORAGE_KEY, nuevoToken);
    setToken(nuevoToken);
    setSuspension(null);
  }

  async function registrar(datos) {
    await authApi.registrar(datos);
    await login(datos.correo, datos.contrasena);
  }

  function logout() {
    localStorage.removeItem(STORAGE_KEY);
    setToken(null);
    setUsuario(null);
  }

  const value = {
    token,
    usuario,
    cargando,
    estaAutenticado: Boolean(token),
    suspension,
    descartarSuspension: () => setSuspension(null),
    login,
    registrar,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth debe usarse dentro de <AuthProvider>');
  return ctx;
}
