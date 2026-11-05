import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { busquedaApi } from '../api/busqueda';
import { useAuth } from '../context/AuthContext';
import { Portada } from '../components/home/Portada';
import { TarjetaConDescuento } from '../components/home/RecomendadosCarrusel';
import { ProductCard } from '../components/product/ProductCard';
import { AttributeFacets } from '../components/search/AttributeFacets';
import { CategoryTree } from '../components/search/CategoryTree';
import { Migas } from '../components/search/Migas';
import { Pagination } from '../components/search/Pagination';
import { PriceFacet } from '../components/search/PriceFacet';
import { Spinner } from '../components/common/Spinner';
import { aParametros, alternarAtributo, conCategoria, conOrden, conPagina, conPrecio, conSubcategoria, hayFiltros, leerFiltros, sinAtributos } from '../utils/filtrosBusqueda';

// Lo que se ofrece cuando un TEXTO no encuentra nada (GET /api/busqueda, ver catalogoLecturaService.js). `origen` dice
// de dónde salió: 'busquedaReciente' (la última búsqueda del usuario que sí dio resultados, `termino`),
// 'productoVisto' (lo último que abrió), 'historial' (sus compras: tarjetas con descuento) o 'tendencia' (los más
// vendidos, también para quien no inició sesión). Sin sugerencias no se dibuja nada.
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
  // Sin orden elegido, el servidor mezcla la relevancia del texto con lo que el producto vende, lo que se
  // abre y lo nuevo que es (backend/src/services/rankingBusqueda.js).
  { valor: '', texto: 'Relevancia y popularidad' },
  { valor: 'masVendidos', texto: 'Más vendidos' },
  { valor: 'masRecientes', texto: 'Más recientes' },
  { valor: 'precioAsc', texto: 'Precio: de menor a mayor' },
  { valor: 'precioDesc', texto: 'Precio: de mayor a menor' },
];

// La portada, la navegación por categorías y la búsqueda por texto son UNA sola pantalla y UNA sola consulta
// (GET /api/busqueda, Elasticsearch): lo que se elige en la barra lateral — categoría, atributos, precio,
// orden y página — vive en la URL (utils/filtrosBusqueda.js), así que el botón «atrás», un enlace copiado y
// los enlaces del menú de categorías (/?categoriaId=…) funcionan sin estado aparte. La respuesta trae todo lo
// que se dibuja: los productos de la página, el árbol de categorías con conteos y las facetas de atributo y de
// precio, todas calculadas por el motor con agregaciones disyuntivas (cada faceta cuenta con los demás
// filtros menos el suyo, así que marcar Talla M no esconde a Talla L ni a las otras categorías).
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

  // Se conserva la respuesta anterior mientras llega la nueva: la barra lateral no parpadea al elegir algo.
  // La bandera `vigente` descarta una respuesta que llega tarde, cuando ya se pidió otra. El token es opcional:
  // sin sesión es la misma búsqueda pública; con sesión, el servidor puede personalizar las sugerencias de un
  // texto sin resultados (por eso la consulta se repite al iniciar o cerrar sesión).
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

  // Un enlace con una página que no existe (?pagina=99) vuelve a la última, sin dejar una pantalla vacía.
  useEffect(() => {
    if (respuesta && respuesta.total > 0 && filtros.pagina > respuesta.paginas) {
      setSearchParams(aParametros(conPagina(filtros, respuesta.paginas)), { replace: true });
    }
  }, [respuesta, filtros, setSearchParams]);

  const cambiar = (nuevos) => setSearchParams(aParametros(nuevos));
  // Elegir categoría o subcategoría cambia de «lugar»: en el celular el panel se pliega para dejar ver los
  // resultados. Marcar atributos o precio no lo pliega — suelen ser varios clics seguidos.
  const elegirCategoria = (id) => {
    if (id === filtros.categoriaId && !filtros.subcategoriaId) return; // ya está ahí
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
  // La portada ya tiene su h1 (la bienvenida); en una búsqueda o una categoría, el título del listado es el de la página.
  const Titulo = portada ? 'h2' : 'h1';

  // Los atributos son de cada subcategoría («Talla» de camisetas y de zapatos no se mezclan): se ofrecen cuando
  // los resultados caen en UNA. Si hay varias, se invita a elegir.
  const subcategoriasConResultados = respuesta
    ? respuesta.arbol
        .filter((c) => !filtros.categoriaId || c.id === filtros.categoriaId)
        .flatMap((c) => c.subcategorias)
        .filter((s) => s.cantidad > 0).length
    : 0;
  const pedirSubcategoria = respuesta && respuesta.atributos.length === 0 && !filtros.subcategoriaId && subcategoriasConResultados > 1;

  return (
    <>
    {portada && <Portada arbol={respuesta?.arbol} />}

    <div id="catalogo" className={`flex scroll-mt-4 flex-col gap-6 lg:flex-row lg:items-start ${portada ? 'mt-8' : ''}`}>
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
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-col gap-1">
            <Titulo className="text-lg font-semibold text-neutral-800">{titulo}</Titulo>
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
    </>
  );
}
