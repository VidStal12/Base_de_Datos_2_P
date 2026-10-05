import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../common/Button';
import { Modal } from '../common/Modal';

// Confirmación con la contraseña para una cuenta bajo revisión (ver utils/restriccion.js):
// el servidor la pide en cada pedido mientras duran los límites suaves, y esta pantalla
// solo la recoge y la devuelve a quien reintenta el pedido — no la guarda ni la valida.
//
// El diálogo se abre porque el servidor rechazó el pedido con REQUIERE_CONTRASENA, y
// SIGUE abierto si la contraseña escrita fue incorrecta (`error` trae el motivo): se
// vacía el campo y el cursor vuelve a él. Cualquier otro rechazo lo cierra quien lo usa.
//
// Mismo criterio que CompromisoNoReventaModal: vive en su propio componente para que, al
// cerrarse, se desmonte y no quede ninguna contraseña escrita en memoria. Y no se
// guarda más tiempo del necesario: se vacía en el instante de enviarla.
function Dialogo({ onConfirmar, onCancelar, procesando, error }) {
  const [contrasena, setContrasena] = useState('');
  const campo = useRef(null);
  const campoId = useId();
  const errorId = useId();

  // Tras un intento fallido (el campo ya se vació al enviar) el cursor vuelve a él. El
  // enfoque inicial al abrir lo pone el armazón (data-enfoque-inicial).
  useEffect(() => {
    if (!procesando) campo.current?.focus();
  }, [procesando]);

  function enviar(evento) {
    evento.preventDefault();
    if (!contrasena || procesando) return;
    onConfirmar(contrasena);
    setContrasena('');
  }

  return (
    <Modal
      titulo="Confirmá con tu contraseña"
      onCancelar={onCancelar}
      bloqueado={procesando}
      descripcion={<p>Tu cuenta está en revisión por actividad inusual. Mientras tanto, cada pedido se confirma con tu contraseña.</p>}
    >
      <form onSubmit={enviar} className="mt-4">
        <label htmlFor={campoId} className="block text-sm font-medium text-neutral-800">
          Contraseña
        </label>
        <input
          id={campoId}
          ref={campo}
          type="password"
          autoComplete="current-password"
          data-enfoque-inicial
          value={contrasena}
          onChange={(evento) => setContrasena(evento.target.value)}
          disabled={procesando}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2.5 text-sm text-neutral-900 outline-none transition-colors focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
        {error && (
          <p id={errorId} role="alert" className="mt-2 text-sm text-danger-600">
            {error}
          </p>
        )}

        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onCancelar} disabled={procesando}>
            Cancelar
          </Button>
          <Button type="submit" variant="accent" disabled={!contrasena || procesando}>
            {procesando ? 'Confirmando...' : 'Confirmar pedido'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function ConfirmarContrasenaModal({ abierto, error = '', onConfirmar, onCancelar, procesando = false }) {
  if (!abierto) return null;
  return <Dialogo error={error} onConfirmar={onConfirmar} onCancelar={onCancelar} procesando={procesando} />;
}
