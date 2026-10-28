import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useAhora } from '../../hooks/useAhora';
import { formatCurrency } from '../../utils/format';
import { cuentaRegresiva, nivelStock, porcentajeRestante, segundosRestantes, urgencia } from '../../utils/ofertas';
import { IconoReloj } from '../common/iconos';

const COLOR_RELOJ = { normal: 'text-neutral-600', alta: 'text-danger-600', critica: 'text-danger-600 motion-safe:animate-pulse' };
const COLOR_CUPO_TEXTO = { normal: 'text-accent-700', poco: 'text-neutral-800', agotandose: 'text-danger-600' };
const COLOR_CUPO_BARRA = { normal: 'bg-accent-500', poco: 'bg-warning-500', agotandose: 'bg-danger-500' };

// Una oferta flash vigente (ver utils/ofertas.js → normalizarOferta): precio de oferta junto al normal tachado, la
// etiqueta de cuánto se ahorra, cuánto del cupo ya se llevó la gente y cuánto falta para que termine. La cuenta regresiva
// late sola (hooks/useAhora.js); al llegar a cero la tarjeta pasa a «terminada» sin esperar a que la lista se vuelva a
// pedir (hooks/useOfertasFlash.js lo hace justo al vencer). Se usa en el carrusel de la portada y en /ofertas.
export function OfertaCard({ oferta }) {
  const { usuario } = useAuth();
  const ahora = useAhora();
  const segundos = segundosRestantes(oferta.vigenteHasta, ahora);
  const terminada = segundos === 0;
  // Nadie compra lo que él mismo vende: la oferta propia lleva al detalle del producto, no a la pantalla de compra (que
  // el servidor rechazaría con 403). Una oferta terminada tampoco lleva a comprar.
  const esPropia = usuario?.id_usuario != null && usuario.id_usuario === oferta.vendedorId;
  const destino = esPropia || terminada ? `/productos/${oferta.id}` : `/ofertas/${oferta.id}/comprar`;
  const nivel = nivelStock(oferta.restante, oferta.total);
  // La barra es un indicador de cuánto queda (se vacía a medida que se vende) y su color dice qué tan urgente es.
  const quedaPorciento = porcentajeRestante(oferta.restante, oferta.total);
  const textoCupo =
    nivel === 'agotandose'
      ? oferta.restante === 1
        ? '¡Queda 1!'
        : `¡Últimas ${oferta.restante}!`
      : `Quedan ${oferta.restante}${oferta.total > oferta.restante ? ` de ${oferta.total}` : ''}`;

  return (
    <article className={`group flex h-full flex-col overflow-hidden rounded-xl border border-accent-300 bg-white transition-shadow hover:shadow-lg ${terminada ? 'opacity-70' : ''}`}>
      <Link to={destino} tabIndex={-1} aria-hidden="true" className="relative block aspect-square overflow-hidden bg-neutral-100">
        <img
          src={oferta.imagen || 'https://placehold.co/400x400?text=TiendaYa'}
          alt=""
          loading="lazy"
          className="size-full object-cover transition-transform duration-300 group-hover:scale-105"
        />
        {oferta.descuento > 0 && (
          <span className="absolute left-2 top-2 rounded-full bg-accent-600 px-2 py-0.5 text-xs font-bold text-white">−{oferta.descuento} %</span>
        )}
      </Link>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex flex-col gap-0.5">
          <Link to={destino} className="line-clamp-2 text-sm font-medium text-neutral-800 hover:text-brand-700">
            {oferta.descripcion}
          </Link>
          {oferta.vendedor && <p className="truncate text-xs text-neutral-500">{oferta.vendedor}</p>}
        </div>

        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-lg font-bold text-neutral-900">{formatCurrency(oferta.precioOferta)}</span>
          {oferta.descuento > 0 && <span className="text-xs text-neutral-500 line-through">{formatCurrency(oferta.precioNormal)}</span>}
        </div>

        <div>
          <p className={`text-xs font-semibold ${COLOR_CUPO_TEXTO[nivel]}`}>{textoCupo}</p>
          <div aria-hidden="true" className="mt-1 h-1.5 overflow-hidden rounded-full bg-neutral-200">
            <div className={`h-full rounded-full transition-[width] duration-500 ${COLOR_CUPO_BARRA[nivel]}`} style={{ width: `${quedaPorciento}%` }} />
          </div>
        </div>

        <p role="timer" className={`mt-auto flex items-center gap-1 pt-1 text-xs font-semibold ${terminada ? 'text-neutral-500' : COLOR_RELOJ[urgencia(segundos)]}`}>
          <IconoReloj className="size-3.5 shrink-0" />
          <span>
            {terminada ? (
              'Oferta terminada'
            ) : (
              <>
                Termina en <span className="whitespace-nowrap tabular-nums">{cuentaRegresiva(segundos)}</span>
              </>
            )}
          </span>
        </p>

        {esPropia ? (
          <p className="w-full rounded-lg bg-neutral-100 py-2 text-center text-sm font-medium text-neutral-500">Es tu oferta</p>
        ) : terminada ? (
          <p className="w-full rounded-lg bg-neutral-200 py-2 text-center text-sm font-semibold text-neutral-500">Terminó</p>
        ) : (
          <Link to={destino} className="block w-full rounded-lg bg-accent-500 py-2 text-center text-sm font-semibold text-white transition-colors hover:bg-accent-600">
            Comprar oferta
          </Link>
        )}
      </div>
    </article>
  );
}
