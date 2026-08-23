import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { Spinner } from './Spinner';

export function RequireRole({ roles, children }) {
  const { usuario, estaAutenticado, cargando } = useAuth();
  const location = useLocation();

  if (cargando) return <Spinner />;

  if (!estaAutenticado) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }

  if (!roles.includes(usuario?.rol?.tipo_rol)) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <h1 className="text-xl font-bold text-neutral-900">Acceso restringido</h1>
        <p className="mt-2 text-neutral-600">No tenés permiso para ver esta sección.</p>
      </div>
    );
  }

  return children;
}
