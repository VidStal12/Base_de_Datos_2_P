import { useAuth } from '../../context/AuthContext';

// Aviso que queda cuando una cuenta con la sesión abierta fue suspendida (ver
// utils/suspension.js): la sesión ya se cerró, y esto le dice por qué en vez de
// dejarla frente a un sitio que de pronto "la sacó". El texto lo escribe el
// servidor (con la hora en que se levanta) y no revela qué lo causó.
export function AvisoSuspension() {
  const { suspension, descartarSuspension } = useAuth();
  if (!suspension) return null;

  return (
    <div role="alert" className="border-b border-danger-500/30 bg-danger-500/10">
      <div className="mx-auto flex max-w-7xl items-start justify-between gap-4 px-4 py-3 text-sm text-danger-600">
        <p>
          <strong>Se cerró tu sesión.</strong> {suspension.mensaje}
        </p>
        <button
          type="button"
          onClick={descartarSuspension}
          aria-label="Cerrar el aviso"
          className="shrink-0 rounded px-2 text-lg leading-none text-danger-600 hover:bg-danger-500/10"
        >
          ×
        </button>
      </div>
    </div>
  );
}
