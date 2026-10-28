import { Link } from 'react-router-dom';
import { IconoRayo } from '../common/iconos';
import { CategoriasCarrusel } from './CategoriasCarrusel';
import { MasVendidosCarrusel } from './MasVendidosCarrusel';
import { OfertasFlashWidget } from './OfertasFlashWidget';
import { RecomendadosCarrusel } from './RecomendadosCarrusel';

// Lo que se ve arriba de la portada, antes del catálogo: la bienvenida y una sección por cada cosa que ofrece la tienda,
// cada una en su carrusel. Cada sección pide lo suyo y falla sola: si una no puede cargar, las demás siguen. `arbol` es el
// árbol de categorías de la consulta del catálogo (no hace falta pedirlo dos veces).
export function Portada({ arbol }) {
  return (
    <div className="flex flex-col gap-8">
      <section className="overflow-hidden rounded-2xl bg-gradient-to-r from-brand-700 to-brand-500 px-6 py-8 text-white sm:px-8 sm:py-12">
        <h1 className="text-2xl font-bold sm:text-4xl">Todo lo que buscás, a un clic.</h1>
        <p className="mt-2 max-w-xl text-brand-100">Explorá el catálogo de TiendaYa — precios claros, envío directo a tu dirección guardada.</p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Link to="/ofertas" className="inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-brand-700 transition-colors hover:bg-brand-50">
            <IconoRayo className="size-4" />
            Ver ofertas flash
          </Link>
          <button
            type="button"
            onClick={() => document.getElementById('catalogo')?.scrollIntoView({ behavior: 'smooth' })}
            className="rounded-lg border border-white/60 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-white/10"
          >
            Explorar el catálogo
          </button>
        </div>
      </section>

      <OfertasFlashWidget />
      <RecomendadosCarrusel />
      <CategoriasCarrusel arbol={arbol} />
      <MasVendidosCarrusel />
    </div>
  );
}
