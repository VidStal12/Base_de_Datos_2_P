import { createContext, useContext, useEffect, useState } from 'react';
import { authApi } from '../api/auth';

const AuthContext = createContext(null);
const STORAGE_KEY = 'tiendaya_token';

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => localStorage.getItem(STORAGE_KEY));
  const [usuario, setUsuario] = useState(null);
  const [cargando, setCargando] = useState(true);

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
