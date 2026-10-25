// Piezas que comparten los cuatro paneles de /admin/permisos.

const TONOS = {
  neutro: 'bg-neutral-100 text-neutral-600',
  brand: 'bg-brand-50 text-brand-700',
  accent: 'bg-accent-500/10 text-accent-700',
  warning: 'bg-warning-500/10 text-warning-500',
  danger: 'bg-danger-500/10 text-danger-600',
};

export function Chip({ tono = 'neutro', children, title }) {
  return (
    <span title={title} className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${TONOS[tono]}`}>
      {children}
    </span>
  );
}

// Un mensaje dentro de un panel: error (rojo), aviso (ámbar) o nota (neutro).
export function Aviso({ tipo = 'nota', children }) {
  const estilos = {
    error: 'bg-danger-500/10 text-danger-600',
    aviso: 'bg-warning-500/10 text-neutral-800',
    nota: 'bg-neutral-100 text-neutral-700',
  };
  return (
    <p role={tipo === 'error' ? 'alert' : 'note'} className={`rounded-lg p-3 text-sm ${estilos[tipo]}`}>
      {children}
    </p>
  );
}

// El candado de una casilla que no se puede cambiar (un ícono propio: los emojis se dibujan distinto en cada sistema).
export function Candado({ className = 'size-3' }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M5 7V5a3 3 0 1 1 6 0v2h.5A1.5 1.5 0 0 1 13 8.5v5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 13.5v-5A1.5 1.5 0 0 1 4.5 7H5Zm1.5 0h3V5a1.5 1.5 0 1 0-3 0v2Z" />
    </svg>
  );
}

export const CampoTexto = ({ id, etiqueta, children }) => (
  <div className="flex flex-col gap-1">
    <label htmlFor={id} className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
      {etiqueta}
    </label>
    {children}
  </div>
);

