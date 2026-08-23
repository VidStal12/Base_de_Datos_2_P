import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { productosApi } from '../api/productos';
import { formatCurrency } from '../utils/format';
import { useCart } from '../context/CartContext';
import { Spinner } from '../components/common/Spinner';
import { Button } from '../components/common/Button';

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
  const subcategoria = producto.categoria_productos?.[0]?.subcategoria;

  function handleAgregar() {
    agregar(producto, cantidad);
    setAgregado(true);
  }

  return (
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
          {producto.vendedor && (
            <p className="mt-1 text-sm text-neutral-500">
              Vendido por <span className="font-medium text-neutral-700">{producto.vendedor.nombres} {producto.vendedor.apellidos}</span>
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

        {producto.atributos_producto?.length > 0 && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            {producto.atributos_producto.map((attr) => (
              <div key={attr.id} className="flex justify-between border-b border-neutral-100 pb-1">
                <dt className="text-neutral-500">{attr.atributo_categoria?.atributo}</dt>
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
  );
}
