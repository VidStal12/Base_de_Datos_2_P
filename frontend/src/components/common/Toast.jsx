import { useEffect } from 'react';

// Notificación breve, auto-oculta — usada por CartContext para confirmar
// cuando se completa un "agregar al carrito" que había quedado pendiente de
// iniciar sesión (ver requerirSesion/PENDIENTE_KEY en CartContext.jsx). No es
// un sistema de notificaciones genérico a propósito — un solo caso de uso,
// el estado vive en CartContext, esto solo dibuja lo que le pasen.
export function Toast({ mensaje, onCerrar, duracionMs = 4000 }) {
  useEffect(() => {
    if (!mensaje) return undefined;
    const id = setTimeout(onCerrar, duracionMs);
    return () => clearTimeout(id);
  }, [mensaje, duracionMs, onCerrar]);

  if (!mensaje) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4 sm:justify-end sm:pr-6">
      <div className="pointer-events-auto flex items-center gap-3 rounded-lg bg-neutral-900 px-4 py-3 text-sm font-medium text-white shadow-lg">
        <span className="text-accent-400" aria-hidden="true">
          ✓
        </span>
        <span>{mensaje}</span>
        <button onClick={onCerrar} className="ml-2 text-neutral-400 hover:text-white" aria-label="Cerrar">
          ✕
        </button>
      </div>
    </div>
  );
}
