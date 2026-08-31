import { Link, useNavigate } from 'react-router-dom';
import { useCart } from '../context/CartContext';
import { formatCurrency } from '../utils/format';
import { Button } from '../components/common/Button';

export function CartPage() {
  const { items, actualizarCantidad, quitar, total } = useCart();
  const navigate = useNavigate();

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 py-16 text-center">
        <p className="text-lg text-neutral-600">Tu carrito está vacío.</p>
        <Button as={Link} to="/" variant="primary">
          Ir al catálogo
        </Button>
      </div>
    );
  }

  // Ya no hace falta comprobar sesión acá: /carrito está detrás de
  // <RequireAuth> desde que el carrito requiere login (ver App.jsx,
  // IA/ENTREGA-2-PLAN.md §4.1) — llegar a este componente ya implica sesión
  // iniciada.
  function handleCheckout() {
    navigate('/checkout');
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-bold text-neutral-900">Carrito ({items.length})</h1>
        {items.map(({ producto, cantidad }) => {
          const stock = producto.inventario?.cantidad ?? 0;
          return (
            <div key={producto.id} className="flex gap-4 rounded-xl border border-neutral-200 bg-white p-4">
              <Link to={`/productos/${producto.id}`} className="size-24 shrink-0 overflow-hidden rounded-lg bg-neutral-100">
                <img
                  src={producto.imagen_url || 'https://placehold.co/200x200?text=TiendaYa'}
                  alt={producto.descripcion}
                  className="size-full object-cover"
                />
              </Link>
              <div className="flex flex-1 flex-col justify-between">
                <div>
                  <Link to={`/productos/${producto.id}`} className="font-medium text-neutral-800 hover:text-brand-700">
                    {producto.descripcion}
                  </Link>
                  <p className="text-sm text-neutral-500">{formatCurrency(producto.inventario?.precio)} c/u</p>
                </div>
                <div className="flex items-center gap-3">
                  <select
                    value={cantidad}
                    onChange={(e) => actualizarCantidad(producto.id, Number(e.target.value))}
                    className="rounded-lg border border-neutral-300 px-2 py-1 text-sm"
                  >
                    {Array.from({ length: Math.min(stock, 10) }, (_, i) => i + 1).map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                  <button onClick={() => quitar(producto.id)} className="text-sm text-danger-600 hover:underline">
                    Quitar
                  </button>
                </div>
              </div>
              <span className="shrink-0 font-semibold text-neutral-900">
                {formatCurrency(Number(producto.inventario?.precio ?? 0) * cantidad)}
              </span>
            </div>
          );
        })}
      </div>

      <aside className="h-fit rounded-xl border border-neutral-200 bg-white p-5">
        <div className="flex items-center justify-between text-lg">
          <span className="text-neutral-600">Subtotal</span>
          <span className="font-bold text-neutral-900">{formatCurrency(total)}</span>
        </div>
        <Button variant="accent" onClick={handleCheckout} className="mt-4 w-full py-3">
          Continuar a pagar
        </Button>
      </aside>
    </div>
  );
}
