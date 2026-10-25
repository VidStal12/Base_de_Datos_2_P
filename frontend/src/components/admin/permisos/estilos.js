// Lo que comparten los paneles de /admin/permisos y no es un componente (para que las piezas se puedan recargar en caliente).

export const formatoFechaHora = (iso) => new Date(iso).toLocaleString('es-GT', { dateStyle: 'medium', timeStyle: 'short' });

export const ENTRADA = 'rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder-neutral-400 focus:outline-2 focus:outline-accent-500';
