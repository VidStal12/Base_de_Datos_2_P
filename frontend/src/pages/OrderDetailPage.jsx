import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { comprasApi } from '../api/cuenta';
import { formatCurrency } from '../utils/format';
import { Spinner } from '../components/common/Spinner';

export function OrderDetailPage() {
  const { id } = useParams();
  const { token } = useAuth();
  const location = useLocation();
  const [pedido, setPedido] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setCargando(true);
    comprasApi
      .obtener(id, token)
      .then(setPedido)
      .catch(() => setError('No encontramos ese pedido.'))
      .finally(() => setCargando(false));
  }, [id, token]);

  if (cargando) return <Spinner />;
  if (error || !pedido) {
    return <p className="rounded-lg bg-danger-500/10 p-4 text-sm text-danger-600">{error}</p>;
  }

  const pago = pedido.pagos?.[0];

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      {location.state?.recienCreado && (
        <div className="rounded-xl bg-accent-500/10 p-4 text-accent-700">
          <p className="font-semibold">¡Gracias por tu compra!</p>
          <p className="text-sm">Tu pedido #{pedido.id} fue confirmado.</p>
        </div>
      )}

      <div className="rounded-xl border border-neutral-200 bg-white p-6">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-100 pb-4">
          <div>
            <h1 className="text-lg font-bold text-neutral-900">Pedido #{pedido.id}</h1>
            <p className="text-sm text-neutral-500">{new Date(pedido.fecha).toLocaleString('es-GT', { dateStyle: 'long', timeStyle: 'short' })}</p>
          </div>
          <span className="rounded-full bg-accent-500/10 px-3 py-1 text-xs font-semibold text-accent-700">
            {pago?.estado || 'procesando'}
          </span>
        </div>

        <ul className="flex flex-col gap-3 py-4">
          {pedido.compra_detalles.map((linea) => (
            <li key={linea.id} className="flex justify-between text-sm">
              <span className="text-neutral-700">
                {linea.producto?.descripcion} × {linea.cantidad}
              </span>
              <span className="font-medium text-neutral-900">{formatCurrency(linea.precio_final)}</span>
            </li>
          ))}
        </ul>

        <div className="flex justify-between border-t border-neutral-100 pt-4 text-lg">
          <span className="text-neutral-600">Total</span>
          <span className="font-bold text-neutral-900">{formatCurrency(pedido.total)}</span>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 border-t border-neutral-100 pt-4 text-sm sm:grid-cols-2">
          <div>
            <h3 className="font-semibold text-neutral-800">Enviado a</h3>
            <p className="text-neutral-600">
              {pedido.direccion?.direccion}, {pedido.direccion?.pais}
            </p>
          </div>
          {pago && (
            <div>
              <h3 className="font-semibold text-neutral-800">Pago</h3>
              <p className="text-neutral-600">Ref. {pago.referencia_transaccion}</p>
            </div>
          )}
          {/* Solo las cuentas que pueden vender aceptan este compromiso al comprar
              (ver utils/compromiso.js); en un pedido de comprador no aparece. */}
          {pedido.no_reventa_aceptada_en && (
            <div className="sm:col-span-2">
              <h3 className="font-semibold text-neutral-800">Compromiso de no reventa</h3>
              <p className="text-neutral-600">
                Aceptado el {new Date(pedido.no_reventa_aceptada_en).toLocaleString('es-GT', { dateStyle: 'long', timeStyle: 'short' })} — revender los
                productos de este pedido incumple los{' '}
                <Link to="/terminos#no-reventa" className="font-medium text-brand-700 hover:underline">
                  Términos de Servicio
                </Link>{' '}
                de TiendaYa.
              </p>
            </div>
          )}
        </div>
      </div>

      <Link to="/pedidos" className="text-sm font-medium text-brand-700 hover:underline">
        ← Volver a mis pedidos
      </Link>
    </div>
  );
}
