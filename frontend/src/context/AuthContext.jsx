import { createContext, useContext, useEffect, useState } from 'react';
import { authApi } from '../api/auth';
import { EVENTO_CUENTA_SUSPENDIDA } from '../utils/suspension';

const AuthContext = createContext(null);
const STORAGE_KEY = 'tiendaya_token';

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
    authApi
      .perfil(token)
      .then(setUsuario)
      .catch(() => {
        setToken(null);
        localStorage.removeItem(STORAGE_KEY);
      })
      .finally(() => setCargando(false));
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
