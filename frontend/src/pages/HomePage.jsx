import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { productosApi, categoriasApi } from '../api/productos';
import { ProductCard } from '../components/product/ProductCard';
import { Spinner } from '../components/common/Spinner';

// Deriva las opciones de cada atributo a partir de los productos de la
// subcategoría (sin aplicar todavía el filtro de atributos) — así las
// opciones no van desapareciendo a medida que se elige una. Simplificación
// deliberada: no recalcula conteos por opción restante como haría un sitio
// real; ver la conversación de diseño en IA/ESTADO-PROYECTO.md.
function calcularFacetas(productos) {
  const mapa = {};
  for (const p of productos) {
    for (const a of p.atributos || []) {
      if (!mapa[a.nombre]) mapa[a.nombre] = new Set();
      mapa[a.nombre].add(a.valor);
    }
  }
  return Object.fromEntries(Object.entries(mapa).map(([nombre, valores]) => [nombre, [...valores].sort()]));
}

function FacetFilters({ facetas, seleccionados, onToggle, onLimpiar }) {
  const nombres = Object.keys(facetas);
  if (nombres.length === 0) return null;
  const hayFiltrosActivos = Object.keys(seleccionados).length > 0;

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-neutral-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-neutral-800">Filtrar por</h2>
        {hayFiltrosActivos && (
          <button onClick={onLimpiar} className="text-xs font-medium text-brand-700 hover:underline">
            Limpiar
          </button>
        )}
      </div>
      {nombres.map((nombre) => (
        <div key={nombre}>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-500">{nombre}</h3>
          <div className="flex flex-col gap-1">
            {facetas[nombre].map((valor) => (
              <label key={valor} className="flex items-center gap-2 text-sm text-neutral-700">
                <input
                  type="checkbox"
                  checked={seleccionados[nombre] === valor}
                  onChange={() => onToggle(nombre, valor)}
                  className="rounded border-neutral-300 text-brand-600 focus:ring-brand-500"
                />
                {valor}
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function HomePage() {
  const [searchParams] = useSearchParams();
  const q = searchParams.get('q') || '';
  const categoriaId = searchParams.get('categoriaId') || '';
  const subcategoriaId = searchParams.get('subcategoriaId') || '';

  const [productos, setProductos] = useState([]);
  const [categorias, setCategorias] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');

  const [facetas, setFacetas] = useState({});
  const [atributosSeleccionados, setAtributosSeleccionados] = useState({});

  // Opciones de filtro: de la subcategoría completa, sin el filtro de
  // atributos todavía aplicado (ver calcularFacetas). Se resetea la selección
  // al cambiar de subcategoría porque los atributos de una no aplican a otra.
  useEffect(() => {
    setAtributosSeleccionados({});
    if (!subcategoriaId) {
      setFacetas({});
      return;
    }
    productosApi
      .listar({ subcategoriaId })
      .then((base) => setFacetas(calcularFacetas(base)))
      .catch(() => setFacetas({}));
  }, [subcategoriaId]);

  useEffect(() => {
    setCargando(true);
    setError('');
    const filtros = { q, categoriaId, subcategoriaId };
    if (Object.keys(atributosSeleccionados).length > 0) {
      filtros.atributos = JSON.stringify(atributosSeleccionados);
    }
    productosApi
      .listar(filtros)
      .then(setProductos)
      .catch(() => setError('No se pudo cargar el catálogo. ¿Está corriendo el backend?'))
      .finally(() => setCargando(false));
  }, [q, categoriaId, subcategoriaId, atributosSeleccionados]);

  useEffect(() => {
    categoriasApi.listar().then(setCategorias).catch(() => {});
  }, []);

  function toggleAtributo(nombre, valor) {
    setAtributosSeleccionados((prev) => {
      if (prev[nombre] === valor) {
        const { [nombre]: _quitado, ...resto } = prev;
        return resto;
      }
      return { ...prev, [nombre]: valor };
    });
  }

  const categoriaActiva = categorias.find((c) => String(c.id) === categoriaId);
  const hayFiltro = Boolean(q || categoriaId || subcategoriaId);
  const mostrarFacetas = Boolean(subcategoriaId) && Object.keys(facetas).length > 0;

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      {mostrarFacetas && (
        <aside className="w-full shrink-0 lg:w-56">
          <FacetFilters
            facetas={facetas}
            seleccionados={atributosSeleccionados}
            onToggle={toggleAtributo}
            onLimpiar={() => setAtributosSeleccionados({})}
          />
        </aside>
      )}

      <div className="flex min-w-0 flex-1 flex-col gap-6">
        {!hayFiltro && (
          <section className="overflow-hidden rounded-2xl bg-gradient-to-r from-brand-700 to-brand-500 px-8 py-12 text-white sm:py-16">
            <h1 className="text-2xl font-bold sm:text-4xl">Todo lo que buscás, a un clic.</h1>
            <p className="mt-2 max-w-xl text-brand-100">
              Explorá el catálogo de TiendaYa — precios claros, envío directo a tu dirección guardada.
            </p>
          </section>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-neutral-800">
            {q ? `Resultados para "${q}"` : categoriaActiva ? categoriaActiva.categoria : 'Todos los productos'}
          </h2>
          {hayFiltro && (
            <Link to="/" className="text-sm font-medium text-brand-700 hover:underline">
              Quitar filtros
            </Link>
          )}
        </div>

        {cargando && <Spinner />}

        {error && <p className="rounded-lg bg-danger-500/10 p-4 text-sm text-danger-600">{error}</p>}

        {!cargando && !error && productos.length === 0 && (
          <p className="rounded-lg border border-dashed border-neutral-300 p-8 text-center text-neutral-500">
            No encontramos productos que coincidan con tu búsqueda.
          </p>
        )}

        {!cargando && !error && productos.length > 0 && (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {productos.map((producto) => (
              <ProductCard key={producto.id} producto={producto} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
