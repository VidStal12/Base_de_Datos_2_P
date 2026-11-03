import { Link } from 'react-router-dom';
import { Button } from '../common/Button';
import { HistorialSection } from '../product/HistorialSection';
import { formatCurrency } from '../../utils/format';
import { fragmento, nivelStock } from '../../utils/productosVendedor';
import { Resaltado } from './Resaltado';

function Estado({ estado, className = '' }) {
  return (
    <span
      className={`rounded-full px-2.5 py-1 text-xs font-semibold ${estado === 'activo' ? 'bg-accent-500/10 text-accent-700' : 'bg-neutral-200 text-neutral-600'} ${className}`}
    >
      {estado}
    </span>
  );
}

// Lo que queda de existencias: «Agotado» en rojo, un punto ámbar (y el aviso para lectores de pantalla) cuando quedan pocas.
function Existencias({ producto }) {
  const nivel = nivelStock(producto);
  if (nivel === 'agotado') return <span className="font-semibold text-danger-600">Agotado</span>;
  return (
    <span className="text-neutral-500">
      {nivel === 'poco' && (
        <>
          <span aria-hidden="true" className="mr-1.5 inline-block size-2 rounded-full bg-warning-500" />
          <span className="sr-only">Poco stock: </span>
        </>
      )}
      {producto.inventario?.cantidad ?? 0} en stock
    </span>
  );
}

// Una fila de «Mis productos». El nombre lleva a la edición (como en cualquier panel de vendedor); `volverA` es la lista tal
// como estaba (con su búsqueda y su página) para regresar a ella al guardar. Con una búsqueda activa, si el producto salió
// por algo que la fila no muestra (su descripción o un atributo), se enseña ese trozo con las palabras resaltadas.
export function FilaProducto({ producto, tokens, volverA, historialAbierto, onAlternarHistorial, token }) {
  const editar = `/vendedor/productos/${producto.id}/editar`;
  const extracto = tokens.length > 0 ? fragmento(producto, tokens) : null;
  return (
    <li className="flex flex-col gap-3">
      <div className="rounded-xl border border-neutral-200 bg-white p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3 sm:flex-nowrap">
          <img
            src={producto.imagen_url || 'https://placehold.co/100x100?text=TiendaYa'}
            alt=""
            loading="lazy"
            className="size-14 shrink-0 rounded-lg object-cover sm:size-16"
          />
          <div className="min-w-0 flex-1 basis-40">
            <Link to={editar} state={{ volverA }} className="line-clamp-2 font-medium text-neutral-800 hover:text-brand-700 hover:underline">
              <Resaltado texto={producto.nombre} tokens={tokens} />
            </Link>
            <p className="truncate text-sm text-neutral-500">
              <span className="tabular-nums">#{producto.id}</span> · <Resaltado texto={producto.subcategoria?.subcategoria || 'Sin categoría'} tokens={tokens} />
            </p>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm sm:hidden">
              <span className="font-semibold text-neutral-900">{formatCurrency(producto.inventario?.precio)}</span>
              <Existencias producto={producto} />
              <Estado estado={producto.estado} />
            </p>
          </div>
          <div className="hidden text-right sm:block">
            <p className="font-semibold text-neutral-900">{formatCurrency(producto.inventario?.precio)}</p>
            <p className="text-sm">
              <Existencias producto={producto} />
            </p>
          </div>
          <Estado estado={producto.estado} className="hidden sm:inline-block" />
          <div className="flex w-full shrink-0 items-center justify-end gap-2 sm:w-auto">
            <Button variant="ghost" onClick={onAlternarHistorial} aria-expanded={historialAbierto}>
              {historialAbierto ? 'Ocultar historial' : 'Historial'}
            </Button>
            <Button as={Link} to={editar} state={{ volverA }} variant="outline">
              Editar
            </Button>
          </div>
        </div>
        {extracto && (
          <p className="mt-3 border-t border-neutral-100 pt-2 text-sm text-neutral-600">
            <span className="font-medium text-neutral-700">{extracto.etiqueta}:</span> <Resaltado texto={extracto.texto} tokens={tokens} />
          </p>
        )}
      </div>

      {historialAbierto && (
        <HistorialSection
          productoId={producto.id}
          vendedorId={producto.vendedor_id}
          vendedorNombre={producto.vendedor_nombre}
          subcategoriaNombre={producto.subcategoria?.subcategoria}
          token={token}
        />
      )}
    </li>
  );
}
