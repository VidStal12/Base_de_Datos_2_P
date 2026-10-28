import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Carrusel } from '../common/Carrusel';
import { IconoRayo, IconoReloj } from '../common/iconos';
import { OfertaCard } from '../product/OfertaCard';
import { SeccionWidget } from './SeccionWidget';
import { useAhora } from '../../hooks/useAhora';
import { useOfertasFlash } from '../../hooks/useOfertasFlash';
import { cuentaRegresiva, ordenarOfertas, resumenOfertas } from '../../utils/ofertas';

// «La primera termina en 03:14:09»: lo que se lee de un vistazo en el encabezado, con su propio latido (solo este texto
// se redibuja cada segundo, no el carrusel).
function TerminaPrimero({ ofertas }) {
  const ahora = useAhora();
  const { cantidad, terminaPrimero } = resumenOfertas(ofertas, ahora);
  if (cantidad === 0) return null;
  return (
    <p role="timer" className="flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-sm font-semibold text-white">
      <IconoReloj className="size-4 shrink-0" />
      <span>
        {cantidad > 1 ? 'La primera termina en' : 'Termina en'} <span className="whitespace-nowrap tabular-nums">{cuentaRegresiva(terminaPrimero)}</span>
      </span>
    </p>
  );
}

// El aviso corto cuando no hay nada que mostrar (o no se pudo leer): la sección sigue estando en la portada, solo que más
// baja, y dice por qué está vacía.
function OfertasAviso({ error, onReintentar }) {
  return (
    <section aria-labelledby="ofertas-flash-titulo" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-dashed border-accent-300 bg-accent-50/50 p-4 sm:p-5">
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent-100 text-accent-700">
          <IconoRayo className="size-5" />
        </span>
        <div className="min-w-0">
          <h2 id="ofertas-flash-titulo" className="text-base font-bold text-neutral-900">
            Ofertas flash
          </h2>
          <p className="text-sm text-neutral-600">
            {error || 'Ahora no hay ofertas activas. Las nuevas aparecen acá apenas un vendedor las publica.'}
          </p>
        </div>
      </div>
      {error ? (
        <button type="button" onClick={onReintentar} className="text-sm font-semibold text-brand-700 hover:underline">
          Reintentar
        </button>
      ) : (
        <Link to="/ofertas" className="text-sm font-semibold text-brand-700 hover:underline">
          Ir a la sección de ofertas →
        </Link>
      )}
    </section>
  );
}

// Ofertas flash en la portada: un carrusel con lo que termina primero adelante, que se mantiene solo (hooks/useOfertasFlash.js)
// y avanza sin que nadie lo toque (se detiene al usarlo). La sección completa, con orden y todo el listado, sigue en /ofertas.
export function OfertasFlashWidget() {
  const { ofertas, cargando, error, actualizar } = useOfertasFlash({ limite: 12 });
  const ordenadas = useMemo(() => ordenarOfertas(ofertas, 'terminaPronto'), [ofertas]);
  const cargandoPorPrimeraVez = cargando && ofertas.length === 0;

  if (!cargandoPorPrimeraVez && ofertas.length === 0) return <OfertasAviso error={error} onReintentar={actualizar} />;

  return (
    <SeccionWidget
      id="ofertas-flash"
      tono="oscuro"
      icono={<IconoRayo className="size-5 text-accent-200" />}
      titulo="Ofertas flash"
      descripcion="Cupos limitados a precio rebajado: se acaban."
      lado={cargandoPorPrimeraVez ? null : <TerminaPrimero ofertas={ordenadas} />}
      enlace={{ to: '/ofertas', texto: 'Ver todas' }}
      className="rounded-2xl bg-gradient-to-br from-accent-800 via-accent-700 to-accent-600 p-4 sm:p-6"
    >
      <Carrusel etiqueta="Ofertas flash" tono="oscuro" cargando={cargandoPorPrimeraVez} autoplayMs={6000}>
        {ordenadas.map((oferta) => (
          <OfertaCard key={oferta.id} oferta={oferta} />
        ))}
      </Carrusel>
    </SeccionWidget>
  );
}
