import { Link } from 'react-router-dom';
import { Carrusel } from '../common/Carrusel';
import { IconoCuadricula } from '../common/iconos';
import { SeccionWidget } from './SeccionWidget';
import { FILTROS_VACIOS, aParametros, conCategoria } from '../../utils/filtrosBusqueda';

const POR_VISTA = '[--n:2] sm:[--n:3] lg:[--n:4] xl:[--n:6]';
// Un tono distinto por baldosa, que se repite: sin una imagen por categoría, el color ayuda a distinguirlas de un vistazo.
const TONOS = [
  'from-brand-50 to-brand-100 text-brand-800 hover:from-brand-100 hover:to-brand-200',
  'from-accent-50 to-accent-100 text-accent-800 hover:from-accent-100 hover:to-accent-200',
  'from-neutral-100 to-neutral-200 text-neutral-800 hover:from-neutral-200 hover:to-neutral-300',
  'from-brand-100 to-accent-100 text-brand-800 hover:from-brand-200 hover:to-accent-200',
];

const alCatalogo = (categoriaId) => `/?${new URLSearchParams(aParametros(conCategoria(FILTROS_VACIOS, categoriaId)))}`;

// Comprá por categoría: una baldosa por categoría con productos, a partir del árbol que ya trae GET /api/busqueda
// (`arbol`, con conteos). Cada una es un enlace a la portada filtrada por esa categoría: se puede abrir en otra pestaña.
// Mientras la consulta no volvió (`arbol` sin definir) se dibujan baldosas vacías; si no hay categorías, no se dibuja nada.
export function CategoriasCarrusel({ arbol }) {
  const categorias = (arbol ?? []).filter((categoria) => categoria.cantidad > 0);
  if (arbol && categorias.length === 0) return null;
  const subcategoriasCon = (categoria) => categoria.subcategorias.filter((sub) => sub.cantidad > 0).length;

  return (
    <SeccionWidget id="categorias" icono={<IconoCuadricula className="size-5 text-brand-600" />} titulo="Comprá por categoría" descripcion="Elegí un rubro y seguí filtrando desde ahí.">
      <Carrusel etiqueta="Categorías" porVista={POR_VISTA}>
        {arbol
          ? categorias.map((categoria, i) => (
              <Link
                key={categoria.id}
                to={alCatalogo(categoria.id)}
                onClick={() => window.scrollTo({ top: 0 })}
                className={`flex h-full min-h-28 flex-col justify-between gap-3 rounded-xl bg-gradient-to-br p-4 transition hover:shadow-md ${TONOS[i % TONOS.length]}`}
              >
                <span className="text-base font-bold leading-tight">{categoria.nombre}</span>
                <span className="text-xs font-medium opacity-80">
                  {categoria.cantidad} {categoria.cantidad === 1 ? 'producto' : 'productos'}
                  {subcategoriasCon(categoria) > 0 && ` · ${subcategoriasCon(categoria)} ${subcategoriasCon(categoria) === 1 ? 'subcategoría' : 'subcategorías'}`}
                </span>
              </Link>
            ))
          : Array.from({ length: 6 }, (_, i) => <div key={i} aria-hidden="true" className="h-28 rounded-xl bg-neutral-200 motion-safe:animate-pulse" />)}
      </Carrusel>
    </SeccionWidget>
  );
}
