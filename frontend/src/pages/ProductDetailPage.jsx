import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { productosApi } from '../api/productos';
import { formatCurrency } from '../utils/format';
import { useCart } from '../context/CartContext';
import { Spinner } from '../components/common/Spinner';
import { Button } from '../components/common/Button';
import { Field, Input } from '../components/common/Input';

const TIPO_LABEL = { creacion: 'Creación', edicion: 'Edición' };

// Historial de cambios por eventos (ver ADR-003) — línea de tiempo completa
// más reconstrucción del estado en una fecha arbitraria. Se carga aparte del
// producto (no bloquea el resto de la página) porque es información
// secundaria, no algo que el comprador necesite para decidir la compra.
function HistorialSection({ productoId, vendedorId }) {
  const [eventos, setEventos] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [fecha, setFecha] = useState('');
  const [snapshot, setSnapshot] = useState(null);
  const [errorFecha, setErrorFecha] = useState('');
  const [consultando, setConsultando] = useState(false);

  useEffect(() => {
    setCargando(true);
    productosApi
      .historial(productoId)
      .then(setEventos)
      .catch(() => setEventos([]))
      .finally(() => setCargando(false));
  }, [productoId]);

  async function handleConsultar(e) {
    e.preventDefault();
    if (!fecha) return;
    setConsultando(true);
    setErrorFecha('');
    setSnapshot(null);
    try {
      setSnapshot(await productosApi.historialEnFecha(productoId, fecha));
    } catch (err) {
      setErrorFecha(err.message);
    } finally {
      setConsultando(false);
    }
  }

  if (cargando) return null;
  if (eventos.length === 0) return null;

  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-6">
      <h2 className="mb-4 text-lg font-bold text-neutral-900">Historial de cambios</h2>

      <ul className="flex flex-col gap-4">
        {eventos.map((ev) => (
          <li key={ev._id} className="border-l-2 border-neutral-200 pl-4">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                  ev.tipo === 'creacion' ? 'bg-brand-500/10 text-brand-700' : 'bg-accent-500/10 text-accent-700'
                }`}
              >
                {TIPO_LABEL[ev.tipo] || ev.tipo}
              </span>
              <span className="text-xs text-neutral-500">v{ev.version}</span>
              <span className="text-xs text-neutral-400">
                {new Date(ev.fecha).toLocaleString('es-GT', { dateStyle: 'medium', timeStyle: 'short' })}
              </span>
              <span className="text-xs text-neutral-400">
                · {ev.usuario_id === vendedorId ? 'por el vendedor' : `por otro usuario (#${ev.usuario_id})`}
              </span>
            </div>
            {ev.campos_modificados?.length > 0 && (
              <p className="mt-1 text-xs text-neutral-500">Cambió: {ev.campos_modificados.join(', ')}</p>
            )}
            <p className="mt-1 text-sm text-neutral-700">{ev.snapshot.descripcion}</p>
          </li>
        ))}
      </ul>

      <div className="mt-6 border-t border-neutral-100 pt-4">
        <h3 className="mb-2 text-sm font-semibold text-neutral-800">Ver estado en una fecha</h3>
        <form onSubmit={handleConsultar} className="flex flex-wrap items-end gap-2">
          <Field label="Fecha">
            <Input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} required />
          </Field>
          <Button type="submit" variant="outline" disabled={consultando}>
            {consultando ? 'Consultando...' : 'Consultar'}
          </Button>
        </form>

        {errorFecha && <p className="mt-2 text-sm text-danger-600">{errorFecha}</p>}

        {snapshot && (
          <div className="mt-3 rounded-lg bg-neutral-50 p-3 text-sm">
            <p>
              <span className="font-medium text-neutral-700">Descripción: </span>
              {snapshot.descripcion}
            </p>
            <p>
              <span className="font-medium text-neutral-700">Estado: </span>
              {snapshot.estado}
            </p>
            {snapshot.atributos?.length > 0 && (
              <p>
                <span className="font-medium text-neutral-700">Atributos: </span>
                {snapshot.atributos.map((a) => `${a.nombre}: ${a.valor}`).join(', ')}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function ProductDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { agregar } = useCart();
  const [producto, setProducto] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');
  const [cantidad, setCantidad] = useState(1);
  const [agregado, setAgregado] = useState(false);

  useEffect(() => {
    setCargando(true);
    setAgregado(false);
    setCantidad(1);
    productosApi
      .obtener(id)
      .then(setProducto)
      .catch(() => setError('No encontramos este producto.'))
      .finally(() => setCargando(false));
  }, [id]);

  if (cargando) return <Spinner />;
  if (error || !producto) {
    return <p className="rounded-lg bg-danger-500/10 p-4 text-sm text-danger-600">{error || 'Producto no encontrado.'}</p>;
  }

  const stock = producto.inventario?.cantidad ?? 0;
  const sinStock = stock <= 0;
  const subcategoria = producto.subcategoria;

  function handleAgregar() {
    agregar(producto, cantidad);
    setAgregado(true);
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1.2fr_1fr]">
        <div className="aspect-square overflow-hidden rounded-2xl bg-neutral-100">
          <img
            src={producto.imagen_url || 'https://placehold.co/600x600?text=TiendaYa'}
            alt={producto.descripcion}
            className="size-full object-cover"
          />
        </div>

        <div className="flex flex-col gap-4">
          <div>
            {subcategoria && (
              <Link to={`/?subcategoriaId=${subcategoria.id}`} className="text-sm text-brand-600 hover:underline">
                {subcategoria.subcategoria}
              </Link>
            )}
            <h1 className="mt-1 text-2xl font-bold text-neutral-900">{producto.descripcion}</h1>
            {producto.vendedor_nombre && (
              <p className="mt-1 text-sm text-neutral-500">
                Vendido por <span className="font-medium text-neutral-700">{producto.vendedor_nombre}</span>
              </p>
            )}
          </div>

          <div className="flex items-baseline gap-3 border-y border-neutral-200 py-4">
            <span className="text-3xl font-bold text-neutral-900">{formatCurrency(producto.inventario?.precio)}</span>
            {sinStock ? (
              <span className="text-sm font-semibold text-danger-600">Agotado</span>
            ) : (
              <span className="text-sm font-semibold text-accent-700">{stock} disponibles</span>
            )}
          </div>

          {producto.atributos?.length > 0 && (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              {producto.atributos.map((attr) => (
                <div key={attr.nombre} className="flex justify-between border-b border-neutral-100 pb-1">
                  <dt className="text-neutral-500">{attr.nombre}</dt>
                  <dd className="font-medium text-neutral-800">{attr.valor}</dd>
                </div>
              ))}
            </dl>
          )}

          {!sinStock && (
            <div className="flex items-center gap-3">
              <label htmlFor="cantidad" className="text-sm font-medium text-neutral-700">
                Cantidad
              </label>
              <select
                id="cantidad"
                value={cantidad}
                onChange={(e) => setCantidad(Number(e.target.value))}
                className="rounded-lg border border-neutral-300 px-3 py-2 text-sm"
              >
                {Array.from({ length: Math.min(stock, 10) }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button variant="accent" onClick={handleAgregar} disabled={sinStock} className="flex-1 py-3">
              {sinStock ? 'Sin stock' : agregado ? 'Agregado ✓' : 'Agregar al carrito'}
            </Button>
            <Button
              variant="primary"
              disabled={sinStock}
              onClick={() => {
                agregar(producto, cantidad);
                navigate('/carrito');
              }}
              className="flex-1 py-3"
            >
              Comprar ahora
            </Button>
          </div>
        </div>
      </div>

      <HistorialSection productoId={producto.id} vendedorId={producto.vendedor_id} />
    </div>
  );
}
