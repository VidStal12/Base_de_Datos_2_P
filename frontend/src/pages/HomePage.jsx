import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { productosApi, categoriasApi } from '../api/productos';
import { busquedaApi } from '../api/busqueda';
import { recomendacionesApi } from '../api/recomendaciones';
import { useAuth } from '../context/AuthContext';
import { ProductCard } from '../components/product/ProductCard';
import { Spinner } from '../components/common/Spinner';
import { formatCurrency } from '../utils/format';

// "Recomendado para vos" (Entrega 2, ver IA/ENTREGA-2-PLAN.md §4.5) —
// distinto de las ofertas flash normales (/ofertas, configuradas a mano por
// un vendedor sobre SU producto): esto analiza el historial de compras del
// usuario y encuentra productos similares de OTROS vendedores, sin que nadie
// lo configure. Solo se muestra si hay sesión iniciada Y el análisis
// encontró algo — un comprador sin historial, o cuyo historial no tiene
// competencia real en el catálogo, simplemente no ve esta sección.
function RecomendacionesSection() {
  const { usuario, token } = useAuth();
  const [datos, setDatos] = useState(null);

  useEffect(() => {
    if (!usuario) {
      setDatos(null);
      return;
    }
    recomendacionesApi
      .obtener(token)
      .then(setDatos)
      .catch(() => setDatos(null));
  }, [usuario, token]);

  if (!datos?.tendencia || datos.productos.length === 0) return null;

  const descripcionTendencia = datos.tendencia.atributosPreferidos.map((a) => `${a.nombre}: ${a.valor}`).join(', ');

  return (
    <section className="rounded-2xl border border-accent-200 bg-accent-50/60 p-5">
      <h2 className="text-lg font-bold text-neutral-900">Recomendado para vos</h2>
      <p className="mt-1 text-sm text-neutral-600">
        Porque compraste seguido productos con {descripcionTendencia} — encontramos opciones parecidas, de distintos vendedores.
      </p>
      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        {datos.productos.map((p) => (
          <Link
            key={p.id}
            to={`/recomendaciones/${p.id}/comprar`}
            className="flex flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white transition-shadow hover:shadow-lg"
          >
            <div className="aspect-square overflow-hidden bg-neutral-100">
              <img
                src={p.imagen_url || 'https://placehold.co/400x400?text=TiendaYa'}
                alt={p.descripcion}
                loading="lazy"
                className="size-full object-cover"
              />
            </div>
            <div className="flex flex-1 flex-col gap-1 p-3">
              <p className="line-clamp-2 text-sm font-medium text-neutral-800">{p.descripcion}</p>
              <p className="text-xs text-neutral-500">{p.vendedor_nombre}</p>
              <div className="mt-auto flex items-baseline gap-2">
                <span className="font-bold text-neutral-900">{formatCurrency(p.precio_recomendado)}</span>
                <span className="text-xs text-neutral-500 line-through">{formatCurrency(p.precio_normal)}</span>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}

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
  const navigate = useNavigate();
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

  // Precio/orden: a diferencia de los atributos, no dependen de estar dentro
  // de una subcategoría (el precio existe para cualquier producto) — por eso
  // no viven en el sidebar de FacetFilters, que sí es exclusivo de esa vista.
  const [precioMinInput, setPrecioMinInput] = useState('');
  const [precioMaxInput, setPrecioMaxInput] = useState('');
  const [precioMin, setPrecioMin] = useState('');
  const [precioMax, setPrecioMax] = useState('');
  const [ordenarPor, setOrdenarPor] = useState('');

  // Opciones de filtro: de la subcategoría completa, sin el filtro de
  // atributos todavía aplicado (ver calcularFacetas). Se resetea la selección
  // al cambiar de subcategoría porque los atributos de una no aplican a otra.
  // Con texto de búsqueda activo (q), las facetas salen de la respuesta de
  // busquedaApi.buscar() en el otro efecto — este no las toca, para que no
  // compitan por el mismo estado.
  useEffect(() => {
    setAtributosSeleccionados({});
    if (q) return;
    if (!subcategoriaId) {
      setFacetas({});
      return;
    }
    productosApi
      .listar({ subcategoriaId })
      .then((base) => setFacetas(calcularFacetas(base)))
      .catch(() => setFacetas({}));
  }, [subcategoriaId, q]);

  // Con texto de búsqueda (q): Elasticsearch — tolerancia ortográfica,
  // relevancia y facetas calculadas con una agregación real (ver
  // IA/PLAN-ELASTICSEARCH-BUSQUEDA.md). Sin texto: el catálogo normal contra
  // Mongo, exactamente como antes — ese camino no se toca.
  useEffect(() => {
    setCargando(true);
    setError('');
    const filtros = { categoriaId, subcategoriaId };
    if (Object.keys(atributosSeleccionados).length > 0) {
      filtros.atributos = JSON.stringify(atributosSeleccionados);
    }
    if (precioMin !== '') filtros.precioMin = precioMin;
    if (precioMax !== '') filtros.precioMax = precioMax;
    if (ordenarPor) filtros.ordenarPor = ordenarPor;

    if (q) {
      busquedaApi
        .buscar({ ...filtros, q })
        .then((resultado) => {
          setProductos(resultado.resultados);
          setFacetas(resultado.facetas);
        })
        .catch(() => setError('No se pudo buscar. ¿Está corriendo el backend?'))
        .finally(() => setCargando(false));
    } else {
      productosApi
        .listar(filtros)
        .then(setProductos)
        .catch(() => setError('No se pudo cargar el catálogo. ¿Está corriendo el backend?'))
        .finally(() => setCargando(false));
    }
  }, [q, categoriaId, subcategoriaId, atributosSeleccionados, precioMin, precioMax, ordenarPor]);

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

  function aplicarPrecio(e) {
    e.preventDefault();
    setPrecioMin(precioMinInput);
    setPrecioMax(precioMaxInput);
  }

  function limpiarPrecio() {
    setPrecioMinInput('');
    setPrecioMaxInput('');
    setPrecioMin('');
    setPrecioMax('');
  }

  // "Quitar filtros" tiene que limpiar TODO, no solo lo que vive en la URL
  // (q/categoriaId/subcategoriaId) — precio y orden son estado local de esta
  // página, un <Link to="/"> por sí solo los dejaría pegados.
  function quitarTodosLosFiltros() {
    limpiarPrecio();
    setOrdenarPor('');
    navigate('/');
  }

  const categoriaActiva = categorias.find((c) => String(c.id) === categoriaId);
  const hayFiltro = Boolean(q || categoriaId || subcategoriaId || precioMin !== '' || precioMax !== '' || ordenarPor);
  const mostrarFacetas = (Boolean(subcategoriaId) || Boolean(q)) && Object.keys(facetas).length > 0;

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
          <>
            <section className="overflow-hidden rounded-2xl bg-gradient-to-r from-brand-700 to-brand-500 px-8 py-12 text-white sm:py-16">
              <h1 className="text-2xl font-bold sm:text-4xl">Todo lo que buscás, a un clic.</h1>
              <p className="mt-2 max-w-xl text-brand-100">
                Explorá el catálogo de TiendaYa — precios claros, envío directo a tu dirección guardada.
              </p>
            </section>
            <RecomendacionesSection />
          </>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-neutral-800">
            {q ? `Resultados para "${q}"` : categoriaActiva ? categoriaActiva.categoria : 'Todos los productos'}
          </h2>
          {hayFiltro && (
            <button onClick={quitarTodosLosFiltros} className="text-sm font-medium text-brand-700 hover:underline">
              Quitar filtros
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-neutral-200 bg-white p-3">
          <form onSubmit={aplicarPrecio} className="flex items-center gap-2">
            <span className="text-xs font-semibold text-neutral-600">Precio</span>
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="Mín"
              value={precioMinInput}
              onChange={(e) => setPrecioMinInput(e.target.value)}
              className="w-20 rounded-lg border border-neutral-300 px-2 py-1.5 text-sm"
            />
            <span className="text-neutral-400">–</span>
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="Máx"
              value={precioMaxInput}
              onChange={(e) => setPrecioMaxInput(e.target.value)}
              className="w-20 rounded-lg border border-neutral-300 px-2 py-1.5 text-sm"
            />
            <button type="submit" className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50">
              Aplicar
            </button>
            {(precioMin !== '' || precioMax !== '') && (
              <button type="button" onClick={limpiarPrecio} className="text-xs font-medium text-brand-700 hover:underline">
                Quitar
              </button>
            )}
          </form>

          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs font-semibold text-neutral-600">Ordenar</span>
            <select
              value={ordenarPor}
              onChange={(e) => setOrdenarPor(e.target.value)}
              className="rounded-lg border border-neutral-300 px-2 py-1.5 text-sm"
            >
              <option value="">Relevancia</option>
              <option value="masVendidos">Más vendidos</option>
            </select>
          </div>
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
