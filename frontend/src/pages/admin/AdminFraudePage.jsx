import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { fraudeApi } from '../../api/fraude';
import { Spinner } from '../../components/common/Spinner';

function diasATexto(dias) {
  if (dias < 1) return 'hoy';
  if (dias === 1) return 'hace 1 día';
  return `hace ${dias} días`;
}

// Ficha de usuario — toda la información identificadora que el backend
// resolvió en vivo contra MySQL/Mongo (ver enriquecerUsuarios en
// fraudeService.js). `ficha` puede venir null si el usuario ya no existe
// (poco probable, pero Neo4j no borra en cascada — ver PLAN-NEO4J-
// DETECCION-FRAUDE.md §6); en ese caso solo se muestra lo que ya traía el
// hallazgo (nombre/id cacheados en el grafo).
function FichaUsuario({ id, nombre, ficha, notasExtra = [] }) {
  if (!ficha) {
    return (
      <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-500">
        {nombre} <span className="text-neutral-400">#{id}</span>
        <p className="mt-1 text-xs">Cuenta no encontrada en la base actual — puede haber sido eliminada.</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-neutral-900">
          {ficha.nombre} <span className="font-normal text-neutral-400">#{ficha.id}</span>
        </p>
        <div className="flex flex-wrap gap-1">
          {ficha.cuentaReciente && (
            <span className="rounded-full bg-warning-500/10 px-2 py-0.5 text-xs font-medium text-warning-500">
              Cuenta reciente
            </span>
          )}
          {notasExtra.map((nota) => (
            <span key={nota} className="rounded-full bg-danger-500/10 px-2 py-0.5 text-xs font-medium text-danger-600">
              {nota}
            </span>
          ))}
        </div>
      </div>

      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-neutral-600">
        <div>
          <dt className="text-neutral-400">Correo</dt>
          <dd className="truncate">{ficha.correo}</dd>
        </div>
        <div>
          <dt className="text-neutral-400">Rol</dt>
          <dd className="capitalize">{ficha.rol}</dd>
        </div>
        <div className="col-span-2">
          <dt className="text-neutral-400">Cuenta creada</dt>
          <dd>
            {new Date(ficha.creadoEn).toLocaleDateString('es-GT', { dateStyle: 'medium' })} · {diasATexto(ficha.diasDesdeCreacion)}
          </dd>
        </div>
        <div>
          <dt className="text-neutral-400">Compras</dt>
          <dd>{ficha.totalCompras} (Q{ficha.totalGastado.toFixed(2)})</dd>
        </div>
        <div>
          <dt className="text-neutral-400">Reseñas</dt>
          <dd>{ficha.totalResenas}</dd>
        </div>
      </dl>

      {ficha.direcciones.length > 0 && (
        <div className="mt-2 text-xs">
          <p className="text-neutral-400">Direcciones</p>
          <ul className="mt-0.5 list-inside list-disc text-neutral-600">
            {ficha.direcciones.map((d, i) => (
              <li key={i}>
                {d.direccion}, {d.pais} ({d.codigoPostal})
              </li>
            ))}
          </ul>
        </div>
      )}

      {ficha.metodosPago.length > 0 && (
        <div className="mt-2 text-xs">
          <p className="text-neutral-400">Métodos de pago</p>
          <ul className="mt-0.5 list-inside list-disc text-neutral-600">
            {ficha.metodosPago.map((m, i) => (
              <li key={i}>{m.marca} •••• {m.ultimos4}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function truncar(texto, n = 20) {
  return texto.length > n ? `${texto.slice(0, n - 1)}…` : texto;
}

// Paleta de "danger" en este proyecto solo define 500/600 (ver index.css) —
// no hay danger-50/400/900. Mismos tonos que ya usan las insignias de esta
// misma página (bg-danger-500/10 + text-danger-600), aplicados a fill/stroke.
const TONOS_NODO = {
  usuario: { fill: 'fill-brand-50', stroke: 'stroke-brand-400', texto: 'fill-brand-900' },
  otro: { fill: 'fill-danger-500/10', stroke: 'stroke-danger-500', texto: 'fill-danger-600' },
  dato: { fill: 'fill-neutral-100', stroke: 'stroke-neutral-300', texto: 'fill-neutral-700' },
};

// Primitivas del diagrama — un nodo (caja + etiqueta) y una arista (línea +
// etiqueta), reutilizadas por los dos diagramas de abajo. No es un layout
// automático (fuerza dirigida, etc.): las coordenadas las calcula cada
// diagrama a mano, a propósito — con 2-4 nodos por hallazgo, un layout fijo
// y legible gana sobre uno "inteligente" que puede quedar torcido.
function NodoSvg({ x, y, w, h, titulo, subtitulo, tono }) {
  const c = TONOS_NODO[tono] || TONOS_NODO.dato;
  return (
    <g>
      <rect x={x - w / 2} y={y - h / 2} width={w} height={h} rx={8} className={`${c.fill} ${c.stroke}`} strokeWidth={1.5} />
      <text x={x} y={y - (subtitulo ? 4 : -3)} textAnchor="middle" className={`${c.texto} text-[11px] font-semibold`}>
        {truncar(titulo, 20)}
      </text>
      {subtitulo && (
        <text x={x} y={y + 12} textAnchor="middle" className="fill-neutral-400 text-[9px] uppercase tracking-wide">
          {subtitulo}
        </text>
      )}
    </g>
  );
}

function AristaSvg({ x1, y1, x2, y2, etiqueta, discontinua }) {
  return (
    <g>
      <line
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        className={discontinua ? 'stroke-danger-500' : 'stroke-neutral-300'}
        strokeWidth={1.25}
        strokeDasharray={discontinua ? '4 3' : undefined}
      />
      {etiqueta && (
        <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 4} textAnchor="middle" className="fill-neutral-500 text-[9px]">
          {etiqueta}
        </text>
      )}
    </g>
  );
}

// Relaciones REALES de Neo4j (ver fraudeService.js §4 / PLAN-NEO4J-
// DETECCION-FRAUDE.md §5): Usuario -COMPRÓ-> Producto, Usuario -ENVIÓ_A->
// Dirección, Usuario -PAGÓ_CON-> MetodoPago. El diagrama dibuja EXACTAMENTE
// esas mismas relaciones, no una versión simplificada — la dirección
// aparece como un nodo intermedio compartido (Usuario -> Dirección <-
// otraCuenta) porque así es como la consulta de verdad encuentra el cruce,
// no como una línea directa entre las dos cuentas.
function DiagramaDesviacion({ d }) {
  const otras = d.otrasCuentas;
  const espaciado = 64;
  const alto = Math.max(220, 90 + otras.length * espaciado);
  const centroY = alto / 2;
  const inicioY = centroY - ((otras.length - 1) * espaciado) / 2;
  const otrasPos = otras.map((o, i) => ({ ...o, y: inicioY + i * espaciado }));

  const xUsuario = 75;
  const xProducto = 75;
  const yProducto = 40;
  const xDireccion = 270;
  const xOtras = 460;
  const hayMetodoCompartido = otras.some((o) => o.mismoMetodoPago);
  const xMetodo = 270;
  const yMetodo = alto - 30;

  return (
    <svg viewBox={`0 0 540 ${alto}`} className="mt-2 w-full max-w-xl" role="img" aria-label="Diagrama de relaciones del hallazgo">
      <AristaSvg x1={xUsuario} y1={centroY} x2={xProducto} y2={yProducto} etiqueta="compró" />
      <AristaSvg x1={xUsuario} y1={centroY} x2={xDireccion} y2={centroY} etiqueta="envió a" />
      {hayMetodoCompartido && <AristaSvg x1={xUsuario} y1={centroY} x2={xMetodo} y2={yMetodo} etiqueta="pagó con" />}
      {otrasPos.map((o) => (
        <g key={`aristas-${o.id}`}>
          <AristaSvg x1={xDireccion} y1={centroY} x2={xOtras} y2={o.y} etiqueta="envió a" />
          {o.mismoMetodoPago && <AristaSvg x1={xOtras} y1={o.y} x2={xMetodo} y2={yMetodo} etiqueta="pagó con" />}
          {o.tambienEnSenalA && (
            <AristaSvg x1={xUsuario} y1={centroY + 22} x2={xOtras} y2={o.y} etiqueta="Señal A" discontinua />
          )}
        </g>
      ))}

      <NodoSvg x={xUsuario} y={centroY} w={120} h={42} titulo={d.usuario.nombre} subtitulo="usuario" tono="usuario" />
      <NodoSvg x={xProducto} y={yProducto} w={120} h={32} titulo={d.producto.descripcion} subtitulo="producto" tono="dato" />
      <NodoSvg x={xDireccion} y={centroY} w={130} h={32} titulo="Dirección compartida" tono="dato" />
      {hayMetodoCompartido && <NodoSvg x={xMetodo} y={yMetodo} w={150} h={32} titulo="Método de pago compartido" tono="dato" />}
      {otrasPos.map((o) => (
        <NodoSvg key={o.id} x={xOtras} y={o.y} w={130} h={42} titulo={o.nombre} subtitulo="otra cuenta" tono="otro" />
      ))}
    </svg>
  );
}

// Relación REAL: (u1)-[:RESEÑÓ]->(p)<-[:RESEÑÓ]-(u2) — bipartita, las dos
// cuentas convergen en los mismos productos. Se muestran como máximo 5
// productos para que el diagrama siga siendo legible; el resto se cuenta
// como texto, no se omite en silencio.
function DiagramaResenas({ r }) {
  const productos = r.productos.slice(0, 5);
  const extra = r.productos.length - productos.length;
  const espaciado = 44;
  const alto = Math.max(180, 50 + productos.length * espaciado);
  const centroY = alto / 2;
  const inicioY = centroY - ((productos.length - 1) * espaciado) / 2;
  const productosPos = productos.map((p, i) => ({ nombre: p, y: inicioY + i * espaciado }));

  const xU1 = 75;
  const xProd = 290;
  const xU2 = 505;

  return (
    <svg viewBox={`0 0 580 ${alto + (extra > 0 ? 20 : 0)}`} className="mt-2 w-full max-w-xl" role="img" aria-label="Diagrama de relaciones del hallazgo">
      {productosPos.map((p, i) => (
        <g key={i}>
          <AristaSvg x1={xU1} y1={centroY} x2={xProd} y2={p.y} etiqueta="reseñó" />
          <AristaSvg x1={xU2} y1={centroY} x2={xProd} y2={p.y} etiqueta="reseñó" />
        </g>
      ))}
      <NodoSvg x={xU1} y={centroY} w={125} h={42} titulo={r.usuario1.nombre} subtitulo="usuario" tono="usuario" />
      <NodoSvg x={xU2} y={centroY} w={125} h={42} titulo={r.usuario2.nombre} subtitulo="usuario" tono="otro" />
      {productosPos.map((p, i) => (
        <NodoSvg key={i} x={xProd} y={p.y} w={150} h={32} titulo={p.nombre} subtitulo="producto" tono="dato" />
      ))}
      {extra > 0 && (
        <text x={xProd} y={alto + 12} textAnchor="middle" className="fill-neutral-400 text-[10px]">
          +{extra} producto(s) más en común
        </text>
      )}
    </svg>
  );
}

// Resumen de una línea con lo importante — pensado para escanear el panel
// sin abrir cada hallazgo. Se arma acá, a partir de los mismos campos
// estructurados que ya llegan del backend (no recorta el motivo en prosa:
// texto libre no es seguro de truncar a la mitad de una oración).
function resumenDesviacion(d) {
  const n = d.otrasCuentas.length;
  const corroboradores = [];
  if (d.otrasCuentas.some((o) => o.mismoMetodoPago)) corroboradores.push('mismo método de pago');
  if (d.otrasCuentas.some((o) => o.tambienEnSenalA)) corroboradores.push('también en Señal A');
  const sufijo = corroboradores.length ? ` — ${corroboradores.join(' + ')}` : '';
  return `${d.usuario.nombre}: primera compra en "${d.subcategoria}", dirección compartida con ${n} cuenta${n !== 1 ? 's' : ''}${sufijo}.`;
}

function resumenResenas(r) {
  return `${r.usuario1.nombre} y ${r.usuario2.nombre}: ${r.productosCompartidos} productos reseñados en común (${r.promedio1.toFixed(1)}★ / ${r.promedio2.toFixed(1)}★), ventana de tiempo corta.`;
}

// Lista de razones — el mismo caso que arma el motivo en prosa
// (fraudeService.js), pero como hechos sueltos en vez de una oración
// continua, para poder escanearlos de un vistazo.
function RazonesDesviacion({ d }) {
  const razones = [
    `Primera compra registrada de ${d.usuario.nombre} en la categoría "${d.subcategoria}".`,
    `La dirección de envío de esa compra también la usa${d.otrasCuentas.length !== 1 ? 'n' : ''} ${d.otrasCuentas.length} cuenta${
      d.otrasCuentas.length !== 1 ? 's' : ''
    }: ${d.otrasCuentas.map((o) => o.nombre).join(', ')}.`,
  ];
  for (const o of d.otrasCuentas) {
    if (o.mismoMetodoPago) razones.push(`${o.nombre} también pagó alguna vez con el mismo método de pago que esta compra.`);
    if (o.tambienEnSenalA) razones.push(`${o.nombre} también coordina reseñas con ${d.usuario.nombre} en la Señal A.`);
  }
  if (d.usuario.ficha?.cuentaReciente) {
    razones.push(`La cuenta de ${d.usuario.nombre} es reciente (creada ${diasATexto(d.usuario.ficha.diasDesdeCreacion)}).`);
  }
  return (
    <ul className="mt-2 list-inside list-disc space-y-1 text-xs text-neutral-600">
      {razones.map((texto, i) => (
        <li key={i}>{texto}</li>
      ))}
    </ul>
  );
}

function RazonesResenas({ r }) {
  const razones = [
    `${r.usuario1.nombre} y ${r.usuario2.nombre} reseñaron los mismos ${r.productosCompartidos} productos: ${r.productos.join(', ')}.`,
    `Calificación promedio: ${r.promedio1.toFixed(1)}★ (${r.usuario1.nombre}) y ${r.promedio2.toFixed(1)}★ (${r.usuario2.nombre}).`,
    'Cada par de reseñas de este grupo quedó separado por menos de la ventana de tiempo configurada (por defecto, 1 hora).',
  ];
  const recientes = [r.usuario1, r.usuario2].filter((u) => u.ficha?.cuentaReciente);
  if (recientes.length > 0) {
    razones.push(`Cuenta(s) reciente(s): ${recientes.map((u) => u.nombre).join(', ')}.`);
  }
  return (
    <ul className="mt-2 list-inside list-disc space-y-1 text-xs text-neutral-600">
      {razones.map((texto, i) => (
        <li key={i}>{texto}</li>
      ))}
    </ul>
  );
}

function BotonDetalle({ expandido, onClick }) {
  return (
    <button
      onClick={onClick}
      className="mt-2 flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline"
    >
      {expandido ? '▴ Ocultar detalle completo' : '▾ Ver detalle completo — por qué y relaciones'}
    </button>
  );
}

function HallazgoResenas({ r }) {
  const [expandido, setExpandido] = useState(false);
  const recientes = [r.usuario1, r.usuario2].filter((u) => u.ficha?.cuentaReciente).length;

  return (
    <div className="rounded-lg border border-warning-500/30 bg-warning-500/5 p-3">
      <p className="text-sm text-neutral-800">{resumenResenas(r)}</p>
      {recientes > 0 && (
        <p className="mt-1 text-xs text-warning-500">
          {recientes === 2 ? 'Las dos cuentas son recientes.' : 'Una de las cuentas es reciente.'}
        </p>
      )}
      <BotonDetalle expandido={expandido} onClick={() => setExpandido((v) => !v)} />

      {expandido && (
        <div className="mt-3 border-t border-warning-500/20 pt-3">
          <p className="text-sm text-neutral-800">{r.motivo}</p>
          <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">Por qué se marcó</p>
          <RazonesResenas r={r} />
          <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">Relaciones (Neo4j)</p>
          <DiagramaResenas r={r} />
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FichaUsuario id={r.usuario1.id} nombre={r.usuario1.nombre} ficha={r.usuario1.ficha} />
            <FichaUsuario id={r.usuario2.id} nombre={r.usuario2.nombre} ficha={r.usuario2.ficha} />
          </div>
          {r.ultimaActividad && (
            <p className="mt-2 text-xs text-neutral-400">
              Última reseña del grupo: {new Date(r.ultimaActividad).toLocaleString('es-GT')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function HallazgoDesviacion({ d }) {
  const [expandido, setExpandido] = useState(false);
  const confianzaAlta = d.nivelConfianza === 'alta';

  return (
    <div className={`rounded-lg border p-3 ${confianzaAlta ? 'border-danger-500/30 bg-danger-500/5' : 'border-neutral-200 bg-neutral-50'}`}>
      <span
        className={`rounded-full px-2 py-0.5 text-xs font-bold uppercase tracking-wide ${
          confianzaAlta ? 'bg-danger-600 text-white' : 'bg-neutral-200 text-neutral-600'
        }`}
      >
        {confianzaAlta ? 'Confianza alta' : 'Posible coincidencia'}
      </span>
      <p className="mt-2 text-sm text-neutral-800">{resumenDesviacion(d)}</p>
      <BotonDetalle expandido={expandido} onClick={() => setExpandido((v) => !v)} />

      {expandido && (
        <div className={`mt-3 border-t pt-3 ${confianzaAlta ? 'border-danger-500/20' : 'border-neutral-200'}`}>
          <p className="text-sm text-neutral-800">{d.motivo}</p>
          <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">Por qué se marcó</p>
          <RazonesDesviacion d={d} />
          <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">Relaciones (Neo4j)</p>
          <DiagramaDesviacion d={d} />
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FichaUsuario id={d.usuario.id} nombre={d.usuario.nombre} ficha={d.usuario.ficha} />
            {d.otrasCuentas.map((o) => (
              <FichaUsuario
                key={o.id}
                id={o.id}
                nombre={o.nombre}
                ficha={o.ficha}
                notasExtra={[o.mismoMetodoPago && 'Mismo método de pago', o.tambienEnSenalA && 'También en Señal A'].filter(Boolean)}
              />
            ))}
          </div>
          <p className="mt-2 text-xs text-neutral-400">
            Producto: {d.producto.descripcion} · Categoría: {d.subcategoria} · Monto: Q{d.monto.toFixed(2)} ·{' '}
            {d.fecha ? new Date(d.fecha).toLocaleString('es-GT') : 'fecha desconocida'}
          </p>
        </div>
      )}
    </div>
  );
}

// Señales de posible fraude (Neo4j, ver IA/PLAN-NEO4J-DETECCION-FRAUDE.md) —
// cada hallazgo se muestra colapsado por defecto (resumen de una línea +
// insignia de confianza), con un botón para expandir el motivo completo en
// prosa, la lista de razones y el diagrama de relaciones reales del grafo.
// Nunca una acusación — candidatos para revisión humana, se dice explícito
// en la UI, no solo en el documento de diseño.
export function AdminFraudePage() {
  const { token } = useAuth();
  const [datos, setDatos] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');

  function cargar() {
    setCargando(true);
    setError('');
    fraudeApi
      .consultar(token)
      .then(setDatos)
      .catch((err) => setError(err.message))
      .finally(() => setCargando(false));
  }

  useEffect(cargar, [token]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link to="/admin" className="text-sm font-medium text-brand-700 hover:underline">
          ← Panel de administrador
        </Link>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-neutral-900">Señales de fraude</h1>
            <p className="mt-1 text-sm text-neutral-500">
              Candidatos para revisión humana — ninguna tarjeta de acá es una acusación por sí sola.
            </p>
          </div>
          <button onClick={cargar} className="rounded-lg border border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50">
            Actualizar
          </button>
        </div>
      </div>

      {cargando && <Spinner />}
      {error && <p className="rounded-lg bg-danger-500/10 p-4 text-sm text-danger-600">{error}</p>}

      {datos && (
        <>
          {datos.advertencias?.length > 0 && (
            <div className="rounded-lg bg-warning-500/10 p-3 text-sm text-warning-500">
              {datos.advertencias.map((a, i) => (
                <p key={i}>{a}</p>
              ))}
            </div>
          )}

          <section className="rounded-xl border border-neutral-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-neutral-800">Reseñas coordinadas</h2>
            <p className="mt-1 text-xs text-neutral-500">
              Cuentas distintas que reseñaron los mismos productos, calificación alta, dentro de una ventana de tiempo corta.
            </p>
            {datos.resenasCoordinadas.length === 0 ? (
              <p className="mt-3 text-sm text-neutral-500">Sin patrones señalados por ahora.</p>
            ) : (
              <div className="mt-3 flex flex-col gap-4">
                {datos.resenasCoordinadas.map((r, i) => (
                  <HallazgoResenas key={i} r={r} />
                ))}
              </div>
            )}
          </section>

          <section className="rounded-xl border border-neutral-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-neutral-800">Desviación de patrón de compra</h2>
            <p className="mt-1 text-xs text-neutral-500">
              Una compra en una categoría nueva para esa cuenta, enviada a una dirección que otra cuenta distinta también usó.
            </p>
            {datos.desviacionPatron.length === 0 ? (
              <p className="mt-3 text-sm text-neutral-500">Sin patrones señalados por ahora.</p>
            ) : (
              <div className="mt-3 flex flex-col gap-4">
                {datos.desviacionPatron.map((d, i) => (
                  <HallazgoDesviacion key={i} d={d} />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
