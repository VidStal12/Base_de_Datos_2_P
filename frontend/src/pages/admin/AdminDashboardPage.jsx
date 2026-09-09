import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { productosApi, categoriasApi } from '../../api/productos';
import { formatCurrency } from '../../utils/format';
import { Spinner } from '../../components/common/Spinner';
import { Button } from '../../components/common/Button';

const PERIODOS = [
  { label: 'Todo el tiempo', dias: null },
  { label: 'Últimos 7 días', dias: 7 },
  { label: 'Últimos 30 días', dias: 30 },
];

// Agregación de Entrega 1 (ver ADR-003 §3.4 / ENTREGA-1-TRAZABILIDAD §2.4).
// estadisticas/ediciones no trae descripción, solo producto_id — se resuelve
// contra un listado propio sin filtros (no el `productos` de la página, que
// puede estar filtrado por categoría/búsqueda y dejaría ids sin resolver).
function EstadisticasEdicionesWidget() {
  const { token } = useAuth();
  const [stats, setStats] = useState([]);
  const [descripciones, setDescripciones] = useState({});
  const [periodo, setPeriodo] = useState(0);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setCargando(true);
    setError('');
    const dias = PERIODOS[periodo].dias;
    const desde = dias ? new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10) : undefined;
    // Token de administrador acá también: un producto editado y luego
    // desactivado tiene que poder seguir resolviendo su descripción real acá,
    // no caer al "Producto #N" solo porque ya no está activo.
    Promise.all([productosApi.estadisticasEdiciones(desde), productosApi.listar({}, token)])
      .then(([stats, productos]) => {
        setStats(stats);
        setDescripciones(Object.fromEntries(productos.map((p) => [p.id, p.descripcion])));
      })
      .catch(() => setError('No se pudieron cargar las estadísticas.'))
      .finally(() => setCargando(false));
  }, [periodo, token]);

  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-neutral-800">Productos más editados</h2>
          <p className="mt-1 text-xs text-neutral-500">Agregación sobre el historial de eventos (ver ADR-003).</p>
        </div>
        <select
          value={periodo}
          onChange={(e) => setPeriodo(Number(e.target.value))}
          className="rounded-lg border border-neutral-300 px-2 py-1.5 text-xs"
        >
          {PERIODOS.map((p, i) => (
            <option key={p.label} value={i}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      {cargando ? (
        <div className="mt-3">
          <Spinner />
        </div>
      ) : error ? (
        <p className="mt-3 text-sm text-danger-600">{error}</p>
      ) : stats.length === 0 ? (
        <p className="mt-3 text-sm text-neutral-500">Sin ediciones en este período.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-1.5">
          {stats.slice(0, 5).map((s) => (
            <li key={s.producto_id} className="flex items-center justify-between gap-3 text-sm">
              <Link to={`/admin/productos/${s.producto_id}/editar`} className="truncate text-brand-700 hover:underline">
                {descripciones[s.producto_id] || `Producto #${s.producto_id}`}
              </Link>
              <span className="shrink-0 text-xs text-neutral-500">
                {s.total_eventos} {s.total_eventos === 1 ? 'evento' : 'eventos'} · v{s.version_actual} ·{' '}
                {new Date(s.ultima_edicion).toLocaleDateString('es-GT')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AdminDashboardPage() {
  const { token } = useAuth();
  const [productos, setProductos] = useState([]);
  const [categorias, setCategorias] = useState([]);
  const [categoriaId, setCategoriaId] = useState('');
  const [busqueda, setBusqueda] = useState('');
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');

  function cargarProductos() {
    setCargando(true);
    setError('');
    // Token de administrador: sin él, este mismo endpoint filtraría a solo
    // activos (ver productoRoutes.js) — el panel de admin necesita ver y
    // poder editar productos inactivos de cualquier vendedor, no solo los propios.
    productosApi
      .listar({ categoriaId, q: busqueda }, token)
      .then(setProductos)
      .catch(() => setError('No se pudo cargar el catálogo.'))
      .finally(() => setCargando(false));
  }

  useEffect(cargarProductos, [categoriaId, token]);
  useEffect(() => {
    categoriasApi.listar().then(setCategorias).catch(() => setCategorias([]));
  }, []);

  function handleBuscar(e) {
    e.preventDefault();
    cargarProductos();
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-neutral-900">Panel de administrador</h1>
        <div className="flex flex-wrap gap-2">
          {/* Acceso al análisis de ventas y productos con aumento de demanda. */}
          <Button as={Link} to="/admin/ventas" variant="outline">Ventas y demanda</Button>
          <Button as={Link} to="/admin/fraude" variant="outline">Señales de fraude</Button>
          <Button as={Link} to="/admin/productos/nuevo" variant="accent">
            + Nuevo producto
          </Button>
        </div>
      </div>

      <EstadisticasEdicionesWidget />

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
