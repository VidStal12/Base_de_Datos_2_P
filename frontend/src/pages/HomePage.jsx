import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { busquedaApi } from '../api/busqueda';
import { recomendacionesApi } from '../api/recomendaciones';
import { useAuth } from '../context/AuthContext';
import { ProductCard } from '../components/product/ProductCard';
import { AttributeFacets } from '../components/search/AttributeFacets';
import { CategoryTree } from '../components/search/CategoryTree';
import { Migas } from '../components/search/Migas';
import { Pagination } from '../components/search/Pagination';
import { PriceFacet } from '../components/search/PriceFacet';
import { Spinner } from '../components/common/Spinner';
import { formatCurrency } from '../utils/format';
import { aParametros, alternarAtributo, conCategoria, conOrden, conPagina, conPrecio, conSubcategoria, hayFiltros, leerFiltros, sinAtributos } from '../utils/filtrosBusqueda';

function TarjetaConDescuento({ producto }) {
  return (
    <Link
      to={`/recomendaciones/${producto.id}/comprar`}
      className="flex flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white transition-shadow hover:shadow-lg"
    >
      <div className="aspect-square overflow-hidden bg-neutral-100">
        <img
          src={producto.imagen_url || 'https://placehold.co/400x400?text=TiendaYa'}
          alt={producto.descripcion}
          loading="lazy"
          className="size-full object-cover"
        />
      </div>
      <div className="flex flex-1 flex-col gap-1 p-3">
        <p className="line-clamp-2 text-sm font-medium text-neutral-800">{producto.descripcion}</p>
        <p className="text-xs text-neutral-500">{producto.vendedor_nombre}</p>
        <div className="mt-auto flex items-baseline gap-2">
          <span className="font-bold text-neutral-900">{formatCurrency(producto.precio_recomendado)}</span>
          <span className="text-xs text-neutral-500 line-through">{formatCurrency(producto.precio_normal)}</span>
        </div>
      </div>
    </Link>
  );
}

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
          <TarjetaConDescuento key={p.id} producto={p} />
        ))}
      </div>
    </section>
  );
}

function SugeridosSinResultados({ sugeridos, origen, termino }) {
  if (!sugeridos || sugeridos.length === 0) return null;
  const titulo =
    origen === 'historial'
      ? 'Basado en lo que sueles comprar'
      : origen === 'busquedaReciente'
        ? `Basado en tu búsqueda reciente de "${termino}"`
        : origen === 'productoVisto'
          ? 'Lo último que viste'
          : 'Los más vendidos';

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-base font-semibold text-neutral-800">{titulo}</h3>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
        {origen === 'historial'
          ? sugeridos.map((p) => <TarjetaConDescuento key={p.id} producto={p} />)
          : sugeridos.map((p) => <ProductCard key={p.id} producto={p} />)}
      </div>
    </section>
  );
}

const ORDENES = [
  { valor: '', texto: 'Relevancia' },
  { valor: 'masVendidos', texto: 'Más vendidos' },
  { valor: 'precioAsc', texto: 'Precio: de menor a mayor' },
  { valor: 'precioDesc', texto: 'Precio: de mayor a menor' },
];

export function HomePage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const consulta = searchParams.toString();
  const filtros = useMemo(() => leerFiltros(new URLSearchParams(consulta)), [consulta]);
  const { token } = useAuth();

  const [respuesta, setRespuesta] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');
  const [filtrosAbiertos, setFiltrosAbiertos] = useState(false);

  useEffect(() => {
    let vigente = true;
    setCargando(true);
    setError('');
    busquedaApi
      .buscar(aParametros(filtros), token)
      .then((r) => {
        if (vigente) setRespuesta(r);
      })
      .catch((err) => {
        if (vigente) setError(err.message || 'No se pudo cargar el catálogo.');
      })
      .finally(() => {
        if (vigente) setCargando(false);
      });
    return () => {
      vigente = false;
    };
  }, [filtros, token]);

  useEffect(() => {
    if (respuesta && respuesta.total > 0 && filtros.pagina > respuesta.paginas) {
      setSearchParams(aParametros(conPagina(filtros, respuesta.paginas)), { replace: true });
    }
  }, [respuesta, filtros, setSearchParams]);

  const cambiar = (nuevos) => setSearchParams(aParametros(nuevos));
  const elegirCategoria = (id) => {
    if (id === filtros.categoriaId && !filtros.subcategoriaId) return;
    setFiltrosAbiertos(false);
    cambiar(conCategoria(filtros, id));
  };
  const elegirSubcategoria = (id) => {
    setFiltrosAbiertos(false);
    cambiar(conSubcategoria(filtros, id));
  };
  const irAPagina = (n) => {
    cambiar(conPagina(filtros, n));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const resultados = respuesta?.resultados ?? [];
  const portada = !hayFiltros(filtros) && filtros.pagina === 1;
  const desde = respuesta && respuesta.total > 0 ? (respuesta.pagina - 1) * respuesta.tamano + 1 : 0;
  const hasta = desde > 0 ? desde + resultados.length - 1 : 0;
  const titulo = filtros.q ? `Resultados para "${filtros.q}"` : respuesta?.ruta.at(-1)?.nombre ?? 'Todos los productos';

  const subcategoriasConResultados = respuesta
    ? respuesta.arbol
        .filter((c) => !filtros.categoriaId || c.id === filtros.categoriaId)
        .flatMap((c) => c.subcategorias)
        .filter((s) => s.cantidad > 0).length
    : 0;
  const pedirSubcategoria = respuesta && respuesta.atributos.length === 0 && !filtros.subcategoriaId && subcategoriasConResultados > 1;

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      <aside className="w-full shrink-0 lg:w-64">
        <button
          type="button"
          onClick={() => setFiltrosAbiertos((abierto) => !abierto)}
          aria-expanded={filtrosAbiertos}
          className="w-full rounded-lg border border-neutral-300 bg-white px-4 py-2.5 text-sm font-semibold text-neutral-800 lg:hidden"
        >
          {filtrosAbiertos ? 'Ocultar categorías y filtros' : 'Categorías y filtros'}
        </button>
        <div className={`${filtrosAbiertos ? 'flex' : 'hidden'} mt-3 flex-col gap-4 lg:mt-0 lg:flex`}>
          {respuesta && (
            <>
              <CategoryTree
                arbol={respuesta.arbol}
                onCategoria={elegirCategoria}
                onSubcategoria={elegirSubcategoria}
                onTodas={() => cambiar(conCategoria(filtros, ''))}
              />
              <AttributeFacets
                atributos={respuesta.atributos}
                onToggle={(nombre, valor) => cambiar(alternarAtributo(filtros, nombre, valor))}
                onLimpiar={() => cambiar(sinAtributos(filtros))}
              />
              {pedirSubcategoria && (
                <p role="note" className="rounded-xl border border-dashed border-neutral-300 bg-white p-4 text-xs text-neutral-600">
                  Elegí una subcategoría para filtrar por sus atributos (talla, color, almacenamiento…).
                </p>
              )}
              <PriceFacet
                key={`${filtros.precioMin}|${filtros.precioMax}`}
                precio={respuesta.precio}
                precioMin={filtros.precioMin}
                precioMax={filtros.precioMax}
                onAplicar={(min, max) => cambiar(conPrecio(filtros, min, max))}
                onQuitar={() => cambiar(conPrecio(filtros, '', ''))}
              />
            </>
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col gap-6">
        {portada && (
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

        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold text-neutral-800">{titulo}</h2>
            {respuesta && (
              <Migas
                ruta={respuesta.ruta}
                onTodas={() => cambiar(conCategoria(filtros, ''))}
                onCategoria={(id) => cambiar(conCategoria(filtros, id))}
              />
            )}
          </div>
          {hayFiltros(filtros) && (
            <button type="button" onClick={() => navigate('/')} className="text-sm font-medium text-brand-700 hover:underline">
              Quitar filtros
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-neutral-200 bg-white p-3">
          <p aria-live="polite" className="text-sm text-neutral-600">
            {respuesta ? (respuesta.total > 0 ? `Mostrando ${desde}–${hasta} de ${respuesta.total}` : 'Sin resultados') : ''}
          </p>
          <div className="flex items-center gap-2">
            <label htmlFor="orden" className="text-xs font-semibold text-neutral-600">
              Ordenar
            </label>
            <select
              id="orden"
              value={filtros.ordenarPor}
              onChange={(e) => cambiar(conOrden(filtros, e.target.value))}
              className="rounded-lg border border-neutral-300 px-2 py-1.5 text-sm"
            >
              {ORDENES.map((orden) => (
                <option key={orden.valor} value={orden.valor}>
                  {orden.texto}
                </option>
              ))}
            </select>
          </div>
        </div>

        {filtros.q && respuesta?.modo === 'basico' && (
          <p role="note" className="rounded-lg bg-warning-500/10 p-3 text-sm text-neutral-800">
            Búsqueda básica: el buscador avanzado no está disponible ahora, así que no se corrigen errores de tipeo.
          </p>
        )}

        {error && <p className="rounded-lg bg-danger-500/10 p-4 text-sm text-danger-600">{error}</p>}

        {cargando && !respuesta && <Spinner />}

        {respuesta && respuesta.total === 0 && !error && (
          <div className="flex flex-col gap-6">
            <p className="rounded-lg border border-dashed border-neutral-300 p-8 text-center text-neutral-500">
              No encontramos productos que coincidan con tu búsqueda.
            </p>
            <SugeridosSinResultados
              sugeridos={respuesta.sugeridos}
              origen={respuesta.origenSugerencia}
              termino={respuesta.terminoBusquedaReciente}
            />
          </div>
        )}

        {resultados.length > 0 && (
          <div aria-busy={cargando} className={`grid grid-cols-2 gap-4 transition-opacity sm:grid-cols-3 xl:grid-cols-4 ${cargando ? 'opacity-60' : ''}`}>
            {resultados.map((producto) => (
              <ProductCard key={producto.id} producto={producto} />
            ))}
          </div>
        )}

        {respuesta && <Pagination pagina={respuesta.pagina} paginas={respuesta.paginas} onCambiar={irAPagina} />}
      </div>
    </div>
  );
}