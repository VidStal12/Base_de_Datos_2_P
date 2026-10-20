import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useCart } from '../../context/CartContext';
import { categoriasApi } from '../../api/productos';
import { busquedaApi } from '../../api/busqueda';
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
  const [sugerencias, setSugerencias] = useState([]);
  const [mostrarSugerencias, setMostrarSugerencias] = useState(false);
  const [indiceActivo, setIndiceActivo] = useState(-1);
  const buscadorRef = useRef(null);
  const consultaRef = useRef(0);
  const ultimaBusquedaRef = useRef(searchParams.get('q') || '');

  useEffect(() => {
    categoriasApi.listar().then(setCategorias).catch(() => setCategorias([]));
  }, []);

  // Mismo patrón de "clic afuera cierra" que CategoryMenu.jsx (mousedown +
  // contains), no onBlur — onBlur del input dispararía antes que el onClick
  // de una sugerencia y la cerraría antes de poder seleccionarla.
  useEffect(() => {
    function alClickearFuera(e) {
      if (buscadorRef.current && !buscadorRef.current.contains(e.target)) {
        setMostrarSugerencias(false);
      }
    }
    document.addEventListener('mousedown', alClickearFuera);
    return () => document.removeEventListener('mousedown', alClickearFuera);
  }, []);

  // Autocompletado (ver IA/PLAN-ELASTICSEARCH-BUSQUEDA.md §12) — debounce de
  // 250ms para no pegarle a /busqueda/sugerencias en cada tecla. consultaRef
  // descarta respuestas que ya quedaron viejas si una tecla más nueva
  // disparó otra consulta que resuelve primero (fetch no garantiza orden).
  // ultimaBusquedaRef evita reabrir el dropdown justo después de ejecutar una
  // búsqueda (seleccionar una sugerencia deja ese mismo texto en el input,
  // que sin este chequeo dispararía este mismo efecto y volvería a mostrar
  // sugerencias sobre la página de resultados que el usuario ya pidió ver).
  useEffect(() => {
    const texto = busqueda.trim();
    if (texto.length < 2 || texto === ultimaBusquedaRef.current) {
      setSugerencias([]);
      return;
    }
    const idConsulta = ++consultaRef.current;
    const temporizador = setTimeout(() => {
      busquedaApi
        .sugerir(texto)
        .then((data) => {
          if (idConsulta !== consultaRef.current) return;
          setSugerencias(data.sugerencias || []);
          setMostrarSugerencias(true);
          setIndiceActivo(-1);
        })
        .catch(() => {
          if (idConsulta === consultaRef.current) setSugerencias([]);
        });
    }, 250);
    return () => clearTimeout(temporizador);
  }, [busqueda]);

  function ejecutarBusqueda(texto) {
    ultimaBusquedaRef.current = texto.trim();
    setMostrarSugerencias(false);
    const params = new URLSearchParams();
    if (texto.trim()) params.set('q', texto.trim());
    navigate(`/?${params.toString()}`);
  }

  function handleSearch(e) {
    e.preventDefault();
    ejecutarBusqueda(busqueda);
  }

  function seleccionarSugerencia(texto) {
    setBusqueda(texto);
    ejecutarBusqueda(texto);
  }

  function handleSearchKeyDown(e) {
    if (!mostrarSugerencias || sugerencias.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndiceActivo((i) => (i + 1) % sugerencias.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndiceActivo((i) => (i <= 0 ? sugerencias.length - 1 : i - 1));
    } else if (e.key === 'Enter' && indiceActivo >= 0) {
      e.preventDefault();
      seleccionarSugerencia(sugerencias[indiceActivo]);
    } else if (e.key === 'Escape') {
      setMostrarSugerencias(false);
    }
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
            <form ref={buscadorRef} onSubmit={handleSearch} className="relative flex min-w-0 flex-1">
              <input
                type="search"
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                onFocus={() => sugerencias.length > 0 && setMostrarSugerencias(true)}
                placeholder="Buscar productos..."
                autoComplete="off"
                role="combobox"
                aria-expanded={mostrarSugerencias && sugerencias.length > 0}
                aria-autocomplete="list"
                className="w-full min-w-0 border-0 border-l border-brand-600 px-4 py-2.5 text-white placeholder-neutral-400 focus:outline-2 focus:outline-accent-500"
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

              {mostrarSugerencias && sugerencias.length > 0 && (
                <div
                  role="listbox"
                  className="absolute left-0 right-0 top-full z-40 mt-1 overflow-hidden rounded-lg bg-white py-1 text-neutral-800 shadow-xl ring-1 ring-black/10"
                >
                  {sugerencias.map((s, i) => (
                    <button
                      key={s}
                      type="button"
                      role="option"
                      aria-selected={i === indiceActivo}
                      onClick={() => seleccionarSugerencia(s)}
                      className={`block w-full px-4 py-2.5 text-left text-sm ${i === indiceActivo ? 'bg-brand-50' : 'hover:bg-brand-50'}`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
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
