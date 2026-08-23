import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { productosApi, categoriasApi } from '../../api/productos';
import { adminApi } from '../../api/admin';
import { formatCurrency } from '../../utils/format';
import { Spinner } from '../../components/common/Spinner';
import { Button } from '../../components/common/Button';

export function AdminDashboardPage() {
  const { token } = useAuth();
  const [productos, setProductos] = useState([]);
  const [categorias, setCategorias] = useState([]);
  const [categoriaId, setCategoriaId] = useState('');
  const [busqueda, setBusqueda] = useState('');
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');
  const [sincronizando, setSincronizando] = useState(false);
  const [resultadoSync, setResultadoSync] = useState(null);

  function cargarProductos() {
    setCargando(true);
    setError('');
    productosApi
      .listar({ categoriaId, q: busqueda })
      .then(setProductos)
      .catch(() => setError('No se pudo cargar el catálogo.'))
      .finally(() => setCargando(false));
  }

  useEffect(cargarProductos, [categoriaId]);
  useEffect(() => {
    categoriasApi.listar().then(setCategorias).catch(() => setCategorias([]));
  }, []);

  function handleBuscar(e) {
    e.preventDefault();
    cargarProductos();
  }

  async function handleSincronizar() {
    setSincronizando(true);
    setResultadoSync(null);
    setError('');
    try {
      const resultado = await adminApi.sincronizarCatalogo(token);
      setResultadoSync(resultado);
      cargarProductos();
    } catch (err) {
      setError(err.message);
    } finally {
      setSincronizando(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-neutral-900">Panel de administrador</h1>
        <Button as={Link} to="/admin/productos/nuevo" variant="accent">
          + Nuevo producto
        </Button>
      </div>

      <div className="rounded-xl border border-neutral-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-neutral-800">Catálogo documental (MongoDB)</h2>
            <p className="mt-1 max-w-2xl text-xs text-neutral-500">
              Agrega a MongoDB los productos/categorías que ya existan en MySQL y todavía no tengan documento. No borra
              ni sobrescribe nada de lo que ya está sincronizado — es seguro correrlo las veces que haga falta.
            </p>
          </div>
          <Button onClick={handleSincronizar} disabled={sincronizando} variant="outline" className="shrink-0">
            {sincronizando ? 'Sincronizando...' : 'Sincronizar con MongoDB'}
          </Button>
        </div>

        {resultadoSync && (
          <div className="mt-4 rounded-lg bg-brand-50 p-3 text-sm text-brand-900">
            <p>
              Categorías creadas: <strong>{resultadoSync.categorias_creadas}</strong> · Subcategorías creadas:{' '}
              <strong>{resultadoSync.subcategorias_creadas}</strong> · Productos creados:{' '}
              <strong>{resultadoSync.productos_creados}</strong>
            </p>
            {resultadoSync.productos_omitidos.length > 0 && (
              <div className="mt-2 text-danger-700">
                <p className="font-medium">Omitidos ({resultadoSync.productos_omitidos.length}):</p>
                <ul className="list-inside list-disc">
                  {resultadoSync.productos_omitidos.map((p) => (
                    <li key={p.id}>
                      #{p.id} {p.descripcion} — {p.motivo}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>

      <form onSubmit={handleBuscar} className="flex flex-wrap gap-3">
        <select
          value={categoriaId}
          onChange={(e) => setCategoriaId(e.target.value)}
          className="rounded-lg border border-neutral-300 px-3 py-2 text-sm"
        >
          <option value="">Todas las categorías</option>
          {categorias.map((c) => (
            <option key={c.id} value={c.id}>
              {c.categoria}
            </option>
          ))}
        </select>
        <input
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          placeholder="Buscar por descripción..."
          className="min-w-0 flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm"
        />
        <Button type="submit" variant="outline">
          Buscar
        </Button>
      </form>

      {error && <p className="rounded-lg bg-danger-500/10 p-4 text-sm text-danger-600">{error}</p>}

      {cargando ? (
        <Spinner />
      ) : productos.length === 0 ? (
        <p className="rounded-lg border border-dashed border-neutral-300 p-8 text-center text-neutral-500">
          No hay productos que coincidan.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {productos.map((producto) => (
            <div key={producto.id} className="flex items-center gap-4 rounded-xl border border-neutral-200 bg-white p-4">
              <img
                src={producto.imagen_url || 'https://placehold.co/100x100?text=TiendaYa'}
                alt={producto.descripcion}
                className="size-16 shrink-0 rounded-lg object-cover"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-neutral-800">{producto.descripcion}</p>
                <p className="text-sm text-neutral-500">
                  {producto.subcategoria?.subcategoria || 'Sin categoría'} · Vendedor: {producto.vendedor_nombre}
                </p>
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
              <Button as={Link} to={`/admin/productos/${producto.id}/editar`} variant="outline">
                Editar
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
