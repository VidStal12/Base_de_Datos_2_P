import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { Spinner } from './Spinner';

export function RequireAuth({ children }) {
  const { estaAutenticado, cargando } = useAuth();
  const location = useLocation();

  if (cargando) return <Spinner />;

  if (!estaAutenticado) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }

  return children;
}
