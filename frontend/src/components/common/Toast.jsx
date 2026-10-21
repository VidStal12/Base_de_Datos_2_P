import { useEffect } from 'react';

// Confirmaciones y errores del carrito, visibles también en catálogo y detalle.
export function Toast({ mensaje, tipo = 'exito', onCerrar, duracionMs = 6000 }) {
  useEffect(() => {
    if (!mensaje) return undefined;
    const id = setTimeout(onCerrar, duracionMs);
    return () => clearTimeout(id);
  }, [mensaje, duracionMs, onCerrar]);

  if (!mensaje) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4 sm:justify-end sm:pr-6">
      <div role={tipo === 'error' ? 'alert' : 'status'} className="pointer-events-auto flex max-w-lg items-center gap-3 rounded-lg bg-neutral-900 px-4 py-3 text-sm font-medium text-white shadow-lg">
        <span className={tipo === 'error' ? 'text-red-400' : 'text-accent-400'} aria-hidden="true">
          {tipo === 'error' ? '!' : '✓'}
        </span>
        <span>{mensaje}</span>
        <button onClick={onCerrar} className="ml-2 text-neutral-400 hover:text-white" aria-label="Cerrar">
          ✕
        </button>
      </div>
    </div>
  );
}
