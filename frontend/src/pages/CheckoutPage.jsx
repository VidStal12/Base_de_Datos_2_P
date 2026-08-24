import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useCart } from '../context/CartContext';
import { direccionesApi, metodosPagoApi, checkoutApi } from '../api/cuenta';
import { formatCurrency } from '../utils/format';
import { Button } from '../components/common/Button';
import { Spinner } from '../components/common/Spinner';
import { NuevaDireccionForm } from '../components/account/NuevaDireccionForm';
import { NuevoMetodoPagoForm } from '../components/account/NuevoMetodoPagoForm';

export function CheckoutPage() {
  const { token } = useAuth();
  const { items, total, vaciar } = useCart();
  const navigate = useNavigate();

  const [direcciones, setDirecciones] = useState([]);
  const [metodosPago, setMetodosPago] = useState([]);
  const [direccionId, setDireccionId] = useState(null);
  const [metodoPagoId, setMetodoPagoId] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [mostrarFormDireccion, setMostrarFormDireccion] = useState(false);
  const [mostrarFormPago, setMostrarFormPago] = useState(false);
  const [error, setError] = useState('');
  const [confirmando, setConfirmando] = useState(false);

  useEffect(() => {
    Promise.all([direccionesApi.listar(token), metodosPagoApi.listar(token)])
      .then(([dirs, metodos]) => {
        setDirecciones(dirs);
        setMetodosPago(metodos);
        if (dirs.length) setDireccionId(dirs[0].id);
        if (metodos.length) setMetodoPagoId(metodos[0].id);
        setMostrarFormDireccion(dirs.length === 0);
        setMostrarFormPago(metodos.length === 0);
      })
      .finally(() => setCargando(false));
  }, [token]);

  async function crearDireccion(datos) {
    const nueva = await direccionesApi.crear(datos, token);
    setDirecciones((prev) => [...prev, nueva]);
    setDireccionId(nueva.id);
    setMostrarFormDireccion(false);
  }

  async function crearMetodoPago(datos) {
    const nuevo = await metodosPagoApi.crear(datos, token);
    setMetodosPago((prev) => [...prev, nuevo]);
    setMetodoPagoId(nuevo.id);
    setMostrarFormPago(false);
  }

  async function confirmarPedido() {
    setError('');
    setConfirmando(true);
    try {
      const { compra } = await checkoutApi.confirmar(
        {
          direccionId,
          metodoPagoId,
          items: items.map(({ producto, cantidad }) => ({ productoId: producto.id, cantidad })),
        },
        token
      );
      vaciar();
      navigate(`/pedidos/${compra.id}`, { state: { recienCreado: true } });
    } catch (err) {
      setError(err.message);
    } finally {
      setConfirmando(false);
    }
  }

  if (items.length === 0) {
    return <p className="py-16 text-center text-neutral-600">Tu carrito está vacío.</p>;
  }
  if (cargando) return <Spinner />;

  const listoParaConfirmar = direccionId && metodoPagoId && !confirmando;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
      <div className="flex flex-col gap-6">
        <section>
          <h2 className="mb-3 text-lg font-bold text-neutral-900">1. Dirección de envío</h2>
          <div className="flex flex-col gap-2">
            {direcciones.map((dir) => (
              <label
                key={dir.id}
                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm ${
                  direccionId === dir.id ? 'border-brand-500 bg-brand-50' : 'border-neutral-200'
                }`}
              >
                <input type="radio" checked={direccionId === dir.id} onChange={() => setDireccionId(dir.id)} className="mt-1" />
                <span>
                  {dir.direccion}, {dir.pais} — {dir.codigo_postal}
                </span>
              </label>
            ))}
          </div>
          {mostrarFormDireccion ? (
            <div className="mt-3">
              <NuevaDireccionForm onCrear={crearDireccion} onCancelar={() => setMostrarFormDireccion(false)} />
            </div>
          ) : (
            <button onClick={() => setMostrarFormDireccion(true)} className="mt-2 text-sm font-medium text-brand-700 hover:underline">
              + Agregar otra dirección
            </button>
          )}
        </section>

        <section>
          <h2 className="mb-3 text-lg font-bold text-neutral-900">2. Método de pago</h2>
          <div className="flex flex-col gap-2">
            {metodosPago.map((mp) => (
              <label
                key={mp.id}
                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm ${
                  metodoPagoId === mp.id ? 'border-brand-500 bg-brand-50' : 'border-neutral-200'
                }`}
              >
                <input type="radio" checked={metodoPagoId === mp.id} onChange={() => setMetodoPagoId(mp.id)} className="mt-1" />
                <span>
                  {mp.marca} terminada en {mp.ultimos_4_digitos} — {mp.titular}
                </span>
              </label>
            ))}
          </div>
          {mostrarFormPago ? (
            <div className="mt-3">
              <NuevoMetodoPagoForm onCrear={crearMetodoPago} onCancelar={() => setMostrarFormPago(false)} />
            </div>
          ) : (
            <button onClick={() => setMostrarFormPago(true)} className="mt-2 text-sm font-medium text-brand-700 hover:underline">
              + Agregar otro método de pago
            </button>
          )}
        </section>
      </div>

      <aside className="h-fit rounded-xl border border-neutral-200 bg-white p-5">
        <h2 className="mb-3 font-bold text-neutral-900">Resumen del pedido</h2>
        <ul className="flex flex-col gap-2 text-sm text-neutral-600">
          {items.map(({ producto, cantidad }) => (
            <li key={producto.id} className="flex justify-between">
              <span className="line-clamp-1">
                {producto.descripcion} × {cantidad}
              </span>
              <span>{formatCurrency(Number(producto.inventario?.precio ?? 0) * cantidad)}</span>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex items-center justify-between border-t border-neutral-200 pt-3 text-lg">
          <span className="text-neutral-600">Total</span>
          <span className="font-bold text-neutral-900">{formatCurrency(total)}</span>
        </div>

        {error && <p className="mt-3 text-sm text-danger-600">{error}</p>}

        <Button
          variant="accent"
          disabled={!listoParaConfirmar}
          onClick={confirmarPedido}
          className="mt-4 w-full py-3"
        >
          {confirmando ? 'Confirmando...' : 'Confirmar pedido'}
        </Button>
      </aside>
    </div>
  );
}
