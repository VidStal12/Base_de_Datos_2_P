import { Link } from 'react-router-dom';
import { formatCurrency } from '../../utils/format';
import { useCart } from '../../context/CartContext';
import { useAuth } from '../../context/AuthContext';

export function ProductCard({ producto }) {
  const { agregar } = useCart();
  const { usuario } = useAuth();
  const stock = producto.inventario?.cantidad ?? 0;
  const sinStock = stock <= 0;
  // Nadie compra lo que él mismo vende (el servidor lo rechaza con 403, ver
  // productoService.verificarNoEsPropio): no se ofrece el botón.
  const esPropio = usuario?.id_usuario != null && usuario.id_usuario === producto.vendedor_id;

  return (
    <div className="group flex flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white transition-shadow hover:shadow-lg">
      <Link to={`/productos/${producto.id}`} className="block aspect-square overflow-hidden bg-neutral-100">
        <img
          src={producto.imagen_url || 'https://placehold.co/400x400?text=TiendaYa'}
          alt={producto.descripcion}
          loading="lazy"
          className="size-full object-cover transition-transform duration-300 group-hover:scale-105"
        />
      </Link>
      <div className="flex flex-1 flex-col gap-2 p-4">
        <Link to={`/productos/${producto.id}`} className="line-clamp-2 text-sm font-medium text-neutral-800 hover:text-brand-700">
          {producto.descripcion}
        </Link>

        <div className="mt-auto flex items-center justify-between">
          <span className="text-lg font-bold text-neutral-900">{formatCurrency(producto.inventario?.precio)}</span>
          {sinStock ? (
            <span className="rounded-full bg-danger-500/10 px-2 py-0.5 text-xs font-semibold text-danger-600">Agotado</span>
          ) : stock <= 5 ? (
            <span className="rounded-full bg-warning-500/10 px-2 py-0.5 text-xs font-semibold text-warning-500">¡Últimas {stock}!</span>
          ) : (
            <span className="rounded-full bg-accent-500/10 px-2 py-0.5 text-xs font-semibold text-accent-700">En stock</span>
          )}
        </div>

        {esPropio ? (
          <p className="mt-1 w-full rounded-lg bg-neutral-100 py-2 text-center text-sm font-medium text-neutral-500">Es tu producto</p>
        ) : (
          <button
            onClick={() => agregar(producto, 1)}
            disabled={sinStock}
            className="mt-1 w-full rounded-lg bg-accent-500 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-600 disabled:cursor-not-allowed disabled:bg-neutral-300"
          >
            {sinStock ? 'Sin stock' : 'Agregar al carrito'}
          </button>
        )}
      </div>
    </div>
  );
}
