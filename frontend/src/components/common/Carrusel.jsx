import { Children, useEffect, useRef, useState } from 'react';
import { IconoChevronDer, IconoChevronIzq, IconoPausa, IconoReproducir } from './iconos';
import { TarjetaEsqueleto } from './Esqueleto';

// Cuántas tarjetas caben a la vez según el ancho de pantalla. Se declara UNA vez en la pista (--n) y cada tarjeta saca
// su ancho de ahí, así un carrusel de categorías puede mostrar más por vista que uno de productos sin repetir la cuenta.
const POR_VISTA = '[--n:2] sm:[--n:3] lg:[--n:4] xl:[--n:5]';
// ancho de una tarjeta = (ancho de la pista − los espacios entre las n tarjetas) ÷ n; el espacio es el gap-3 de la pista
const ANCHO_TARJETA = 'basis-[calc((100%_-_(var(--n)_-_1)_*_0.75rem)_/_var(--n))]';

const REPOSO = { inicio: true, fin: true, paginas: 1, pagina: 0 };

const TONOS = {
  claro: { punto: 'bg-neutral-300', puntoActivo: 'bg-neutral-700', boton: 'text-neutral-500 hover:text-neutral-900' },
  oscuro: { punto: 'bg-white/40', puntoActivo: 'bg-white', boton: 'text-white/80 hover:text-white' },
};

const FLECHA =
  'absolute top-1/2 z-10 hidden size-9 -translate-y-1/2 items-center justify-center rounded-full bg-white text-neutral-700 shadow-md ring-1 ring-neutral-200 transition hover:bg-neutral-50 hover:text-neutral-900 aria-disabled:cursor-default aria-disabled:opacity-40 sm:flex';

const espacioEntre = (pista) => parseFloat(getComputedStyle(pista).columnGap) || 0;
const sinMovimiento = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const desplazar = (pista, izquierda) => pista.scrollTo({ left: izquierda, behavior: sinMovimiento() ? 'auto' : 'smooth' });

// Dónde está la pista: si puede ir a cada lado y en cuántas «páginas» se reparte (una página es lo que cabe de una vez;
// la última puede quedar más corta). Los dos píxeles de tolerancia absorben los decimales del desplazamiento.
function leerPosicion(pista) {
  const maximo = Math.max(0, pista.scrollWidth - pista.clientWidth);
  const paso = pista.clientWidth + espacioEntre(pista);
  const paginas = maximo <= 1 || paso <= 0 ? 1 : Math.ceil(maximo / paso - 0.02) + 1;
  const alFinal = pista.scrollLeft >= maximo - 2;
  const pagina = alFinal ? paginas - 1 : Math.min(paginas - 1, Math.round(pista.scrollLeft / paso));
  return { inicio: pista.scrollLeft <= 2, fin: alFinal, paginas, pagina };
}

// Fila de tarjetas que se desliza: con el dedo en el celular (el navegador encaja cada tarjeta, scroll-snap), con las
// flechas y los puntos en pantallas grandes. Los controles aparecen solo si hay algo que desplazar. Con `autoplayMs` avanza
// sola, pero nunca contra quien la usa: se detiene con el puntero encima, con el foco dentro, un rato después de cada
// gesto, con la pestaña oculta o fuera de la pantalla, con «reducir movimiento» activado, y hay un botón para pausarla.
export function Carrusel({ etiqueta, children, cargando = false, porVista = POR_VISTA, autoplayMs = 0, tono = 'claro' }) {
  const pista = useRef(null);
  const interaccion = useRef({ encima: false, foco: false, ultima: 0 });
  const [posicion, setPosicion] = useState(REPOSO);
  const [pausado, setPausado] = useState(false);
  const colores = TONOS[tono] ?? TONOS.claro;

  const items = cargando ? Array.from({ length: 6 }, (_, i) => <TarjetaEsqueleto key={i} />) : Children.toArray(children);
  const cantidad = items.length;

  // La posición se vuelve a leer al desplazar, al cambiar el ancho de la pista y al cambiar la cantidad de tarjetas (un
  // ResizeObserver no ve crecer el contenido, solo la caja). Va en el cuadro siguiente, no en el instante del evento.
  useEffect(() => {
    const el = pista.current;
    if (!el) return undefined;
    let cuadro = 0;
    const medir = () => {
      cuadro = 0;
      const nueva = leerPosicion(el);
      setPosicion((previa) =>
        previa.inicio === nueva.inicio && previa.fin === nueva.fin && previa.paginas === nueva.paginas && previa.pagina === nueva.pagina ? previa : nueva
      );
    };
    const programar = () => {
      if (!cuadro) cuadro = requestAnimationFrame(medir);
    };
    const observador = new ResizeObserver(programar);
    observador.observe(el);
    el.addEventListener('scroll', programar, { passive: true });
    programar();
    return () => {
      cancelAnimationFrame(cuadro);
      observador.disconnect();
      el.removeEventListener('scroll', programar);
    };
  }, [cantidad]);

  useEffect(() => {
    if (!autoplayMs || pausado || sinMovimiento()) return undefined;
    const el = pista.current;
    if (!el) return undefined;
    let enPantalla = true;
    const observador = new IntersectionObserver(([entrada]) => {
      enPantalla = entrada.isIntersecting;
    });
    observador.observe(el);
    const temporizador = setInterval(() => {
      const { encima, foco, ultima } = interaccion.current;
      if (document.hidden || !enPantalla || encima || foco || Date.now() - ultima < autoplayMs) return;
      const maximo = el.scrollWidth - el.clientWidth;
      if (maximo <= 1) return;
      desplazar(el, el.scrollLeft >= maximo - 2 ? 0 : Math.min(maximo, el.scrollLeft + el.clientWidth + espacioEntre(el)));
    }, autoplayMs);
    return () => {
      clearInterval(temporizador);
      observador.disconnect();
    };
  }, [autoplayMs, pausado]);

  const mover = (sentido) => {
    const el = pista.current;
    if (!el) return;
    const destino = el.scrollLeft + sentido * (el.clientWidth + espacioEntre(el));
    desplazar(el, Math.max(0, Math.min(el.scrollWidth - el.clientWidth, destino)));
  };
  const irAPagina = (n) => {
    const el = pista.current;
    if (!el) return;
    desplazar(el, Math.min(n * (el.clientWidth + espacioEntre(el)), el.scrollWidth - el.clientWidth));
  };
  const hayQueDesplazar = !(posicion.inicio && posicion.fin);
  const marcarGesto = () => {
    interaccion.current.ultima = Date.now();
  };

  return (
    <div
      role="region"
      aria-roledescription="carrusel"
      aria-label={etiqueta}
      aria-busy={cargando || undefined}
      onPointerEnter={() => {
        interaccion.current.encima = true;
      }}
      onPointerLeave={() => {
        interaccion.current.encima = false;
        marcarGesto();
      }}
      onFocus={() => {
        interaccion.current.foco = true;
      }}
      onBlur={() => {
        interaccion.current.foco = false;
        marcarGesto();
      }}
      onPointerDown={marcarGesto}
      onKeyDown={marcarGesto}
      onWheel={marcarGesto}
    >
      <div className="relative">
        {hayQueDesplazar && (
          <>
            <button
              type="button"
              aria-label="Anterior"
              aria-disabled={posicion.inicio}
              onClick={() => !posicion.inicio && mover(-1)}
              className={`${FLECHA} -left-3`}
            >
              <IconoChevronIzq className="size-5" />
            </button>
            <button
              type="button"
              aria-label="Siguiente"
              aria-disabled={posicion.fin}
              onClick={() => !posicion.fin && mover(1)}
              className={`${FLECHA} -right-3`}
            >
              <IconoChevronDer className="size-5" />
            </button>
          </>
        )}
        <ul ref={pista} className={`no-scrollbar -my-2 flex snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain py-2 ${porVista}`}>
          {items.map((item, i) => (
            <li key={item.key ?? i} className={`min-w-0 shrink-0 snap-start ${ANCHO_TARJETA}`}>
              {item}
            </li>
          ))}
        </ul>
      </div>

      {!cargando && (autoplayMs > 0 || posicion.paginas > 1) && (
        <div className="mt-2 flex items-center justify-center gap-1">
          {autoplayMs > 0 && hayQueDesplazar && (
            <button
              type="button"
              onClick={() => setPausado((p) => !p)}
              aria-label={pausado ? 'Reanudar el desplazamiento automático' : 'Pausar el desplazamiento automático'}
              className={`mr-1 grid size-6 place-items-center rounded-full ${colores.boton}`}
            >
              {pausado ? <IconoReproducir className="size-3.5" /> : <IconoPausa className="size-3.5" />}
            </button>
          )}
          {posicion.paginas > 1 &&
            Array.from({ length: posicion.paginas }, (_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => irAPagina(i)}
                aria-label={`Ir a la página ${i + 1} de ${posicion.paginas}`}
                aria-current={i === posicion.pagina ? 'true' : undefined}
                className="grid size-5 place-items-center"
              >
                <span className={`block h-2 rounded-full transition-all ${i === posicion.pagina ? `w-5 ${colores.puntoActivo}` : `w-2 ${colores.punto}`}`} />
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
