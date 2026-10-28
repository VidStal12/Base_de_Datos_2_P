import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { OfertaCard } from '../components/product/OfertaCard';
import { TarjetaEsqueleto } from '../components/common/Esqueleto';
import { IconoRayo, IconoRefrescar, IconoReloj } from '../components/common/iconos';
import { useAhora } from '../hooks/useAhora';
import { useOfertasFlash } from '../hooks/useOfertasFlash';
import { ORDENES_OFERTA, cuentaRegresiva, ordenarOfertas, resumenOfertas } from '../utils/ofertas';

const GRILLA = 'grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5';

// Lo que cambia solo mientras se mira la página: cuántas ofertas siguen vivas, cuánto falta para que termine la primera y
// hace cuánto se leyeron del servidor. Va aparte para que el reloj redibuje solo estas líneas.
function ResumenEnVivo({ ofertas, actualizadoEn }) {
  const ahora = useAhora();
  const { cantidad, terminaPrimero } = resumenOfertas(ofertas, ahora);
  const hace = actualizadoEn > 0 ? Math.max(0, Math.round((ahora - actualizadoEn) / 1000)) : null;
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
      <span className="rounded-full bg-white/15 px-3 py-1 font-semibold">{cantidad === 1 ? '1 oferta activa' : `${cantidad} ofertas activas`}</span>
      {cantidad > 0 && (
        <span role="timer" className="flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 font-semibold">
          <IconoReloj className="size-4 shrink-0" />
          <span>
            {cantidad > 1 ? 'La primera termina en' : 'Termina en'} <span className="whitespace-nowrap tabular-nums">{cuentaRegresiva(terminaPrimero)}</span>
          </span>
        </span>
      )}
      {hace !== null && <span className="text-accent-50">Actualizado hace {hace} s · se actualiza sola</span>}
    </div>
  );
}

// Todas las ofertas flash vigentes — distinto de "Recomendado para vos" en la portada (eso es un análisis de tendencia
// personalizado; esto es lo que un vendedor configuró a mano sobre SU producto, ver IA/ENTREGA-2-PLAN.md §4.2). La lectura
// (lista + remanente EN VIVO de cada una) y su actualización automática están en hooks/useOfertasFlash.js; la portada
// muestra las primeras en un carrusel (components/home/OfertasFlashWidget.jsx) y trae acá con «Ver todas».
export function OfertasPage() {
  const { ofertas, cargando, error, actualizar, actualizadoEn } = useOfertasFlash({ limite: 60 });
  const [orden, setOrden] = useState('terminaPronto');
  const ordenadas = useMemo(() => ordenarOfertas(ofertas, orden), [ofertas, orden]);
  const cargandoPorPrimeraVez = cargando && ofertas.length === 0;

  return (
    <div className="flex flex-col gap-6">
      <section className="overflow-hidden rounded-2xl bg-gradient-to-r from-accent-600 to-accent-500 px-6 py-8 text-white sm:px-8 sm:py-10">
        <h1 className="flex items-center gap-2 text-2xl font-bold sm:text-3xl">
          <IconoRayo className="size-6 sm:size-7" />
          Ofertas flash
        </h1>
        <p className="mt-2 max-w-xl text-accent-50">
          Cupos limitados a precio rebajado, configurados por cada vendedor sobre su propio producto — se acaban.
        </p>
        {ofertas.length > 0 && <ResumenEnVivo ofertas={ofertas} actualizadoEn={actualizadoEn} />}
      </section>

      {error && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-danger-500/10 p-4 text-sm text-danger-600">
          <span>{error}</span>
          <button type="button" onClick={actualizar} className="font-semibold underline">
            Reintentar
          </button>
        </div>
      )}

      {cargandoPorPrimeraVez && (
        <div aria-busy="true" className={GRILLA}>
          {Array.from({ length: 10 }, (_, i) => (
            <TarjetaEsqueleto key={i} />
          ))}
        </div>
      )}

      {!cargando && !error && ofertas.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-neutral-300 p-8 text-center text-neutral-500">
          <p>No hay ofertas flash activas en este momento.</p>
          <p className="text-sm">Cuando un vendedor publique una aparece acá sola, sin recargar la página.</p>
          <Link to="/" className="text-sm font-semibold text-brand-700 hover:underline">
            Seguir mirando el catálogo →
          </Link>
        </div>
      )}

      {ofertas.length > 0 && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-neutral-200 bg-white p-3">
            <p className="text-sm text-neutral-600">Ordená por lo que más te importe: lo que termina antes, el mayor ahorro o lo que se está agotando.</p>
            <div className="flex items-center gap-2">
              <label htmlFor="orden-ofertas" className="text-xs font-semibold text-neutral-600">
                Ordenar
              </label>
              <select
                id="orden-ofertas"
                value={orden}
                onChange={(e) => setOrden(e.target.value)}
                className="rounded-lg border border-neutral-300 px-2 py-1.5 text-sm"
              >
                {ORDENES_OFERTA.map(({ valor, texto }) => (
                  <option key={valor} value={valor}>
                    {texto}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={actualizar}
                className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-300 px-2.5 py-1.5 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50"
              >
                <IconoRefrescar className={`size-4 ${cargando ? 'motion-safe:animate-spin' : ''}`} />
                Actualizar
              </button>
            </div>
          </div>
          <div className={GRILLA}>
            {ordenadas.map((oferta) => (
              <OfertaCard key={oferta.id} oferta={oferta} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
