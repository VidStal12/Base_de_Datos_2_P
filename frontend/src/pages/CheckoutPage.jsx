import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useCart } from '../context/CartContext';
import { direccionesApi, metodosPagoApi, checkoutApi } from '../api/cuenta';
import { formatCurrency } from '../utils/format';
import { Field, Input } from '../components/common/Input';
import { Button } from '../components/common/Button';
import { Spinner } from '../components/common/Spinner';

function NuevaDireccionForm({ onCrear, onCancelar }) {
  const [form, setForm] = useState({ pais: '', direccion: '', codigo_postal: '' });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onCrear(form);
      }}
      className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-neutral-50 p-4"
    >
      <Field label="País">
        <Input required value={form.pais} onChange={(e) => setForm({ ...form, pais: e.target.value })} />
      </Field>
      <Field label="Dirección">
        <Input required value={form.direccion} onChange={(e) => setForm({ ...form, direccion: e.target.value })} />
      </Field>
      <Field label="Código postal">
        <Input required value={form.codigo_postal} onChange={(e) => setForm({ ...form, codigo_postal: e.target.value })} />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" className="flex-1">
          Guardar dirección
        </Button>
        <Button type="button" variant="outline" onClick={onCancelar}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

function NuevoMetodoPagoForm({ onCrear, onCancelar }) {
  const [form, setForm] = useState({ titular: '', ultimos_4_digitos: '', marca: 'Visa' });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        // No se captura ni procesa un número de tarjeta real: eso lo hace la
        // pasarela de pago (ver ADR-001 / ERD, observación 1.4.2). Acá solo se
        // simula el token que esa pasarela devolvería.
        onCrear({ ...form, token_pasarela: `tok_demo_${crypto.randomUUID()}` });
      }}
      className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-neutral-50 p-4"
    >
      <p className="text-xs text-neutral-500">
        Modo de prueba — no se procesa un pago real ni se guarda un número de tarjeta.
      </p>
      <Field label="Nombre del titular">
        <Input required value={form.titular} onChange={(e) => setForm({ ...form, titular: e.target.value })} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Últimos 4 dígitos">
          <Input
            required
            pattern="\d{4}"
            maxLength={4}
            value={form.ultimos_4_digitos}
            onChange={(e) => setForm({ ...form, ultimos_4_digitos: e.target.value })}
          />
        </Field>
        <Field label="Marca">
          <select
            value={form.marca}
            onChange={(e) => setForm({ ...form, marca: e.target.value })}
            className="rounded-lg border border-neutral-300 px-3 py-2.5 text-sm"
          >
            <option>Visa</option>
            <option>Mastercard</option>
            <option>American Express</option>
          </select>
        </Field>
      </div>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" className="flex-1">
          Guardar tarjeta
        </Button>
        <Button type="button" variant="outline" onClick={onCancelar}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

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
