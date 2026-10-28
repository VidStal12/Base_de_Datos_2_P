import { Link } from 'react-router-dom';

// Cabecera común de las secciones de la portada: ícono y título, una línea que dice qué es y, a la derecha, lo que cada
// una necesite (una cuenta regresiva, el enlace «Ver todo»). `tono="oscuro"` es para las que van sobre un fondo de color.
export function SeccionWidget({ id, icono, titulo, descripcion, lado, enlace, tono = 'claro', className = '', children }) {
  const oscuro = tono === 'oscuro';
  return (
    <section aria-labelledby={`${id}-titulo`} className={className}>
      <header className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 id={`${id}-titulo`} className={`flex items-center gap-2 text-lg font-bold sm:text-xl ${oscuro ? 'text-white' : 'text-neutral-900'}`}>
            {icono}
            {titulo}
          </h2>
          {descripcion && <p className={`mt-0.5 text-sm ${oscuro ? 'text-accent-50' : 'text-neutral-600'}`}>{descripcion}</p>}
        </div>
        {(lado || enlace) && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {lado}
            {enlace && (
              <Link to={enlace.to} className={`text-sm font-semibold hover:underline ${oscuro ? 'text-white' : 'text-brand-700'}`}>
                {enlace.texto} →
              </Link>
            )}
          </div>
        )}
      </header>
      {children}
    </section>
  );
}
