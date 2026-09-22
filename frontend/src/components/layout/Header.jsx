import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useCart } from '../../context/CartContext';
import { categoriasApi } from '../../api/productos';
import { CategoryMenu } from './CategoryMenu';

function CartIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="9" cy="21" r="1" />
      <circle cx="20" cy="21" r="1" />
      <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
    </svg>
  );
}

function UserIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

export function Header() {
  const { usuario, estaAutenticado, logout } = useAuth();
  const { cantidadTotal } = useCart();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [busqueda, setBusqueda] = useState(searchParams.get('q') || '');
  const [categorias, setCategorias] = useState([]);

  useEffect(() => {
    categoriasApi.listar().then(setCategorias).catch(() => setCategorias([]));
  }, []);

  function handleSearch(e) {
    e.preventDefault();
    const params = new URLSearchParams();
    if (busqueda.trim()) params.set('q', busqueda.trim());
    navigate(`/?${params.toString()}`);
  }

  return (
    <header className="sticky top-0 z-30">
      <div className="bg-brand-900 text-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3 sm:flex-nowrap">
          <Link to="/" className="shrink-0 text-xl font-bold tracking-tight">
            Tienda<span className="text-accent-400">Ya</span>
          </Link>

          <div className="order-3 flex w-full min-w-0 flex-1 sm:order-none">
            <CategoryMenu categorias={categorias} />
            <form onSubmit={handleSearch} className="flex min-w-0 flex-1">
              <input
                type="search"
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                placeholder="Buscar productos..."
                className="w-full min-w-0 border-0 border-l border-brand-600 px-4 py-2.5 text-neutral-900 placeholder-neutral-400 focus:outline-2 focus:outline-accent-500"
              />
              <button
                type="submit"
                aria-label="Buscar"
                className="flex shrink-0 items-center justify-center rounded-r-lg bg-accent-500 px-4 text-white transition-colors hover:bg-accent-600"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="size-5">
                  <circle cx="11" cy="11" r="7" />
                  <path strokeLinecap="round" d="m21 21-4.3-4.3" />
                </svg>
              </button>
            </form>
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-4 text-sm sm:ml-0">
            {estaAutenticado ? (
              <div className="flex items-center gap-3">
                {['vendedor', 'administrador'].includes(usuario?.rol?.tipo_rol) && (
                  <Link to="/vendedor" className="hidden font-medium hover:text-accent-300 sm:inline">
                    Mi tienda
                  </Link>
                )}
                {usuario?.rol?.tipo_rol === 'administrador' && (
                  <Link to="/admin" className="hidden font-medium hover:text-accent-300 sm:inline">
                    Panel admin
                  </Link>
                )}
                <Link to="/pedidos" className="flex items-center gap-1.5 hover:text-accent-300">
                  <UserIcon className="size-5" />
                  <span className="hidden md:inline">Hola, {usuario?.nombres || '...'}<br className="hidden md:block" />Mis pedidos</span>
                </Link>
                <button onClick={logout} className="text-neutral-300 hover:text-white">
                  Salir
                </button>
              </div>
            ) : (
              <Link to="/login" className="flex items-center gap-1.5 hover:text-accent-300">
                <UserIcon className="size-5" />
                <span>Iniciar sesión</span>
              </Link>
            )}

            <Link to="/carrito" className="relative flex items-center gap-1.5 hover:text-accent-300">
              <CartIcon className="size-6" />
              {cantidadTotal > 0 && (
                <span className="absolute -right-2 -top-2 flex size-5 items-center justify-center rounded-full bg-accent-500 text-xs font-bold text-white">
                  {cantidadTotal}
                </span>
              )}
              <span className="hidden md:inline">Carrito</span>
            </Link>
          </div>
        </div>
      </div>

      <nav className="bg-brand-800 text-white">
        <div className="mx-auto flex max-w-7xl items-center gap-4 overflow-x-auto px-4 py-2 text-sm">
          <Link to="/" className="shrink-0 font-medium hover:text-accent-300">
            Todos los productos
          </Link>
          <Link to="/ofertas" className="shrink-0 font-bold text-accent-400 hover:text-accent-300">
            Ofertas flash
          </Link>
          {categorias.map((cat) => (
            <Link key={cat.id} to={`/?categoriaId=${cat.id}`} className="shrink-0 hover:text-accent-300">
              {cat.categoria}
            </Link>
          ))}
        </div>
      </nav>
    </header>
  );
}
