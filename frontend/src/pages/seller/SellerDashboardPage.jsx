import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { productosApi } from '../../api/productos';
import { formatCurrency } from '../../utils/format';
import { Spinner } from '../../components/common/Spinner';
import { Button } from '../../components/common/Button';
import { HistorialSection } from '../../components/product/HistorialSection';

export function SellerDashboardPage() {
  const { usuario, token } = useAuth();
  const [productos, setProductos] = useState([]);
  const [cargando, setCargando] = useState(true);
  // id del producto con el historial desplegado — uno solo a la vez, no hace
  // falta un Set acá (no es un caso de uso real ver varios en simultáneo).
  const [historialAbierto, setHistorialAbierto] = useState(null);

  useEffect(() => {
    if (!usuario) return;
    productosApi
      .listar({ vendedorId: usuario.id_usuario })
      .then(setProductos)
      .finally(() => setCargando(false));
  }, [usuario]);

  if (cargando) return <Spinner />;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-neutral-900">Mis productos</h1>
        <Button as={Link} to="/vendedor/productos/nuevo" variant="accent">
          + Nuevo producto
        </Button>
      </div>

      {productos.length === 0 ? (
        <p className="rounded-lg border border-dashed border-neutral-300 p-8 text-center text-neutral-500">
          Todavía no publicaste ningún producto.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {productos.map((producto) => {
            const abierto = historialAbierto === producto.id;
            return (
              <div key={producto.id} className="flex flex-col gap-3">
                <div className="flex items-center gap-4 rounded-xl border border-neutral-200 bg-white p-4">
                  <img
                    src={producto.imagen_url || 'https://placehold.co/100x100?text=TiendaYa'}
                    alt={producto.descripcion}
                    className="size-16 shrink-0 rounded-lg object-cover"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-neutral-800">{producto.descripcion}</p>
                    <p className="text-sm text-neutral-500">{producto.subcategoria?.subcategoria || 'Sin categoría'}</p>
                  </div>
                  <div className="hidden text-right sm:block">
                    <p className="font-semibold text-neutral-900">{formatCurrency(producto.inventario?.precio)}</p>
                    <p className="text-sm text-neutral-500">{producto.inventario?.cantidad ?? 0} en stock</p>
                  </div>
                  <span
                    className={`hidden rounded-full px-2.5 py-1 text-xs font-semibold sm:inline-block ${
                      producto.estado === 'activo' ? 'bg-accent-500/10 text-accent-700' : 'bg-neutral-200 text-neutral-600'
                    }`}
                  >
                    {producto.estado}
                  </span>
                  <Button
                    variant="ghost"
                    onClick={() => setHistorialAbierto(abierto ? null : producto.id)}
                    className="shrink-0"
                  >
                    {abierto ? 'Ocultar historial' : 'Historial'}
                  </Button>
                  <Button as={Link} to={`/vendedor/productos/${producto.id}/editar`} variant="outline">
                    Editar
                  </Button>
                </div>

                {abierto && (
                  <HistorialSection
                    productoId={producto.id}
                    vendedorId={producto.vendedor_id}
                    vendedorNombre={producto.vendedor_nombre}
                    subcategoriaNombre={producto.subcategoria?.subcategoria}
                    token={token}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
