import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

function MenuIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" {...props}>
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

function ChevronIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function CategoryMenu({ categorias }) {
  const [abierto, setAbierto] = useState(false);
  const contenedorRef = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    function alClickearFuera(e) {
      if (contenedorRef.current && !contenedorRef.current.contains(e.target)) {
        setAbierto(false);
      }
    }
    document.addEventListener('mousedown', alClickearFuera);
    return () => document.removeEventListener('mousedown', alClickearFuera);
  }, []);

  function elegir(categoriaId) {
    setAbierto(false);
    navigate(categoriaId ? `/?categoriaId=${categoriaId}` : '/');
  }

  return (
    <div ref={contenedorRef} className="relative shrink-0 self-stretch">
      <button
        type="button"
        onClick={() => setAbierto((v) => !v)}
        aria-haspopup="true"
        aria-expanded={abierto}
        className="flex h-full items-center gap-1.5 rounded-l-lg bg-brand-700 px-3 text-sm font-medium text-white transition-colors hover:bg-brand-600"
      >
        <MenuIcon className="size-4" />
        <span className="hidden sm:inline">Categorías</span>
        <ChevronIcon className={`size-3.5 transition-transform ${abierto ? 'rotate-180' : ''}`} />
      </button>

      {abierto && (
        <div className="absolute left-0 top-full z-40 mt-1 w-56 overflow-hidden rounded-lg bg-white py-1 text-neutral-800 shadow-xl ring-1 ring-black/10">
          <button
            onClick={() => elegir(null)}
            className="block w-full px-4 py-2.5 text-left text-sm font-semibold text-brand-700 hover:bg-brand-50"
          >
            Todas las categorías
          </button>
          <div className="my-1 border-t border-neutral-100" />
          {categorias.map((cat) => (
            <button
              key={cat.id}
              onClick={() => elegir(cat.id)}
              className="block w-full px-4 py-2.5 text-left text-sm hover:bg-brand-50"
            >
              {cat.categoria}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
