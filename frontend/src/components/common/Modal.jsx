import { useEffect, useId, useRef } from 'react';

// Armazón de los diálogos modales del pedido (CompromisoNoReventaModal,
// ConfirmarContrasenaModal): lo que tienen en común está acá para que los dos se
// comporten igual con el teclado y con un lector de pantalla.
//
//   - Al abrir, el foco va al elemento marcado con `data-enfoque-inicial` (o, si no
//     hay, al primer elemento enfocable); al cerrar, vuelve al botón que lo abrió — el
//     mismo recorrido que tendría con un diálogo nativo.
//   - Escape y un clic en el fondo cancelan, salvo con `bloqueado` (mientras se
//     procesa un pedido no se puede cerrar a medias). Nunca aceptan nada.
//   - Tab no se escapa a la página de atrás mientras el diálogo está abierto (un
//     enlace dentro del diálogo también cuenta: si no, el teclado nunca llegaría a él).
//
// Se renderiza SOLO mientras está abierto — quien lo usa devuelve null si no lo está —,
// así que al cerrarse se desmonta y todo su estado interno (una casilla marcada, una
// contraseña escrita) se descarta: lo de una compra nunca arrastra a la siguiente.
const ENFOCABLES = 'a[href], button:not([disabled]), input:not([disabled])';

export function Modal({ titulo, descripcion, onCancelar, bloqueado = false, children }) {
  const caja = useRef(null);
  const tituloId = useId();
  const textoId = useId();

  useEffect(() => {
    const anterior = document.activeElement;
    (caja.current?.querySelector('[data-enfoque-inicial]') ?? caja.current?.querySelector(ENFOCABLES))?.focus();
    return () => anterior?.focus?.();
  }, []);

  function alTeclear(evento) {
    if (evento.key === 'Escape' && !bloqueado) {
      evento.stopPropagation();
      onCancelar();
      return;
    }
    if (evento.key !== 'Tab') return;
    const enfocables = [...caja.current.querySelectorAll(ENFOCABLES)];
    if (enfocables.length === 0) return;
    const primero = enfocables[0];
    const ultimo = enfocables[enfocables.length - 1];
    if (evento.shiftKey && document.activeElement === primero) {
      evento.preventDefault();
      ultimo.focus();
    } else if (!evento.shiftKey && document.activeElement === ultimo) {
      evento.preventDefault();
      primero.focus();
    }
  }

  // El fondo desplaza (overflow-y-auto) y el contenedor interno mide al menos todo el
  // alto: centrado en pantallas altas y, en una ventana baja (un teléfono en
  // horizontal), el diálogo se puede recorrer en vez de quedar cortado.
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-neutral-900/60">
      <div
        className="flex min-h-full items-center justify-center p-4"
        onMouseDown={(evento) => {
          if (evento.target === evento.currentTarget && !bloqueado) onCancelar();
        }}
      >
        <div
          ref={caja}
          role="dialog"
          aria-modal="true"
          aria-labelledby={tituloId}
          aria-describedby={textoId}
          onKeyDown={alTeclear}
          className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl"
        >
          <h2 id={tituloId} className="text-lg font-bold text-neutral-900">
            {titulo}
          </h2>
          <div id={textoId} className="mt-3 space-y-3 text-sm text-neutral-700">
            {descripcion}
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
