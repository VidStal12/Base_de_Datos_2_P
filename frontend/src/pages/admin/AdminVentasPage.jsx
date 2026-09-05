import { useEffect, useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { ventasApi } from '../../api/ventas';
import { Button } from '../../components/common/Button';
import { Spinner } from '../../components/common/Spinner';
import { formatCurrency } from '../../utils/format';

const ZONA_HORARIA = 'America/Guatemala';
const DIA_MS = 86400000;
const numero = new Intl.NumberFormat('es-GT', { maximumFractionDigits: 0 });
const porcentaje = new Intl.NumberFormat('es-GT', { maximumFractionDigits: 1 });
const controlClase = 'w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus:border-brand-500 focus:outline-brand-500';

// La fecha comercial depende de Guatemala, aunque el navegador esté en otra zona.
function fechaHoy() {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONA_HORARIA, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const valor = (tipo) => partes.find((parte) => parte.type === tipo).value;
  return `${valor('year')}-${valor('month')}-${valor('day')}`;
}

// Se opera en UTC solo para sumar días de calendario sin depender del navegador.
function sumarDias(fecha, dias) {
  return new Date(Date.parse(`${fecha}T00:00:00Z`) + dias * DIA_MS).toISOString().slice(0, 10);
}

function filtrosIniciales() {
  const hasta = sumarDias(fechaHoy(), -1);
  return { desde: sumarDias(hasta, -6), hasta, intervalo: 'dia', productoId: '', minUnidades: 5 };
}

function fechaCorta(fecha) {
  return new Date(`${fecha}T00:00:00Z`).toLocaleDateString('es-GT', {
    timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric',
  });
}

function rango(desde, hasta) {
  return `${fechaCorta(desde)} al ${fechaCorta(hasta)}`;
}

function variacion(valor) {
  return valor === null || valor === undefined
    ? 'Sin ventas previas'
    : `${valor > 0 ? '+' : ''}${porcentaje.format(valor)} %`;
}

// Valida antes de consultar; el servidor vuelve a comprobar estos mismos límites.
function validarFiltros(filtros) {
  if (!filtros.desde || !filtros.hasta) return 'Selecciona las fechas de inicio y fin.';
  if (filtros.desde < '1970-01-01') return 'Selecciona fechas a partir del 1 de enero de 1970.';
  if (filtros.desde > filtros.hasta) return 'La fecha inicial debe ser anterior o igual a la fecha final.';
  if (filtros.hasta > fechaHoy()) return 'No se pueden consultar fechas futuras.';
  const dias = (Date.parse(`${filtros.hasta}T00:00:00Z`) - Date.parse(`${filtros.desde}T00:00:00Z`)) / DIA_MS + 1;
  if (!Number.isFinite(dias) || dias > 90) return 'Selecciona un período de hasta 90 días, incluyendo ambas fechas.';
  if (sumarDias(filtros.desde, -dias) < '1970-01-01') return 'El período anterior usado para comparar también debe comenzar a partir de 1970.';
  if (!Number.isSafeInteger(Number(filtros.minUnidades)) || Number(filtros.minUnidades) < 1 || Number(filtros.minUnidades) > 1000000) {
    return 'El mínimo de unidades debe ser un número entero entre 1 y 1,000,000.';
  }
  return '';
}

function Indicador({ titulo, valor, detalle }) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-5">
      <dt className="text-sm text-neutral-600">{titulo}</dt>
      <dd className="mt-2 text-2xl font-bold tracking-tight text-neutral-900">{valor}</dd>
      {detalle && <dd className="mt-2 text-xs text-neutral-500">{detalle}</dd>}
    </div>
  );
}

function GraficaVentas({ serie, intervalo }) {
  const [metrica, setMetrica] = useState('unidades');
  const [activo, setActivo] = useState(null);
  const id = useId();
  const esIngreso = metrica === 'ingresos';
  const etiqueta = esIngreso ? 'Ingresos (Q)' : 'Unidades vendidas';
  const formato = esIngreso ? formatCurrency : (valor) => numero.format(valor);
  const ancho = 800;
  const alto = 290;
  const margen = { izquierda: 76, derecha: 24, arriba: 26, abajo: 56 };
  const anchoUtil = ancho - margen.izquierda - margen.derecha;
  const altoUtil = alto - margen.arriba - margen.abajo;
  // Una escala mínima de uno conserva el gráfico legible cuando todos los valores son cero.
  const maximo = Math.max(1, ...serie.map((punto) => Number(punto[metrica])));
  const puntos = serie.map((punto, indice) => ({
    ...punto,
    x: margen.izquierda + (serie.length === 1 ? anchoUtil / 2 : indice * anchoUtil / (serie.length - 1)),
    y: margen.arriba + altoUtil * (1 - Number(punto[metrica]) / maximo),
  }));
  const seleccionado = activo === null ? null : puntos[activo];
  const saltosEtiquetas = Math.max(1, Math.ceil(serie.length / 5));
  const nombreIntervalo = { dia: 'día', semana: 'semana', mes: 'mes' }[intervalo];
  const hayVentas = serie.some((punto) => punto.unidades > 0);

  return (
    <section aria-labelledby={`${id}-heading`} className="rounded-xl border border-neutral-200 bg-white p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id={`${id}-heading`} className="font-semibold text-neutral-900">Evolución de ventas</h2>
          <p className="mt-1 text-sm text-neutral-500">Totales por {nombreIntervalo}, dentro de las fechas elegidas.</p>
        </div>
        <div role="group" aria-label="Medida del gráfico" className="flex rounded-lg border border-neutral-200 p-1">
          {[['unidades', 'Unidades'], ['ingresos', 'Ingresos']].map(([valor, texto]) => (
            <button
              key={valor}
              type="button"
              aria-pressed={metrica === valor}
              onClick={() => { setMetrica(valor); setActivo(null); }}
              className={`rounded-md px-3 py-2 text-sm font-medium focus-visible:outline-brand-600 ${metrica === valor ? 'bg-brand-600 text-white' : 'text-neutral-600 hover:bg-neutral-100'}`}
            >
              {texto}
            </button>
          ))}
        </div>
      </div>

      {!hayVentas && <p className="mt-4 rounded-lg bg-neutral-50 p-3 text-sm text-neutral-600">No hay ventas pagadas para estos filtros.</p>}
      {serie.length > 0 && (
        <>
          {/* El SVG se adapta al ancho y cada punto tiene información al pasar el cursor.
              La tabla inferior ofrece los mismos valores sin depender de la gráfica. */}
          <svg viewBox={`0 0 ${ancho} ${alto}`} className="mt-4 block w-full text-brand-600" role="img" aria-labelledby={`${id}-title ${id}-desc`}>
            <title id={`${id}-title`}>{etiqueta} por {nombreIntervalo}</title>
            <desc id={`${id}-desc`}>Ventas dentro del período seleccionado. Los valores completos están disponibles en la tabla de datos que sigue al gráfico.</desc>
            {[0, 0.25, 0.5, 0.75, 1].map((fraccion) => {
              const y = margen.arriba + altoUtil * (1 - fraccion);
              return (
                <g key={fraccion}>
                  <line x1={margen.izquierda} y1={y} x2={ancho - margen.derecha} y2={y} stroke="#e5e5e5" />
                  <text x={margen.izquierda - 10} y={y + 4} textAnchor="end" fill="#525252" fontSize="12">
                    {new Intl.NumberFormat('es-GT', { notation: 'compact', maximumFractionDigits: 1 }).format(maximo * fraccion)}
                  </text>
                </g>
              );
            })}
            <text x={margen.izquierda} y="14" fill="#525252" fontSize="12">{etiqueta}</text>
            <polyline points={puntos.map((punto) => `${punto.x},${punto.y}`).join(' ')} fill="none" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" />
            {puntos.map((punto, indice) => (
              <g key={punto.periodo}>
                <circle cx={punto.x} cy={punto.y} r={serie.length > 45 ? 2.5 : 4} fill="currentColor" />
                <circle
                  cx={punto.x} cy={punto.y} r="10" fill="transparent"
                  onMouseEnter={() => setActivo(indice)} onMouseLeave={() => setActivo(null)}
                  onFocus={() => setActivo(indice)} onBlur={() => setActivo(null)}
                  tabIndex="0" aria-label={`${fechaCorta(punto.periodo)}: ${formato(punto[metrica])}`}
                >
                  <title>{fechaCorta(punto.periodo)}: {formato(punto[metrica])}</title>
                </circle>
                {(indice % saltosEtiquetas === 0 || indice === puntos.length - 1) && (
                  <text x={punto.x} y={alto - 27} textAnchor={indice === puntos.length - 1 ? 'end' : 'middle'} fill="#525252" fontSize="11">
                    {fechaCorta(punto.periodo).replace(/ de /g, ' ').replace(/ 20\d\d$/, '')}
                  </text>
                )}
              </g>
            ))}
          </svg>
          <p className="min-h-6 text-center text-sm text-neutral-600" aria-live="polite">
            {seleccionado ? `${fechaCorta(seleccionado.periodo)} · ${formato(seleccionado[metrica])}${esIngreso ? '' : ' unidades'}` : 'Selecciona un punto o consulta la tabla para ver los valores.'}
          </p>
          <details className="mt-4 border-t border-neutral-100 pt-4">
            <summary className="cursor-pointer text-sm font-medium text-brand-700">Ver tabla de datos del gráfico</summary>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Ventas agrupadas por {nombreIntervalo} en el período seleccionado</caption>
                <thead className="border-b border-neutral-200 text-neutral-600">
                  <tr><th scope="col" className="px-3 py-2">Inicio del intervalo</th><th scope="col" className="px-3 py-2 text-right">Unidades</th><th scope="col" className="px-3 py-2 text-right">Ingresos</th><th scope="col" className="px-3 py-2 text-right">Pedidos</th></tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {serie.map((fila) => (
                    <tr key={fila.periodo}><th scope="row" className="px-3 py-2 font-normal">{fechaCorta(fila.periodo)}</th><td className="px-3 py-2 text-right">{numero.format(fila.unidades)}</td><td className="px-3 py-2 text-right">{formatCurrency(fila.ingresos)}</td><td className="px-3 py-2 text-right">{numero.format(fila.pedidos)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}

export function AdminVentasPage() {
  const { token } = useAuth();
  const [borrador, setBorrador] = useState(filtrosIniciales);
  const [filtros, setFiltros] = useState(() => ({ ...borrador }));
  const [recarga, setRecarga] = useState(0);
  const [respuesta, setRespuesta] = useState(null);
  const [productos, setProductos] = useState([]);
  const [errorFiltros, setErrorFiltros] = useState('');

  // La respuesta pertenece a una consulta concreta. Al cambiar filtros, sesión
  // o recarga, la pantalla pasa a carga sin mostrar un instante datos anteriores.
  const cargando = !respuesta || respuesta.filtros !== filtros || respuesta.recarga !== recarga || respuesta.token !== token;
  const datos = cargando ? null : respuesta.datos;
  const error = cargando ? '' : respuesta.error;

  useEffect(() => {
    // El cierre de cada consulta invalida su respuesta al cambiar filtros o salir.
    // Así una respuesta lenta nunca reemplaza los resultados de una consulta nueva.
    let vigente = true;
    ventasApi.consultar(filtros, token)
      .then((resultado) => {
        if (!vigente) return;
        setRespuesta({ filtros, recarga, token, datos: resultado, error: '' });
        setProductos(resultado.productos);
      })
      .catch((causa) => {
        if (vigente) setRespuesta({ filtros, recarga, token, datos: null,
          error: causa.message || 'No se pudieron cargar las ventas. Inténtalo nuevamente.' });
      });
    return () => { vigente = false; };
  }, [filtros, recarga, token]);

  // La opción seleccionada permanece visible aunque no tenga ventas en otro rango.
  const opcionesProductos = useMemo(() => {
    const opciones = [...productos];
    if (borrador.productoId && !opciones.some((producto) => String(producto.id) === String(borrador.productoId))) {
      opciones.push({ id: Number(borrador.productoId), descripcion: `Producto #${borrador.productoId} (sin ventas en el rango)` });
    }
    return opciones;
  }, [productos, borrador.productoId]);

  function cambiar(campo, valor) {
    setBorrador((actual) => ({ ...actual, [campo]: valor }));
    setErrorFiltros('');
  }

  function aplicar(evento) {
    evento.preventDefault();
    const mensaje = validarFiltros(borrador);
    setErrorFiltros(mensaje);
    if (mensaje) return;
    setFiltros({ ...borrador, minUnidades: Number(borrador.minUnidades) });
  }

  const hoy = fechaHoy();
  const cambioPendiente = Object.keys(filtros).some((campo) => String(filtros[campo]) !== String(borrador[campo]));

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to="/admin" className="text-sm text-brand-700 hover:underline">← Panel de administrador</Link>
          <h1 className="mt-2 text-2xl font-bold text-neutral-900">Ventas y demanda</h1>
          <p className="mt-2 max-w-2xl text-sm text-neutral-600">Observa las ventas pagadas y encuentra los productos cuyas unidades vendidas aumentaron frente al período anterior.</p>
        </div>
        <Button type="button" variant="outline" disabled={cargando} onClick={() => setRecarga((valor) => valor + 1)}>Actualizar datos</Button>
      </header>

      <form onSubmit={aplicar} className="rounded-xl border border-neutral-200 bg-white p-4 sm:p-6" aria-label="Filtros de ventas" aria-describedby="ayuda-filtros-ventas">
        <div className="grid items-end gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <label className="flex flex-col gap-1.5 text-sm font-medium text-neutral-700">Desde
            <input type="date" required min="1970-01-01" max={hoy} className={controlClase} value={borrador.desde} onChange={(evento) => cambiar('desde', evento.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium text-neutral-700">Hasta
            <input type="date" required max={hoy} min={borrador.desde || undefined} className={controlClase} value={borrador.hasta} onChange={(evento) => cambiar('hasta', evento.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium text-neutral-700">Agrupar ventas por
            <select className={controlClase} value={borrador.intervalo} onChange={(evento) => cambiar('intervalo', evento.target.value)}>
              <option value="dia">Día</option><option value="semana">Semana</option><option value="mes">Mes</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium text-neutral-700">Producto
            <select className={controlClase} value={borrador.productoId} onChange={(evento) => cambiar('productoId', evento.target.value)}>
              <option value="">Todos los productos</option>
              {opcionesProductos.map((producto) => <option key={producto.id} value={producto.id}>{producto.descripcion}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium text-neutral-700">Mínimo de unidades para el ranking
            <input type="number" min="1" max="1000000" step="1" required className={controlClase} value={borrador.minUnidades} onChange={(evento) => cambiar('minUnidades', evento.target.value)} />
          </label>
          <Button type="submit" disabled={cargando}>Aplicar filtros</Button>
        </div>
        <p id="ayuda-filtros-ventas" className="mt-4 text-xs leading-relaxed text-neutral-500">Ambas fechas están incluidas. Máximo 90 días. Horario de Guatemala (UTC−6). El mínimo de unidades solo afecta el ranking.</p>
        {cambioPendiente && <p className="mt-2 text-sm text-brand-700">Hay cambios en los filtros pendientes de aplicar.</p>}
        {errorFiltros && <p role="alert" className="mt-3 text-sm text-danger-600">{errorFiltros}</p>}
      </form>

      {/* Los fallos y la carga se muestran separados del resultado para no presentar
          ceros o datos de una consulta anterior como si fueran ventas confirmadas. */}
      <div aria-live="polite" aria-busy={cargando}>
        {cargando && <div className="flex items-center gap-3 rounded-xl border border-neutral-200 bg-white p-6"><Spinner /><p className="text-sm text-neutral-600">Consultando ventas…</p></div>}
        {error && <div role="alert" className="rounded-xl border border-danger-500/30 bg-danger-500/10 p-5"><p className="font-medium text-danger-600">No se pudieron consultar las ventas</p><p className="mt-1 text-sm text-danger-600">{error}</p><Button type="button" variant="outline" className="mt-3" onClick={() => setRecarga((valor) => valor + 1)}>Reintentar</Button></div>}
      </div>

      {!cargando && !error && datos && (
        <>
          <div className="text-sm text-neutral-600">
            <p><span className="font-medium text-neutral-900">Período consultado:</span> {rango(datos.filtros.desde, datos.filtros.hasta)}</p>
            <p className="mt-1"><span className="font-medium text-neutral-900">Comparado con:</span> {rango(datos.comparacion.desde, datos.comparacion.hasta)} (misma cantidad de días).</p>
            {datos.filtros.productoId && <p className="mt-1">Producto: {opcionesProductos.find((producto) => producto.id === datos.filtros.productoId)?.descripcion || `Producto #${datos.filtros.productoId}`}</p>}
            {datos.filtros.hasta === hoy && <p className="mt-2 rounded-lg bg-amber-50 p-3 text-amber-800">El período incluye hoy y todavía puede recibir ventas. Su crecimiento es provisional hasta que termine el día.</p>}
          </div>

          {datos.advertencias.length > 0 && <ul className="list-inside list-disc rounded-xl bg-amber-50 p-4 text-sm text-amber-800">{datos.advertencias.map((advertencia, indice) => <li key={indice}>{advertencia}</li>)}</ul>}

          <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Indicador titulo="Ingresos" valor={formatCurrency(datos.resumen.ingresos)} detalle="Importe final de los productos vendidos" />
            <Indicador titulo="Unidades vendidas" valor={numero.format(datos.resumen.unidades)} detalle={`Período anterior: ${numero.format(datos.resumen.unidadesAnteriores)}`} />
            <Indicador titulo="Pedidos" valor={numero.format(datos.resumen.pedidos)} detalle="Compras distintas con ventas en estos filtros" />
            <Indicador titulo="Cambio en unidades" valor={variacion(datos.resumen.crecimientoPorcentaje)} detalle="Frente al período anterior" />
          </dl>

          <GraficaVentas serie={datos.serie} intervalo={datos.filtros.intervalo} />

          <section aria-labelledby="ranking-ventas-titulo" className="overflow-hidden rounded-xl border border-neutral-200 bg-white">
            <div className="p-4 sm:p-6">
              <h2 id="ranking-ventas-titulo" className="font-semibold text-neutral-900">Productos en ascenso</h2>
              <p className="mt-2 text-sm text-neutral-600">Las unidades vendidas son un indicador de demanda. Se muestran productos con aumento y al menos {numero.format(datos.filtros.minUnidades)} unidades en el período consultado.</p>
              <p className="mt-1 text-xs text-neutral-500">“Sin ventas previas” indica que no hay una base para calcular el porcentaje de crecimiento.</p>
            </div>
            {datos.tendencias.length === 0 ? (
              <p className="mx-4 mb-6 rounded-lg border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 sm:mx-6">Ningún producto cumple el aumento y el mínimo de unidades de estos filtros.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <caption className="sr-only">Productos cuya demanda aumentó. Período actual: {rango(datos.filtros.desde, datos.filtros.hasta)}. Período anterior: {rango(datos.comparacion.desde, datos.comparacion.hasta)}.</caption>
                  <thead className="border-y border-neutral-200 bg-neutral-50 text-neutral-600">
                    <tr>
                      <th scope="col" className="px-5 py-3">Producto</th>
                      <th scope="col" className="px-5 py-3 text-right">Unidades anteriores</th>
                      <th scope="col" className="px-5 py-3 text-right">Unidades actuales</th>
                      <th scope="col" className="px-5 py-3 text-right">Aumento</th>
                      <th scope="col" className="px-5 py-3 text-right">Crecimiento</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100">
                    {datos.tendencias.map((producto) => (
                      <tr key={producto.productoId} className="hover:bg-neutral-50">
                        <th scope="row" className="max-w-72 px-5 py-4 font-medium text-neutral-900">{producto.descripcion}</th>
                        <td className="px-5 py-4 text-right tabular-nums">{numero.format(producto.unidadesAnteriores)}</td>
                        <td className="px-5 py-4 text-right tabular-nums">{numero.format(producto.unidadesActuales)}</td>
                        <td className="px-5 py-4 text-right font-medium tabular-nums text-accent-700">+{numero.format(producto.aumentoUnidades)}</td>
                        <td className="px-5 py-4 text-right font-medium tabular-nums text-accent-700">{producto.sinBaseAnterior ? 'Sin ventas previas' : variacion(producto.crecimientoPorcentaje)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <footer className="text-xs leading-relaxed text-neutral-500">
            <p>Consulta realizada: {new Date(datos.sincronizacion.consultadoEn).toLocaleString('es-GT', { timeZone: ZONA_HORARIA })} (Guatemala).</p>
            {/* null significa que no pudimos consultar el estado, no que haya
                cero pendientes ni que nunca se haya sincronizado una venta. */}
            {datos.sincronizacion.pendientes === null ? (
              <p>Estado de sincronización no disponible; los datos podrían estar desactualizados.</p>
            ) : (
              <>
                <p>Última sincronización: {datos.sincronizacion.ultimaSincronizacion ? new Date(datos.sincronizacion.ultimaSincronizacion).toLocaleString('es-GT', { timeZone: ZONA_HORARIA }) : 'Aún no se han sincronizado ventas'}.</p>
                <p className={datos.sincronizacion.pendientes > 0 ? 'mt-1 font-medium text-amber-800' : ''}>{datos.sincronizacion.pendientes > 0 ? `Hay ${numero.format(datos.sincronizacion.pendientes)} registros pendientes de sincronizar; los totales pueden actualizarse.` : 'Sin registros pendientes de sincronizar.'}</p>
              </>
            )}
          </footer>
        </>
      )}
    </div>
  );
}
