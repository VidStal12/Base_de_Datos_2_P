import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { productosApi } from '../../api/productos';
import { formatCurrency } from '../../utils/format';
import { Field, Input } from '../common/Input';
import { Button } from '../common/Button';

const TIPO_LABEL = { creacion: 'Creación', edicion: 'Edición' };

// Preview de cómo se veía el producto en el catálogo en esa fecha — mismo
// lenguaje visual que ProductCard.jsx, pero SIN botón de "Agregar al
// carrito" a propósito: es una vista histórica de solo lectura, no algo
// comprable (el id sigue siendo el del producto actual, comprar "esta
// versión" no tendría sentido). vendedor_nombre/subcategoría no viven en el
// snapshot (no se versionan, ver ADR-003 §3.1) — se toman del producto vigente,
// que es información razonablemente estable (no soporta recategorizar ni
// cambiar de dueño).
function SnapshotPreviewCard({ snapshot, etiqueta, productoId, vendedorNombre, subcategoriaNombre }) {
  const principal = snapshot.imagenes?.find((img) => img.principal) || snapshot.imagenes?.[0];
  const inventario = snapshot.inventario;
  const sinStock = inventario && inventario.cantidad <= 0;

  return (
    <div className="mt-3 overflow-hidden rounded-xl border-2 border-dashed border-brand-200 bg-white">
      <div className="flex items-center justify-between bg-brand-50 px-4 py-2">
        <span className="text-xs font-semibold text-brand-700">Vista histórica del catálogo</span>
        <span className="text-xs text-neutral-500">{etiqueta}</span>
      </div>
      <div className="flex gap-4 p-4">
        <Link to={`/productos/${productoId}`} className="size-24 shrink-0 overflow-hidden rounded-lg bg-neutral-100">
          <img
            src={principal?.url || 'https://placehold.co/200x200?text=TiendaYa'}
            alt={snapshot.descripcion}
            className="size-full object-cover"
          />
        </Link>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {subcategoriaNombre && <span className="text-xs text-neutral-500">{subcategoriaNombre}</span>}
          <Link to={`/productos/${productoId}`} className="line-clamp-2 text-sm font-medium text-neutral-800 hover:text-brand-700">
            {snapshot.descripcion}
          </Link>
          {vendedorNombre && <p className="text-xs text-neutral-500">Vendido por {vendedorNombre}</p>}

          <div className="mt-1 flex flex-wrap items-center gap-2">
            {inventario && <span className="text-lg font-bold text-neutral-900">{formatCurrency(inventario.precio)}</span>}
            {inventario &&
              (sinStock ? (
                <span className="rounded-full bg-danger-500/10 px-2 py-0.5 text-xs font-semibold text-danger-600">Agotado</span>
              ) : (
                <span className="rounded-full bg-accent-500/10 px-2 py-0.5 text-xs font-semibold text-accent-700">
                  {inventario.cantidad} en stock
                </span>
              ))}
            <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600">{snapshot.estado}</span>
          </div>

          {snapshot.atributos?.length > 0 && (
            <p className="mt-1 text-xs text-neutral-500">
              {snapshot.atributos.map((a) => `${a.nombre}: ${a.valor}`).join(' · ')}
            </p>
          )}
          {!inventario && (
            <p className="mt-1 text-xs text-neutral-400">Este evento es anterior a que se empezara a registrar precio/stock.</p>
          )}
        </div>
      </div>
    </div>
  );
}

// Historial de cambios por eventos (ver ADR-003) — línea de tiempo completa
// más reconstrucción del estado en una fecha arbitraria. Compartido entre
// ProductDetailPage (vista del comprador filtrada por rol) y los paneles de
// vendedor/administrador (donde no hace falta filtrar: si pueden ver el
// panel, ya tienen el rol correcto).
export function HistorialSection({ productoId, vendedorId, vendedorNombre, subcategoriaNombre, token }) {
  const [eventos, setEventos] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [fecha, setFecha] = useState('');
  const [snapshot, setSnapshot] = useState(null);
  const [etiqueta, setEtiqueta] = useState('');
  const [errorFecha, setErrorFecha] = useState('');
  const [consultando, setConsultando] = useState(false);
  const [versionSeleccionada, setVersionSeleccionada] = useState(null);

  useEffect(() => {
    setCargando(true);
    productosApi
      .historial(productoId, token)
      .then(setEventos)
      .catch(() => setEventos([]))
      .finally(() => setCargando(false));
  }, [productoId, token]);

  async function handleConsultar(e) {
    e.preventDefault();
    if (!fecha) return;
    setConsultando(true);
    setErrorFecha('');
    setSnapshot(null);
    setVersionSeleccionada(null);
    try {
      const resultado = await productosApi.historialEnFecha(productoId, fecha, token);
      setSnapshot(resultado);
      // timeZone: 'UTC' a propósito: el <input type="date"> da "AAAA-MM-DD" sin
      // hora, que Date() interpreta como medianoche UTC — formatear en la zona
      // horaria local podía mostrarlo como el día anterior.
      setEtiqueta(`al ${new Date(fecha).toLocaleDateString('es-GT', { dateStyle: 'long', timeZone: 'UTC' })}`);
    } catch (err) {
      setErrorFecha(err.message);
    } finally {
      setConsultando(false);
    }
  }

  // Ver una versión puntual del historial directamente, sin pasar por el
  // formulario de fecha — necesario porque ese formulario solo tiene
  // granularidad de día: si un producto tuvo dos ediciones el mismo día,
  // buscar por esa fecha solo puede devolver la última, nunca la de en medio.
  // El snapshot ya está en `eventos` (vino con la línea de tiempo completa),
  // así que esto no pide nada nuevo al backend.
  function verVersion(ev) {
    setErrorFecha('');
    setSnapshot(ev.snapshot);
    setEtiqueta(`versión ${ev.version} — ${new Date(ev.fecha).toLocaleString('es-GT', { dateStyle: 'medium', timeStyle: 'short' })}`);
    setVersionSeleccionada(ev._id);
  }

  if (cargando) return null;
  if (eventos.length === 0) return null;

  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-6">
      <h2 className="mb-4 text-lg font-bold text-neutral-900">Historial de cambios</h2>

      <ul className="flex flex-col gap-1">
        {eventos.map((ev) => (
          <li key={ev._id} className="border-l-2 border-neutral-200">
            <button
              type="button"
              onClick={() => verVersion(ev)}
              className={`w-full rounded-r-lg py-3 pl-4 pr-2 text-left transition-colors hover:bg-neutral-50 ${
                versionSeleccionada === ev._id ? 'bg-brand-50' : ''
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                    ev.tipo === 'creacion' ? 'bg-brand-500/10 text-brand-700' : 'bg-accent-500/10 text-accent-700'
                  }`}
                >
                  {TIPO_LABEL[ev.tipo] || ev.tipo}
                </span>
                <span className="text-xs text-neutral-500">v{ev.version}</span>
                <span className="text-xs text-neutral-400">
                  {new Date(ev.fecha).toLocaleString('es-GT', { dateStyle: 'medium', timeStyle: 'short' })}
                </span>
                <span className="text-xs text-neutral-400">
                  · {ev.usuario_id === vendedorId ? 'por el vendedor' : `por otro usuario (#${ev.usuario_id})`}
                </span>
              </div>
              {ev.campos_modificados?.length > 0 && (
                <p className="mt-1 text-xs text-neutral-500">Cambió: {ev.campos_modificados.join(', ')}</p>
              )}
              <p className="mt-1 text-sm text-neutral-700">{ev.snapshot.descripcion}</p>
              {ev.snapshot.inventario && (
                <p className="mt-0.5 text-xs text-neutral-500">
                  {formatCurrency(ev.snapshot.inventario.precio)} · {ev.snapshot.inventario.cantidad} en stock (en ese momento)
                </p>
              )}
              <span className="mt-1 inline-block text-xs font-medium text-brand-700">Ver esta versión →</span>
            </button>
          </li>
        ))}
      </ul>

      <div className="mt-6 border-t border-neutral-100 pt-4">
        <h3 className="mb-2 text-sm font-semibold text-neutral-800">Ver estado en una fecha</h3>
        <p className="mb-2 text-xs text-neutral-500">
          Solo tiene granularidad de día — si hubo más de una edición el mismo día, esto devuelve la última. Para ver una
          versión específica, hacé clic en ella arriba.
        </p>
        <form onSubmit={handleConsultar} className="flex flex-wrap items-end gap-2">
          <Field label="Fecha">
            <Input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} required />
          </Field>
          <Button type="submit" variant="outline" disabled={consultando}>
            {consultando ? 'Consultando...' : 'Consultar'}
          </Button>
        </form>

        {errorFecha && <p className="mt-2 text-sm text-danger-600">{errorFecha}</p>}

        {snapshot && (
          <SnapshotPreviewCard
            snapshot={snapshot}
            etiqueta={etiqueta}
            productoId={productoId}
            vendedorNombre={vendedorNombre}
            subcategoriaNombre={subcategoriaNombre}
          />
        )}
      </div>
    </div>
  );
}
