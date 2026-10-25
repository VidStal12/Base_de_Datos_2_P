import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { productosApi } from '../api/productos';
import { ofertasApi } from '../api/ofertas';
import { formatCurrency } from '../utils/format';
import { useAuth } from '../context/AuthContext';
import { useCart } from '../context/CartContext';
import { Spinner } from '../components/common/Spinner';
import { Button } from '../components/common/Button';
import { HistorialSection } from '../components/product/HistorialSection';
import { ResenasSection } from '../components/product/ResenasSection';
import { ProductosRelacionados } from '../components/product/ProductosRelacionados';
import { StarRating } from '../components/common/StarRating';

const ROLES_VEN_HISTORIAL = ['vendedor', 'administrador'];

export function ProductDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { usuario, token, estaAutenticado } = useAuth();
  const { agregar } = useCart();
  const [producto, setProducto] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');
  const [cantidad, setCantidad] = useState(1);
  const [agregado, setAgregado] = useState(false);
  const [ofertaStock, setOfertaStock] = useState(null);

  useEffect(() => {
    setCargando(true);
    setAgregado(false);
    setCantidad(1);
    setOfertaStock(null);
    // Con el token, un administrador puede abrir también el producto de un vendedor
    // suspendido (para el resto de la gente no existe mientras dure la suspensión).
    productosApi
      .obtener(id, token)
      .then((p) => {
        setProducto(p);
        // Aparte, no bloquea el render del producto — una oferta flash es la
        // excepción, no la regla, y su remanente vive en Redis, no en este
        // mismo documento (ver ofertaFlashService.consultarStock).
        ofertasApi.consultarStock(id).then(setOfertaStock).catch(() => setOfertaStock(null));
      })
      .catch(() => setError('No encontramos este producto.'))
      .finally(() => setCargando(false));
  }, [id, token]);

  if (cargando) return <Spinner />;
  if (error || !producto) {
    return <p className="rounded-lg bg-danger-500/10 p-4 text-sm text-danger-600">{error || 'Producto no encontrado.'}</p>;
  }

  const stock = producto.inventario?.cantidad ?? 0;
  const sinStock = stock <= 0;
  const subcategoria = producto.subcategoria;
  // Nadie compra lo que él mismo vende (el servidor lo rechaza con 403, ver
  // productoService.verificarNoEsPropio): no se ofrece ninguna forma de comprarlo.
  const esPropio = usuario?.id_usuario != null && usuario.id_usuario === producto.vendedor_id;
  // El historial trae precio y stock de cada versión: el servidor solo se lo da al dueño y a un administrador
  // (productoRoutes.js), así que a otro vendedor ni se le ofrece — pediría un historial que va a recibir en 403.
  const puedeVerHistorial = ROLES_VEN_HISTORIAL.includes(usuario?.rol?.tipo_rol) && (usuario.rol.tipo_rol === 'administrador' || esPropio);
  // Solo un administrador llega a ver un producto oculto (ver productoRoutes.js): su
  // vendedor está suspendido y nadie puede comprarlo hasta que se levante.
  const oculto = producto.vendedor_suspendido === true;

  async function handleAgregar() {
    const ok = await agregar(producto, cantidad);
    if (ok) setAgregado(true);
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
            {producto.resenas_resumen?.cantidad > 0 && (
              <div className="mt-1 flex items-center gap-1.5">
                <StarRating valor={producto.resenas_resumen.promedio} />
                <span className="text-xs text-neutral-500">
                  {producto.resenas_resumen.promedio.toFixed(1)} ({producto.resenas_resumen.cantidad}{' '}
                  reseña{producto.resenas_resumen.cantidad !== 1 ? 's' : ''})
                </span>
              </div>
            )}
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

          {ofertaStock?.activo && ofertaStock.restante > 0 && (
            <div className="rounded-lg border border-accent-300 bg-accent-50 p-4">
              <span className="inline-block rounded-full bg-accent-600 px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide text-white">
                Oferta flash
              </span>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-xl font-bold text-neutral-900">{formatCurrency(ofertaStock.precio_oferta)}</span>
                <span className="text-sm text-neutral-500 line-through">{formatCurrency(producto.inventario?.precio)}</span>
              </div>
              <p className="mt-1 text-sm font-semibold text-accent-700">Quedan {ofertaStock.restante} al precio de oferta</p>
              {!esPropio && (
                <Button variant="accent" onClick={() => navigate(`/ofertas/${producto.id}/comprar`)} className="mt-3 w-full py-2.5">
                  Comprar oferta ahora
                </Button>
              )}
            </div>
          )}

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

          {!sinStock && !esPropio && !oculto && (
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

          {oculto ? (
            <p role="note" className="rounded-lg bg-warning-500/10 p-4 text-sm text-neutral-800">
              Este producto está oculto al público: la cuenta de su vendedor está suspendida, así que no se muestra ni se puede comprar. Vuelve solo cuando se levante la suspensión (ver{' '}
              <Link to="/admin/bloqueos" className="font-medium text-brand-700 hover:underline">
                Cuentas bloqueadas
              </Link>
              ).
            </p>
          ) : esPropio ? (
            <p role="note" className="rounded-lg bg-neutral-100 p-4 text-sm text-neutral-600">
              Este producto es tuyo: no podés comprarlo. Para cambiar su precio, stock u oferta, editalo desde tu panel.
            </p>
          ) : (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button variant="accent" onClick={handleAgregar} disabled={sinStock} className="flex-1 py-3">
                {sinStock ? 'Sin stock' : agregado ? 'Agregado ✓' : 'Agregar al carrito'}
              </Button>
              <Button
                variant="primary"
                disabled={sinStock}
                onClick={async () => {
                  const ok = await agregar(producto, cantidad);
                  if (ok) navigate('/carrito');
                }}
                className="flex-1 py-3"
              >
                Comprar ahora
              </Button>
            </div>
          )}
        </div>
      </div>

      {producto.desde_indice && (
        <p role="note" className="rounded-lg bg-warning-500/10 p-4 text-sm text-neutral-800">
          Estás viendo la versión resumida de este producto: las reseñas, el historial y las ofertas flash no están disponibles en este momento.
        </p>
      )}

      <ProductosRelacionados key={producto.id} productoId={producto.id} titulo={producto.descripcion} token={token} />

      {!producto.desde_indice && puedeVerHistorial && (
        <HistorialSection
          productoId={producto.id}
          vendedorId={producto.vendedor_id}
          vendedorNombre={producto.vendedor_nombre}
          subcategoriaNombre={producto.subcategoria?.subcategoria}
                    token={token}
        />
      )}

      {!producto.desde_indice && <ResenasSection productoId={producto.id} token={token} estaAutenticado={estaAutenticado} />}
    </div>
  );
}
