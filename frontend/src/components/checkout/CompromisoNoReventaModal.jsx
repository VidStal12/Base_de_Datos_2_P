import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../common/Button';

// Aviso que ven las cuentas que pueden vender justo antes de pagar (ver
// utils/compromiso.js). Es un compromiso explícito, no un "Aceptar" suelto: la
// casilla tiene que marcarse a propósito y el pedido guarda la constancia (el
// servidor la exige, esto solo la pide). El texto cita los Términos de Servicio y
// los enlaza (/terminos#no-reventa, ver pages/TerminosPage.jsx) en una pestaña
// nueva: salir de esta pantalla perdería la dirección y el método de pago ya
// elegidos.
//
// El diálogo vive en su propio componente a propósito: al cerrarse se desmonta y
// la casilla vuelve a empezar desmarcada, así que la aceptación es siempre de
// ESTA compra y nunca arrastra la anterior.
function Dialogo({ onAceptar, onCancelar, procesando }) {
  const [acepto, setAcepto] = useState(false);
  const caja = useRef(null);
  const tituloId = useId();
  const textoId = useId();

  // Al abrir, el foco va a la casilla; al cerrar, vuelve al botón que abrió el
  // aviso — el mismo recorrido de teclado que tendría con un diálogo nativo.
  useEffect(() => {
    const anterior = document.activeElement;
    caja.current?.querySelector('input[type="checkbox"]')?.focus();
    return () => anterior?.focus?.();
  }, []);

  function alTeclear(evento) {
    if (evento.key === 'Escape' && !procesando) {
      evento.stopPropagation();
      onCancelar();
      return;
    }
    if (evento.key !== 'Tab') return;
    // El foco no puede escaparse a la página de atrás mientras el aviso está abierto
    // (el enlace a los términos también cuenta: si no, el teclado nunca llegaría a él).
    const enfocables = [...caja.current.querySelectorAll('a[href], button:not([disabled]), input:not([disabled])')];
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

  // El fondo desplaza (overflow-y-auto) y el contenedor interno mide al menos
  // todo el alto: centrado en pantallas altas y, en una ventana baja (un teléfono
  // en horizontal), el diálogo se puede recorrer en vez de quedar cortado.
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-neutral-900/60">
      <div
        className="flex min-h-full items-center justify-center p-4"
        onMouseDown={(evento) => {
          // Un clic en el fondo cancela la compra; nunca acepta nada.
          if (evento.target === evento.currentTarget && !procesando) onCancelar();
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
            Compromiso de no reventa
          </h2>
          <div id={textoId} className="mt-3 space-y-3 text-sm text-neutral-700">
            <p>
              Tu cuenta puede vender en TiendaYa. Al comprar, te comprometés a <strong>no revender</strong> los productos de este pedido.
            </p>
            <p className="rounded-lg bg-warning-500/10 p-3 text-neutral-800">
              Si los revendés, estarás incumpliendo los{' '}
              <a href="/terminos#no-reventa" target="_blank" rel="noopener noreferrer" className="font-semibold text-brand-700 underline hover:text-brand-800">
                Términos de Servicio<span className="sr-only"> (se abre en una pestaña nueva)</span>
              </a>{' '}
              de TiendaYa.
            </p>
          </div>

          <label className="mt-4 flex cursor-pointer items-start gap-3 text-sm text-neutral-800">
            <input type="checkbox" checked={acepto} onChange={(evento) => setAcepto(evento.target.checked)} className="mt-0.5" />
            <span>Entiendo y me comprometo a no revender lo que compro en este pedido.</span>
          </label>

          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={onCancelar} disabled={procesando}>
              Cancelar
            </Button>
            <Button variant="accent" onClick={onAceptar} disabled={!acepto || procesando}>
              {procesando ? 'Confirmando...' : 'Aceptar y comprar'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function CompromisoNoReventaModal({ abierto, onAceptar, onCancelar, procesando = false }) {
  if (!abierto) return null;
  return <Dialogo onAceptar={onAceptar} onCancelar={onCancelar} procesando={procesando} />;
}
