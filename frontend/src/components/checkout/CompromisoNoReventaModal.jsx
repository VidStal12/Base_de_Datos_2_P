import { useState } from 'react';
import { Button } from '../common/Button';
import { Modal } from '../common/Modal';

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
// ESTA compra y nunca arrastra la anterior. El armazón (foco, Escape, fondo) es
// el de components/common/Modal.jsx.
function Dialogo({ onAceptar, onCancelar, procesando }) {
  const [acepto, setAcepto] = useState(false);

  return (
    <Modal
      titulo="Compromiso de no reventa"
      onCancelar={onCancelar}
      bloqueado={procesando}
      descripcion={
        <>
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
        </>
      }
    >
      <label className="mt-4 flex cursor-pointer items-start gap-3 text-sm text-neutral-800">
        <input type="checkbox" data-enfoque-inicial checked={acepto} onChange={(evento) => setAcepto(evento.target.checked)} className="mt-0.5" />
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
    </Modal>
  );
}

export function CompromisoNoReventaModal({ abierto, onAceptar, onCancelar, procesando = false }) {
  if (!abierto) return null;
  return <Dialogo onAceptar={onAceptar} onCancelar={onCancelar} procesando={procesando} />;
}
