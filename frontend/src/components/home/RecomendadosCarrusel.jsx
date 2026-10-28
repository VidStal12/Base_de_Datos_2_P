import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { recomendacionesApi } from '../../api/recomendaciones';
import { useAuth } from '../../context/AuthContext';
import { Carrusel } from '../common/Carrusel';
import { IconoCorazon } from '../common/iconos';
import { formatCurrency } from '../../utils/format';
import { SeccionWidget } from './SeccionWidget';

const PANEL = 'rounded-2xl border border-accent-200 bg-accent-50/60 p-4 sm:p-5';

// Tarjeta de un producto recomendado por historial de compras: lleva al flujo de compra con descuento
// (/recomendaciones/:id/comprar) y muestra el precio recomendado junto al normal tachado.
export function TarjetaConDescuento({ producto }) {
  return (
    <Link
      to={`/recomendaciones/${producto.id}/comprar`}
      className="flex h-full flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white transition-shadow hover:shadow-lg"
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

// "Recomendado para vos" (Entrega 2, ver IA/ENTREGA-2-PLAN.md §4.5) — distinto de las ofertas flash normales (/ofertas,
// configuradas a mano por un vendedor sobre SU producto): esto analiza el historial de compras del usuario y encuentra
// productos similares de OTROS vendedores, sin que nadie lo configure. Con sesión iniciada se muestra solo si el análisis
// encontró algo — un comprador sin historial, o cuyo historial no tiene competencia real en el catálogo, simplemente no
// ve esta sección. `key={token}` en quien lo usa: al cambiar de cuenta se vuelve a pedir desde cero.
function RecomendadosDeLaCuenta({ token }) {
  const [datos, setDatos] = useState(undefined); // undefined: pidiendo; null: nada para mostrar

  useEffect(() => {
    let vigente = true;
    recomendacionesApi
      .obtener(token)
      .then((respuesta) => {
        if (vigente) setDatos(respuesta);
      })
      .catch(() => {
        if (vigente) setDatos(null);
      });
    return () => {
      vigente = false;
    };
  }, [token]);

  if (datos === null || (datos && (!datos.tendencia || datos.productos.length === 0))) return null;

  const descripcionTendencia = datos?.tendencia.atributosPreferidos.map((a) => `${a.nombre}: ${a.valor}`).join(', ');

  return (
    <SeccionWidget
      id="recomendados"
      icono={<IconoCorazon className="size-5 text-accent-600" />}
      titulo="Recomendado para vos"
      descripcion={
        datos
          ? `Porque compraste seguido productos con ${descripcionTendencia} — encontramos opciones parecidas, de distintos vendedores.`
          : 'Buscando productos parecidos a lo que ya compraste…'
      }
      className={PANEL}
    >
      <Carrusel etiqueta="Recomendado para vos" cargando={!datos}>
        {datos?.productos.map((producto) => <TarjetaConDescuento key={producto.id} producto={producto} />)}
      </Carrusel>
    </SeccionWidget>
  );
}

// Sin sesión no hay historial que analizar: en vez de esconder la sección se explica qué es y cómo tenerla.
function InvitacionARecomendados() {
  return (
    <section aria-labelledby="recomendados-titulo" className={`flex flex-wrap items-center justify-between gap-3 ${PANEL}`}>
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent-100 text-accent-700">
          <IconoCorazon className="size-5" />
        </span>
        <div className="min-w-0">
          <h2 id="recomendados-titulo" className="text-base font-bold text-neutral-900">
            Recomendado para vos
          </h2>
          <p className="text-sm text-neutral-600">Iniciá sesión y te mostramos productos parecidos a lo que ya compraste, de distintos vendedores.</p>
        </div>
      </div>
      <Link to="/login" className="rounded-lg bg-accent-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-600">
        Iniciar sesión
      </Link>
    </section>
  );
}

export function RecomendadosCarrusel() {
  const { usuario, token } = useAuth();
  return usuario ? <RecomendadosDeLaCuenta key={token} token={token} /> : <InvitacionARecomendados />;
}
