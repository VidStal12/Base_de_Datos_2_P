import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { productosApi } from '../api/productos';
import { ofertasApi } from '../api/ofertas';
import { useAuth } from '../context/AuthContext';
import { Spinner } from '../components/common/Spinner';
import { formatCurrency } from '../utils/format';

// Listado de ofertas flash vigentes — distinto de "Recomendado para vos" en
// HomePage.jsx (eso es un análisis de tendencia personalizado; esto es lo
// que un vendedor configuró a mano sobre SU producto, ver
// IA/ENTREGA-2-PLAN.md §4.2). GET /api/productos?soloOfertas=true ya filtra
// por activa + dentro de su ventana de fechas, pero el remanente EN VIVO
// solo vive en Redis (ofertaFlashService.consultarStock) — se pide aparte,
// una vez por producto, después de tener la lista base. Catálogo de este
// tamaño: N+1 llamadas en paralelo no es un problema real.
export function OfertasPage() {
  const { usuario } = useAuth();
  const [ofertas, setOfertas] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setCargando(true);
    setError('');
    productosApi
      .listar({ soloOfertas: true })
      .then(async (productos) => {
        const conStock = await Promise.all(
          productos.map(async (producto) => {
            const stock = await ofertasApi.consultarStock(producto.id).catch(() => ({ activo: false }));
            return { producto, stock };
          })
        );
        // Revalidación en vivo: la lista de Mongo ya filtró por activo +
        // ventana de fechas, pero solo Redis sabe si de verdad queda stock
        // ahora mismo — mismas dos guardas que ya rigen la compra (ver
        // ofertaFlashService.js). Una oferta recién agotada desaparece de
        // acá en vez de quedar mostrada sin nada que ofrecer.
        setOfertas(conStock.filter(({ stock }) => stock.activo && stock.restante > 0));
      })
      .catch(() => setError('No se pudieron cargar las ofertas. ¿Está corriendo el backend?'))
      .finally(() => setCargando(false));
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <section className="overflow-hidden rounded-2xl bg-gradient-to-r from-accent-600 to-accent-500 px-8 py-10 text-white">
        <h1 className="text-2xl font-bold sm:text-3xl">Ofertas flash</h1>
        <p className="mt-2 max-w-xl text-accent-50">
          Cupos limitados a precio rebajado, configurados por cada vendedor sobre su propio producto — se acaban.
        </p>
      </section>

      {cargando && <Spinner />}
      {error && <p className="rounded-lg bg-danger-500/10 p-4 text-sm text-danger-600">{error}</p>}

      {!cargando && !error && ofertas.length === 0 && (
        <p className="rounded-lg border border-dashed border-neutral-300 p-8 text-center text-neutral-500">
          No hay ofertas flash activas en este momento.
        </p>
      )}

      {!cargando && !error && ofertas.length > 0 && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {ofertas.map(({ producto, stock }) => {
            // Nadie compra lo que él mismo vende: la oferta propia lleva al
            // detalle del producto, no a la pantalla de compra (que el servidor
            // rechazaría con 403).
            const esPropia = usuario?.id_usuario != null && usuario.id_usuario === producto.vendedor_id;
            return (
            <Link
              key={producto.id}
              to={esPropia ? `/productos/${producto.id}` : `/ofertas/${producto.id}/comprar`}
              className="group flex flex-col overflow-hidden rounded-xl border border-accent-300 bg-white transition-shadow hover:shadow-lg"
            >
              <div className="relative aspect-square overflow-hidden bg-neutral-100">
                <img
                  src={producto.imagen_url || 'https://placehold.co/400x400?text=TiendaYa'}
                  alt={producto.descripcion}
                  loading="lazy"
                  className="size-full object-cover transition-transform duration-300 group-hover:scale-105"
                />
                <span className="absolute left-2 top-2 rounded-full bg-accent-600 px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-white">
                  Oferta flash
                </span>
              </div>
              <div className="flex flex-1 flex-col gap-1 p-3">
                <p className="line-clamp-2 text-sm font-medium text-neutral-800">{producto.descripcion}</p>
                <p className="text-xs text-neutral-500">{producto.vendedor_nombre}</p>
                <div className="mt-auto flex items-baseline gap-2">
                  <span className="font-bold text-neutral-900">{formatCurrency(stock.precio_oferta)}</span>
                  <span className="text-xs text-neutral-500 line-through">{formatCurrency(producto.inventario?.precio)}</span>
                </div>
                <p className="text-xs font-semibold text-accent-700">
                  Quedan {stock.restante}
                  {esPropia && <span className="ml-1 font-medium text-neutral-500">· Tu oferta</span>}
                </p>
              </div>
            </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
