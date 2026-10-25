import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { Spinner } from './Spinner';

// Como RequireRole, pero por lo que la cuenta PUEDE USAR hoy (las rutas por roles que trae /api/auth/me) y no por el
// nombre de su rol: un rol creado desde /admin/permisos entra a las secciones que se le concedieron. `permiso` es una
// ruta de la lista blanca («GET /api/admin/fraude») o varias (basta una). La API decide de verdad en cada petición.
export function RequirePermiso({ permiso, children }) {
  const { estaAutenticado, cargando, puedeAlguna } = useAuth();
  const location = useLocation();

  if (cargando) return <Spinner />;

  if (!estaAutenticado) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }

  if (!puedeAlguna(Array.isArray(permiso) ? permiso : [permiso])) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <h1 className="text-xl font-bold text-neutral-900">Acceso restringido</h1>
        <p className="mt-2 text-neutral-600">No tenés permiso para ver esta sección.</p>
      </div>
    );
  }

  return children;
}
