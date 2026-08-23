import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { productosApi, categoriasApi } from '../api/productos';
import { ProductCard } from '../components/product/ProductCard';
import { Spinner } from '../components/common/Spinner';

export function HomePage() {
  const [searchParams] = useSearchParams();
  const q = searchParams.get('q') || '';
  const categoriaId = searchParams.get('categoriaId') || '';
  const subcategoriaId = searchParams.get('subcategoriaId') || '';

  const [productos, setProductos] = useState([]);
  const [categorias, setCategorias] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setCargando(true);
    setError('');
    productosApi
      .listar({ q, categoriaId, subcategoriaId })
      .then(setProductos)
      .catch(() => setError('No se pudo cargar el catálogo. ¿Está corriendo el backend?'))
      .finally(() => setCargando(false));
  }, [q, categoriaId, subcategoriaId]);

  useEffect(() => {
    categoriasApi.listar().then(setCategorias).catch(() => {});
  }, []);

  const categoriaActiva = categorias.find((c) => String(c.id) === categoriaId);
  const hayFiltro = Boolean(q || categoriaId || subcategoriaId);

  return (
    <div className="flex flex-col gap-6">
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
  );
}
