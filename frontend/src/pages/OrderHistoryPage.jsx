import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { comprasApi } from '../api/cuenta';
import { formatCurrency } from '../utils/format';
import { Spinner } from '../components/common/Spinner';

export function OrderHistoryPage() {
  const { token } = useAuth();
  const [pedidos, setPedidos] = useState([]);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    comprasApi.listar(token).then(setPedidos).finally(() => setCargando(false));
  }, [token]);

  if (cargando) return <Spinner />;

  if (pedidos.length === 0) {
    return (
      <div className="py-16 text-center text-neutral-600">
        <p>Todavía no hiciste ningún pedido.</p>
        <Link to="/" className="mt-2 inline-block text-brand-700 hover:underline">
          Ir al catálogo
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-bold text-neutral-900">Mis pedidos</h1>
      {pedidos.map((pedido) => (
        <Link
          key={pedido.id}
          to={`/pedidos/${pedido.id}`}
          className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-neutral-200 bg-white p-4 hover:border-brand-300 hover:shadow-sm"
        >
          <div>
            <p className="font-medium text-neutral-800">Pedido #{pedido.id}</p>
            <p className="text-sm text-neutral-500">{new Date(pedido.fecha).toLocaleDateString('es-GT', { dateStyle: 'long' })}</p>
          </div>
          <div className="flex items-center gap-4">
            <span className="rounded-full bg-accent-500/10 px-3 py-1 text-xs font-semibold text-accent-700">
              {pedido.pagos?.[0]?.estado || 'procesando'}
            </span>
            <span className="font-bold text-neutral-900">{formatCurrency(pedido.total)}</span>
          </div>
        </Link>
      ))}
    </div>
  );
}
