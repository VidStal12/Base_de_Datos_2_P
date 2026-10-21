import { paginasVisibles } from '../../utils/filtrosBusqueda';

const BASE = 'min-w-9 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors';

export function Pagination({ pagina, paginas, onCambiar }) {
  if (paginas <= 1) return null;
  return (
    <nav aria-label="Paginación" className="flex flex-wrap items-center justify-center gap-1.5">
      <button
        type="button"
        onClick={() => onCambiar(pagina - 1)}
        disabled={pagina <= 1}
        className={`${BASE} border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50`}
      >
        ‹ Anterior
      </button>
      {paginasVisibles(pagina, paginas).map((n, i) =>
        n === '…' ? (
          <span key={`puntos-${i}`} aria-hidden="true" className="px-1 text-neutral-400">
            …
          </span>
        ) : (
          <button
            key={n}
            type="button"
            onClick={() => onCambiar(n)}
            aria-current={n === pagina ? 'page' : undefined}
            aria-label={`Página ${n}`}
            className={`${BASE} ${n === pagina ? 'border-brand-600 bg-brand-600 text-white' : 'border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50'}`}
          >
            {n}
          </button>
        )
      )}
      <button
        type="button"
        onClick={() => onCambiar(pagina + 1)}
        disabled={pagina >= paginas}
        className={`${BASE} border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50`}
      >
        Siguiente ›
      </button>
    </nav>
  );
}
