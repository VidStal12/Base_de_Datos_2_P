import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { productosApi } from '../../api/productos';
import { Button } from '../../components/common/Button';
import { FilaEsqueleto } from '../../components/common/Esqueleto';
import { Pagination } from '../../components/search/Pagination';
import { BarraProductos } from '../../components/seller/BarraProductos';
import { FilaProducto } from '../../components/seller/FilaProducto';
import {
  POR_PAGINA,
  POR_PAGINA_INICIAL,
  aParametros,
  conBusqueda,
  conEstado,
  conOrden,
  conPagina,
  conPor,
  conStock,
  conSubcategoria,
  facetas,
  filtrar,
  hayFiltros,
  leerFiltros,
  ordenar,
  paginar,
  sanear,
  sinFiltros,
  tokensDeBusqueda,
} from '../../utils/productosVendedor';

const ESPERA_BUSQUEDA_MS = 250;
const CLAVE_POR_PAGINA = 'tiendaya_vendedor_por_pagina';

// Cuántos productos por página prefiere el vendedor (se recuerda entre visitas). El almacenamiento puede no estar (ventana
// privada, datos del sitio bloqueados): sin él, sirve la URL y el valor por defecto.
function leerPorPaginaGuardado() {
  try {
    const guardado = Number.parseInt(localStorage.getItem(CLAVE_POR_PAGINA), 10);
    return POR_PAGINA.includes(guardado) ? guardado : POR_PAGINA_INICIAL;
  } catch {
    return POR_PAGINA_INICIAL;
  }
}
function guardarPorPagina(por) {
  try {
    localStorage.setItem(CLAVE_POR_PAGINA, String(por));
  } catch {
    /* sin almacenamiento: solo queda en la URL */
  }
}

function textoResumen(pag, conFiltros) {
  if (pag.total === 0) return 'Sin resultados';
  const coinciden = conFiltros ? (pag.total === 1 ? ' que coincide' : ' que coinciden') : '';
  if (pag.paginas > 1) return `Mostrando ${pag.desde}–${pag.hasta} de ${pag.total} productos${coinciden}`;
  return `${pag.total} ${pag.total === 1 ? 'producto' : 'productos'}${coinciden}`;
}

// «Mis productos» del vendedor: la lista se busca, se filtra, se ordena y se pagina (utils/productosVendedor.js). Todo lo que
// se elige vive en la URL —el botón «atrás», un enlace copiado y la vuelta desde «Editar» la encuentran como estaba—;
// lo único que no se escribe en cada tecla es el texto de la búsqueda: se filtra al instante y se pasa a la URL cuando
// la persona se detiene un momento, para no llenar el historial ni pelear con el caret del campo.
export function SellerDashboardPage() {
  const { usuario, token } = useAuth();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [productos, setProductos] = useState([]);
  const [carga, setCarga] = useState('cargando'); // 'cargando' | 'listo' | 'error'
  const [intento, setIntento] = useState(0);
  // id del producto con el historial desplegado — uno solo a la vez, no hace falta un Set acá (no es un caso de uso real
  // ver varios en simultáneo).
  const [historialAbierto, setHistorialAbierto] = useState(null);
  const [porGuardado, setPorGuardado] = useState(leerPorPaginaGuardado);

  const barraRef = useRef(null);
  const inputRef = useRef(null);
  const temporizador = useRef(null);
  const ultimosParametros = useRef(searchParams);

  useEffect(() => {
    if (!usuario) return undefined;
    let vigente = true;
    productosApi
      .listar({ vendedorId: usuario.id_usuario }, token)
      .then((lista) => {
        if (!vigente) return;
        setProductos(lista);
        setCarga('listo');
      })
      .catch(() => {
        if (vigente) setCarga('error');
      });
    return () => {
      vigente = false;
    };
  }, [usuario, token, intento]);

  // ── El estado de la lista ──────────────────────────────────────────────────────────────────────────────────────────
  const filtrosUrl = useMemo(() => leerFiltros(searchParams), [searchParams]);
  const filtros = useMemo(() => sanear(filtrosUrl, productos), [filtrosUrl, productos]);

  // El campo de búsqueda: su texto vive acá y la URL lo sigue con retraso. Si la URL cambia por algo que NO escribimos
  // nosotros (el botón «atrás», un enlace), el campo adopta ese texto — se ajusta durante el render, como indica React.
  const [texto, setTexto] = useState(filtrosUrl.q);
  const [qVista, setQVista] = useState(filtrosUrl.q);
  const [qEscrita, setQEscrita] = useState(filtrosUrl.q);
  if (filtrosUrl.q !== qVista) {
    setQVista(filtrosUrl.q);
    if (filtrosUrl.q !== qEscrita) {
      setQEscrita(filtrosUrl.q);
      setTexto(filtrosUrl.q);
    }
  }
  const textoDiferido = useDeferredValue(texto);

  // Lo que se dibuja: los filtros de la URL con el texto que hay en el campo en este instante.
  const vivos = useMemo(() => ({ ...filtros, q: textoDiferido }), [filtros, textoDiferido]);
  const tokens = useMemo(() => tokensDeBusqueda(vivos.q), [vivos.q]);
  const lista = useMemo(() => ordenar(filtrar(productos, vivos), vivos.orden, tokens), [productos, vivos, tokens]);
  const conteos = useMemo(() => facetas(productos, vivos), [productos, vivos]);
  const por = filtros.por || porGuardado;
  // Mientras el texto escrito no llegó a la URL, la página de la URL no sirve para la búsqueda nueva: arranca en la primera.
  const pag = paginar(lista, textoDiferido === filtros.q ? filtros.pagina : 1, por);
  const conFiltros = hayFiltros(vivos);

  // ── Cambios ────────────────────────────────────────────────────────────────────────────────────────────────────────
  // Siempre se parte de la URL más reciente (no de la del render que creó el temporizador): un cambio de filtro que
  // llegue mientras se espera para escribir el texto no pisa ni es pisado.
  useEffect(() => {
    ultimosParametros.current = searchParams;
  }, [searchParams]);
  useEffect(() => () => clearTimeout(temporizador.current), []);

  const escribir = (transformar, opciones) => {
    const siguientes = aParametros(transformar(leerFiltros(ultimosParametros.current)));
    ultimosParametros.current = new URLSearchParams(siguientes);
    setSearchParams(siguientes, opciones);
  };
  // Los filtros reemplazan la entrada del historial (probar cinco filtros no obliga a pulsar «atrás» cinco veces); las
  // páginas sí suman entrada, para que «atrás» vuelva a la página anterior.
  const cambiar = (transformar) => escribir(transformar, { replace: true });

  const escribirTexto = (valor) => {
    setQEscrita(valor);
    cambiar((f) => conBusqueda(f, valor));
  };
  const alEscribir = (valor) => {
    setTexto(valor);
    clearTimeout(temporizador.current);
    temporizador.current = setTimeout(() => escribirTexto(valor), ESPERA_BUSQUEDA_MS);
  };
  const enviarYa = () => {
    clearTimeout(temporizador.current);
    escribirTexto(texto);
  };
  const borrarTexto = () => {
    clearTimeout(temporizador.current);
    setTexto('');
    escribirTexto('');
    inputRef.current?.focus();
  };
  const limpiar = () => {
    clearTimeout(temporizador.current);
    setTexto('');
    setQEscrita('');
    cambiar(sinFiltros);
  };
  const irAPagina = (pagina) => {
    escribir((f) => conPagina(f, pagina));
    const sinMovimiento = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    barraRef.current?.scrollIntoView({ behavior: sinMovimiento ? 'auto' : 'smooth', block: 'start' });
  };
  const cambiarPor = (valor) => {
    const nuevo = Number(valor);
    guardarPorPagina(nuevo);
    setPorGuardado(nuevo);
    cambiar((f) => conPor(f, nuevo));
  };

  // «/» lleva al buscador desde cualquier parte de la pantalla (como en GitHub o Gmail), salvo mientras se escribe en otro campo.
  useEffect(() => {
    const alPulsar = (e) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const destino = e.target;
      if (destino instanceof HTMLElement && (destino.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(destino.tagName))) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    document.addEventListener('keydown', alPulsar);
    return () => document.removeEventListener('keydown', alPulsar);
  }, []);

  // ── Pantalla ───────────────────────────────────────────────────────────────────────────────────────────────────────
  const encabezado = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-xl font-bold text-neutral-900">
        Mis productos
        {carga === 'listo' && productos.length > 0 && <span className="ml-2 text-base font-normal tabular-nums text-neutral-500">{productos.length}</span>}
      </h1>
      <Button as={Link} to="/vendedor/productos/nuevo" variant="accent">
        + Nuevo producto
      </Button>
    </div>
  );

  if (carga !== 'listo') {
    return (
      <div className="flex flex-col gap-6">
        {encabezado}
        {carga === 'error' ? (
          <div role="alert" className="flex flex-col items-center gap-3 rounded-xl border border-danger-500/40 bg-white p-8 text-center">
            <p className="font-medium text-neutral-800">No pudimos cargar tus productos.</p>
            <p className="text-sm text-neutral-500">Revisá tu conexión e intentá de nuevo.</p>
            <Button
              variant="outline"
              onClick={() => {
                setCarga('cargando');
                setIntento((n) => n + 1);
              }}
            >
              Reintentar
            </Button>
          </div>
        ) : (
          <div aria-busy="true" className="flex flex-col gap-3">
            <p role="status" className="sr-only">
              Cargando tus productos…
            </p>
            {Array.from({ length: 5 }, (_, i) => (
              <FilaEsqueleto key={i} />
            ))}
          </div>
        )}
      </div>
    );
  }

  if (productos.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        {encabezado}
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-neutral-300 p-8 text-center">
          <p className="text-neutral-500">Todavía no publicaste ningún producto.</p>
          <Button as={Link} to="/vendedor/productos/nuevo" variant="accent">
            Publicar mi primer producto
          </Button>
        </div>
      </div>
    );
  }

  const volverA = `${location.pathname}${location.search}`;
  return (
    <div className="flex flex-col gap-4">
      {encabezado}

      <div ref={barraRef} className="scroll-mt-4">
        <BarraProductos
          inputRef={inputRef}
          texto={texto}
          onTexto={alEscribir}
          onEnviar={enviarYa}
          onBorrarTexto={borrarTexto}
          filtros={vivos}
          conteos={conteos}
          onEstado={(valor) => cambiar((f) => conEstado(f, valor))}
          onSubcategoria={(valor) => cambiar((f) => conSubcategoria(f, valor))}
          onStock={(valor) => cambiar((f) => conStock(f, valor))}
          onOrden={(valor) => cambiar((f) => conOrden(f, valor))}
          onLimpiar={limpiar}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm text-neutral-600">
        <p role="status" aria-live="polite">
          {textoResumen(pag, conFiltros)}
        </p>
        {productos.length > POR_PAGINA[0] && (
          <label className="flex items-center gap-2">
            <span>Por página</span>
            <select
              value={pag.por}
              onChange={(e) => cambiarPor(e.target.value)}
              className="rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-sm text-neutral-800 outline-none transition-colors focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            >
              {POR_PAGINA.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {pag.total === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-neutral-300 bg-white p-10 text-center">
          <p className="font-medium text-neutral-800">
            No encontramos productos{vivos.q ? ` para «${vivos.q}»` : ''}
            {vivos.estado || vivos.sub || vivos.stock ? ' con esos filtros' : ''}.
          </p>
          <p className="max-w-md text-sm text-neutral-500">Revisá la ortografía o probá con menos palabras. También podés buscar por número de producto, por ejemplo #12.</p>
          <Button variant="outline" onClick={limpiar}>
            Limpiar filtros
          </Button>
        </div>
      ) : (
        <ul role="list" className="flex flex-col gap-3">
          {pag.items.map((producto) => (
            <FilaProducto
              key={producto.id}
              producto={producto}
              tokens={tokens}
              volverA={volverA}
              historialAbierto={historialAbierto === producto.id}
              onAlternarHistorial={() => setHistorialAbierto(historialAbierto === producto.id ? null : producto.id)}
              token={token}
            />
          ))}
        </ul>
      )}

      <Pagination pagina={pag.pagina} paginas={pag.paginas} onCambiar={irAPagina} />
    </div>
  );
}
