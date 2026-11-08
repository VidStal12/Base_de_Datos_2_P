import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { fraudeApi } from '../../api/fraude';
import { Spinner } from '../../components/common/Spinner';
import { FichaUsuario } from '../../components/admin/FichaUsuario';
import { FiltrosFraude } from '../../components/admin/FiltrosFraude';
import { BloqueadasContext } from '../../components/admin/bloqueadasContext';
import { diasATexto, formatoQ } from '../../utils/format';
import {
  TIPOS,
  aParametros,
  aplanarCasos,
  conCaso,
  conNivel,
  conRelacion,
  conUsuario,
  conVinculo,
  conteos,
  duracionTexto,
  filtrar,
  hayFiltros,
  leerFiltros,
  relacionados,
  sinFiltros,
} from '../../utils/fraudeCasos';

const formatoFechaHora = (f) => (f ? new Date(f).toLocaleString('es-GT') : 'fecha desconocida');
// "dia" llega como AAAA-MM-DD ya en día de Guatemala; se fija al mediodía UTC
// para que ninguna zona horaria del navegador lo corra al día anterior.
const formatoDia = (dia) => new Date(`${dia}T12:00:00Z`).toLocaleDateString('es-GT', { dateStyle: 'medium', timeZone: 'UTC' });
const pluralCompras = (n) => `${n} compra${n === 1 ? '' : 's'}`;
const pluralPedidos = (n) => `${n} pedido${n === 1 ? '' : 's'}`;

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
// etiqueta), reutilizadas por los diagramas de abajo. No es un layout
// automático (fuerza dirigida, etc.): las coordenadas las calcula cada
// diagrama a mano, a propósito — con 2-6 nodos por hallazgo, un layout fijo
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

// Relaciones REALES: (u)-[:USO_DISPOSITIVO]->(:Dispositivo)<-[:USO_DISPOSITIVO]-(otra) y
// (u)-[:USA_CORREO]->(:Correo)<-[:USA_CORREO]-(otra). Cada vínculo del grupo es
// un nodo COMPARTIDO — el dispositivo (el identificador del navegador) o el buzón
// normalizado — al que convergen las cuentas que lo comparten; un grupo puede
// tener varios (una pareja con el mismo dispositivo Y el mismo buzón, dos
// dispositivos en común, o una cadena donde A y B comparten dispositivo y B y C
// comparten buzón). El nombre ya no vincula cuentas (§22): dos personas pueden
// llamarse igual. Las cuentas se reparten en una elipse y
// los nodos compartidos van apilados en el centro; con 2-8 cuentas y 1-3
// vínculos por grupo el reparto se mantiene legible. El hash del buzón y el del
// dispositivo nunca llegan al navegador: el nodo del buzón solo dice "mismo
// buzón" y el del dispositivo, su etiqueta y una referencia de 8 caracteres.
function DiagramaPersona({ a }) {
  const n = a.miembros.length;
  const cx = 270;
  const cy = 130;
  const rx = 195;
  const ry = 88;
  const posiciones = new Map(
    a.miembros.map((m, i) => {
      const angulo = Math.PI + (2 * Math.PI * i) / n;
      return [m.id, { ...m, x: cx + rx * Math.cos(angulo), y: cy + ry * Math.sin(angulo) }];
    })
  );
  const hubs = a.vinculos.map((v, i) => ({
    ...v,
    x: cx,
    y: cy + (i - (a.vinculos.length - 1) / 2) * 46,
    titulo: v.tipo === 'dispositivo' ? v.etiqueta ?? 'Mismo dispositivo' : 'Mismo buzón',
    subtitulo: v.tipo === 'dispositivo' ? `dispositivo ${v.referencia}` : 'correo normalizado',
    etiqueta: v.tipo === 'dispositivo' ? 'entró desde' : 'usa el buzón',
  }));

  return (
    <svg viewBox="0 0 540 260" className="mt-2 w-full max-w-xl" role="img" aria-label="Diagrama de cuentas que comparten dispositivo o buzón de correo">
      {hubs.flatMap((h, i) =>
        h.ids.map((id) => {
          const m = posiciones.get(id);
          return <AristaSvg key={`arista-${i}-${id}`} x1={m.x} y1={m.y} x2={h.x} y2={h.y} etiqueta={h.etiqueta} />;
        })
      )}
      {hubs.map((h, i) => (
        <NodoSvg key={`hub-${i}`} x={h.x} y={h.y} w={150} h={36} titulo={h.titulo} subtitulo={h.subtitulo} tono="dato" />
      ))}
      {[...posiciones.values()].map((m, i) => (
        <NodoSvg key={m.id} x={m.x} y={m.y} w={130} h={42} titulo={`Cuenta #${m.id}`} subtitulo={pluralCompras(m.ordenes)} tono={i === 0 ? 'usuario' : 'otro'} />
      ))}
    </svg>
  );
}

// Relación REAL: (comprador)-[:COMPRÓ]->(producto)<-[:VENDE]-(vendedor). Si son
// dos cuentas distintas, las une un nodo compartido — el mismo dispositivo, un
// equipo parecido (mismo Perfil con otro identificador), el mismo buzón, o dos de
// ellos — (las dos USO_DISPOSITIVO el mismo / TIENE_PERFIL el mismo / USA_CORREO el
// mismo); si es la misma cuenta, el mismo nodo compra y vende el mismo producto.
function DiagramaAutocompra({ f }) {
  const productos = f.productos.length > 1 ? `${f.productos[0]} (+${f.productos.length - 1})` : f.productos[0];

  if (f.mismaCuenta) {
    return (
      <svg viewBox="0 0 540 120" className="mt-2 w-full max-w-xl" role="img" aria-label="Diagrama de una cuenta que se compra a sí misma">
        <AristaSvg x1={130} y1={52} x2={400} y2={52} etiqueta="compró" />
        <AristaSvg x1={130} y1={74} x2={400} y2={74} etiqueta="vende" discontinua />
        <NodoSvg x={75} y={63} w={130} h={42} titulo={f.comprador.nombre} subtitulo="compra y vende" tono="usuario" />
        <NodoSvg x={465} y={63} w={140} h={42} titulo={productos} subtitulo="producto" tono="dato" />
      </svg>
    );
  }

  const hubs = [];
  if (f.mismoDispositivo) {
    hubs.push({ titulo: 'Mismo dispositivo', subtitulo: f.dispositivosCompartidos > 1 ? `${f.dispositivosCompartidos} dispositivos` : 'identificador del navegador', etiqueta: 'entró desde' });
  }
  // Excluyente con el dispositivo compartido: es el equipo parecido de OTRO identificador.
  if (f.mismoPerfil) hubs.push({ titulo: 'Equipo parecido', subtitulo: 'mismo perfil de dispositivo', etiqueta: 'entró desde un equipo' });
  if (f.mismoBuzon) hubs.push({ titulo: 'Mismo buzón', subtitulo: 'correo normalizado', etiqueta: 'usa el buzón' });
  const xHubs = hubs.length === 2 ? [175, 365] : [270];

  return (
    <svg viewBox="0 0 540 190" className="mt-2 w-full max-w-xl" role="img" aria-label="Diagrama de una compra entre cuentas de una misma persona">
      <AristaSvg x1={80} y1={45} x2={270} y2={45} etiqueta="compró" />
      <AristaSvg x1={460} y1={45} x2={270} y2={45} etiqueta="vende" />
      {hubs.map((h, i) => (
        <g key={`aristas-${i}`}>
          <AristaSvg x1={80} y1={45} x2={xHubs[i]} y2={150} etiqueta={h.etiqueta} discontinua />
          <AristaSvg x1={460} y1={45} x2={xHubs[i]} y2={150} etiqueta={h.etiqueta} discontinua />
        </g>
      ))}
      <NodoSvg x={80} y={45} w={130} h={42} titulo={f.comprador.nombre} subtitulo={`comprador #${f.comprador.id}`} tono="usuario" />
      <NodoSvg x={270} y={45} w={140} h={42} titulo={productos} subtitulo="producto" tono="dato" />
      <NodoSvg x={460} y={45} w={130} h={42} titulo={f.vendedor.nombre} subtitulo={`vendedor #${f.vendedor.id}`} tono="otro" />
      {hubs.map((h, i) => (
        <NodoSvg key={`hub-${i}`} x={xHubs[i]} y={150} w={150} h={34} titulo={h.titulo} subtitulo={h.subtitulo} tono="dato" />
      ))}
    </svg>
  );
}

// Relación REAL de la reventa:
//   (vendedor)-[:COMPRÓ]->(original)<-[:VENDE]-(otro vendedor)
//   (original)-[:ES_ARTICULO]->(artículo)<-[:ES_ARTICULO]-(publicación)<-[:VENDE]-(vendedor)
// Un nodo compartido — el artículo — une el producto que compró con el que hoy
// vende; la arista punteada roja es la sospechosa: vende lo que compró. Si
// compró el mismo artículo a más de un vendedor se dibuja el primero y el resto
// se cuenta como texto (ver las razones), igual que DiagramaResenas.
function DiagramaReventa({ h }) {
  const original = h.originales[0];
  const extra = h.originales.length - 1;
  return (
    <svg viewBox={`0 0 540 ${extra > 0 ? 250 : 230}`} className="mt-2 w-full max-w-xl" role="img" aria-label="Diagrama de un vendedor que revende lo que compró">
      <AristaSvg x1={75} y1={118} x2={270} y2={42} etiqueta="compró" />
      <AristaSvg x1={465} y1={42} x2={270} y2={42} etiqueta="vende" />
      <AristaSvg x1={75} y1={118} x2={270} y2={192} etiqueta="vende" discontinua />
      <AristaSvg x1={270} y1={42} x2={465} y2={118} etiqueta="es el artículo" discontinua />
      <AristaSvg x1={270} y1={192} x2={465} y2={118} etiqueta="es el artículo" discontinua />
      <NodoSvg x={75} y={118} w={130} h={42} titulo={h.vendedor.nombre} subtitulo={`vendedor #${h.vendedor.id}`} tono="usuario" />
      <NodoSvg x={270} y={42} w={150} h={42} titulo={original.producto.nombre} subtitulo="lo que compró" tono="dato" />
      <NodoSvg x={465} y={42} w={130} h={42} titulo={original.vendedor.nombre} subtitulo={`vendedor #${original.vendedor.id}`} tono="otro" />
      <NodoSvg x={270} y={192} w={150} h={42} titulo={h.publicacion.nombre} subtitulo="lo que hoy vende" tono="dato" />
      <NodoSvg x={465} y={118} w={130} h={36} titulo="Mismo artículo" subtitulo="nombre canónico" tono="dato" />
      {extra > 0 && (
        <text x={270} y={240} textAnchor="middle" className="fill-neutral-400 text-[10px]">
          +{extra} compra(s) equivalente(s) más, ver el detalle
        </text>
      )}
    </svg>
  );
}

// Barras horizontales simples para comparar magnitudes (monto vs. historial,
// categoría nueva vs. habituales). Un SVG a mano sería más código para decir
// lo mismo; divs con ancho proporcional se leen igual y se adaptan al ancho.
const TONOS_BARRA = { normal: 'bg-brand-400', alerta: 'bg-danger-500', neutro: 'bg-neutral-300' };

function Barras({ filas }) {
  const maximo = Math.max(...filas.map((f) => f.valor), 1);
  return (
    <div className="mt-2 flex max-w-xl flex-col gap-1.5">
      {filas.map((f) => (
        <div key={f.etiqueta} className="grid grid-cols-[9rem_1fr_auto] items-center gap-2 text-xs">
          <span className="truncate text-neutral-600" title={f.etiqueta}>
            {f.etiqueta}
          </span>
          <div className="h-3 rounded bg-neutral-100">
            <div className={`h-3 rounded ${TONOS_BARRA[f.tono]}`} style={{ width: `${Math.max(2, (f.valor / maximo) * 100)}%` }} />
          </div>
          <span className="tabular-nums text-neutral-700">{f.texto}</span>
        </div>
      ))}
    </div>
  );
}

const ETIQUETAS_SENAL = {
  cuentasRelacionadas: 'cuentas de una misma persona',
  autocompra: 'autocompra',
  resenasCoordinadas: 'reseñas coordinadas',
  gastoAnomalo: 'gasto anómalo',
  categoriaInusual: 'categoría inusual',
  rafagaGasto: 'ráfaga de gasto',
  fechaNacimiento: 'misma fecha de nacimiento',
  variosDispositivos: 'más de un dispositivo en común',
  reventa: 'reventa de lo comprado',
  publicadaDespuesDeComprar: 'publicó después de comprar',
  mismosAtributos: 'mismos atributos',
  reventaRecurrente: 'reventa recurrente',
};

// Resumen de una línea con lo importante — pensado para escanear el panel
// sin abrir cada hallazgo. Se arma acá, a partir de los mismos campos
// estructurados que ya llegan del backend (no recorta el motivo en prosa:
// texto libre no es seguro de truncar a la mitad de una oración).
function resumenResenas(r) {
  return `${r.usuario1.nombre} y ${r.usuario2.nombre}: ${r.productosCompartidos} productos reseñados en común (${r.promedio1.toFixed(1)}★ / ${r.promedio2.toFixed(1)}★), ventana de tiempo corta.`;
}

const tieneVinculo = (a, tipo) => a.vinculos.some((v) => v.tipo === tipo);

function resumenPersona(a) {
  const porDispositivo = tieneVinculo(a, 'dispositivo');
  const porBuzon = tieneVinculo(a, 'correo');
  const quienes = porDispositivo && porBuzon
    ? `${a.miembros.length} cuentas relacionadas por dispositivo y por buzón de correo`
    : porBuzon
      ? `${a.miembros.length} cuentas usan el mismo buzón de correo`
      : `${a.miembros.length} cuentas entraron desde el mismo dispositivo`;
  return `${quienes}: ${pluralCompras(a.totalOrdenes)} y ${formatoQ(a.totalGastado)} en total.`;
}

// Cómo se relacionan comprador y vendedor, para una frase: "con el mismo
// buzón de correo", "con el mismo dispositivo", "con un equipo parecido", o varias.
const vinculoAutocompra = (f) =>
  [
    f.mismoBuzon && 'el mismo buzón de correo',
    f.mismoDispositivo && (f.dispositivosCompartidos > 1 ? `${f.dispositivosCompartidos} dispositivos en común` : 'el mismo dispositivo'),
    f.mismoPerfil && 'un equipo parecido (mismo perfil de dispositivo)',
  ]
    .filter(Boolean)
    .join(' y ');

function resumenAutocompra(f) {
  return f.mismaCuenta
    ? `${f.comprador.nombre}: ${pluralPedidos(f.pedidos)} (${formatoQ(f.total)}) de sus propios productos.`
    : `${f.comprador.nombre} (#${f.comprador.id}) le compró ${pluralPedidos(f.pedidos)} (${formatoQ(f.total)}) a ${f.vendedor.nombre} (#${f.vendedor.id}), otra cuenta con ${vinculoAutocompra(f)}.`;
}

const pluralUnidades = (n) => `${n} unidad${n === 1 ? '' : 'es'}`;

function resumenReventa(h) {
  const original = h.originales[0];
  const otras = h.originales.length > 1 ? ` (+${h.originales.length - 1} compra${h.originales.length === 2 ? '' : 's'} equivalente${h.originales.length === 2 ? '' : 's'})` : '';
  return `${h.vendedor.nombre} (#${h.vendedor.id}) le compró "${original.producto.nombre}" a ${original.vendedor.nombre} (#${original.vendedor.id})${otras} y hoy vende "${h.publicacion.nombre}"${h.publicacion.precio != null ? ` a ${formatoQ(h.publicacion.precio)}` : ''}.`;
}

function resumenRafaga(r) {
  const partes = [`${r.usuario.nombre}: ${pluralPedidos(r.pedidos)} el ${formatoDia(r.dia)} por ${formatoQ(r.gastado)}`];
  if (r.reglas.muchoGasto) partes.push(`su gasto diario habitual es ${formatoQ(r.promedioGasto)}`);
  if (r.reglas.muchosPedidos) partes.push(r.maxPedidos === 0 ? 'cuenta sin pedidos previos' : `su día más activo tenía ${pluralPedidos(r.maxPedidos)}`);
  return `${partes.join(' — ')}.`;
}

function resumenGasto(g) {
  const relacion = g.vecesPromedio === null ? 'muy por encima de' : `${g.vecesPromedio.toFixed(1)} veces`;
  return `${g.usuario.nombre}: compra de ${formatoQ(g.total)}, ${relacion} su promedio de ${formatoQ(g.promedio)} (máximo anterior ${formatoQ(g.maximo)}).`;
}

function resumenCategoria(c) {
  return `${c.usuario.nombre}: primera compra en "${c.categoria}" tras ${pluralCompras(c.ordenesPrevias)} en ${c.diasHistorial} días, siempre en ${c.habituales.map((h) => h.categoria).join(' y ')}.`;
}

// Lista de razones — el mismo caso que arma el motivo en prosa
// (fraudeService.js), pero como hechos sueltos en vez de una oración
// continua, para poder escanearlos de un vistazo.
function ListaRazones({ razones }) {
  return (
    <ul className="mt-2 list-inside list-disc space-y-1 text-xs text-neutral-600">
      {razones.map((texto, i) => (
        <li key={i}>{texto}</li>
      ))}
    </ul>
  );
}

const conCorroboradores = (razones, corroboradores) => [...razones, ...corroboradores.map((c) => `Corrobora: ${c.detalle}.`)];

function razonesResenas(r) {
  const razones = [
    `${r.usuario1.nombre} y ${r.usuario2.nombre} reseñaron los mismos ${r.productosCompartidos} productos: ${r.productos.join(', ')}.`,
    `Calificación promedio: ${r.promedio1.toFixed(1)}★ (${r.usuario1.nombre}) y ${r.promedio2.toFixed(1)}★ (${r.usuario2.nombre}).`,
    'Cada par de reseñas de este grupo quedó separado por menos de la ventana de tiempo configurada (por defecto, 1 hora).',
  ];
  const recientes = [r.usuario1, r.usuario2].filter((u) => u.ficha?.cuentaReciente);
  if (recientes.length > 0) razones.push(`Cuenta(s) reciente(s): ${recientes.map((u) => u.nombre).join(', ')}.`);
  return razones;
}

// Una razón por vínculo: qué cuentas lo comparten. Los correos legibles salen de
// la ficha (MySQL); del grafo solo llegan los ids.
function razonesVinculos(a) {
  const correoDe = new Map(a.miembros.map((m) => [m.id, m.ficha?.correo]));
  return a.vinculos.map((v) => {
    const cuentas = v.ids.map((id) => `#${id}`).join(', ');
    if (v.tipo === 'dispositivo') {
      return `Las cuentas ${cuentas} entraron desde el mismo dispositivo (${v.etiqueta ?? 'navegador'}, referencia ${v.referencia}): el navegador le pone un identificador aleatorio a cada equipo y lo manda al iniciar sesión.`;
    }
    const correos = v.ids.map((id) => correoDe.get(id)).filter(Boolean);
    return `Las cuentas ${cuentas} usan el mismo buzón de correo${correos.length ? ` (${correos.join(', ')})` : ''}: el correo exacto no puede repetirse, así que compartir la bandeja (alias "+", puntos de Gmail) es deliberado.`;
  });
}

function razonesPersona(a) {
  return conCorroboradores(
    [
      ...razonesVinculos(a),
      ...a.miembros.map((m) =>
        m.ordenes > 0
          ? `Cuenta #${m.id}: ${pluralCompras(m.ordenes)}, ${formatoQ(m.gastado)}${m.categorias.length ? ` en ${m.categorias.join(', ')}` : ''}.`
          : `Cuenta #${m.id}: sin compras (figura por vender productos).`
      ),
      `Entre todas movieron ${formatoQ(a.totalGastado)} en ${pluralCompras(a.totalOrdenes)}.`,
      tieneVinculo(a, 'correo')
        ? 'Compartir buzón es evidencia fuerte por sí sola: parte en confianza alta, y delata incluso a quien entra desde un dispositivo distinto en cada cuenta.'
        : 'Compartir dispositivo no prueba que sean la misma persona (una familia, una oficina o un cibercafé comparten computador): es una coincidencia a verificar, por eso parte en "posible" salvo que otra cosa lo corrobore. El nombre ya no cuenta: dos personas distintas pueden llamarse igual.',
    ],
    a.corroboradores
  );
}

function razonesAutocompra(f) {
  return conCorroboradores(
    [
      f.mismaCuenta
        ? `La cuenta #${f.comprador.id} compró ${pluralPedidos(f.pedidos)} de sus propios productos: ${f.productos.join(', ')}.`
        : `La cuenta #${f.comprador.id} (${f.comprador.nombre}) compró ${pluralPedidos(f.pedidos)} de productos de la cuenta #${f.vendedor.id}, que tiene ${vinculoAutocompra(f)}: ${f.productos.join(', ')}.`,
      `Total: ${formatoQ(f.total)} (de ${formatoFechaHora(f.primera)} a ${formatoFechaHora(f.ultima)})`,
      f.mismaCuenta
        ? 'Hoy el sistema ya no permite comprar los propios productos: este pedido es de antes de esa regla. Puede haber sido el vendedor probando su flujo de compra, por eso solo sube a confianza alta si otra señal lo corrobora.'
        : f.mismoBuzon
          ? 'Un comprador que le compra a un vendedor con su mismo buzón de correo no es una coincidencia habitual: parte en confianza alta.'
          : 'Compartir dispositivo (o entrar desde un equipo parecido) no prueba por sí solo que sean la misma persona: parte en "posible" y sube con razones independientes — más de un dispositivo en común, la misma fecha de nacimiento, o que cualquiera de las dos cuentas aparezca en otra señal —. El nombre ya no cuenta: dos personas distintas pueden llamarse igual.',
    ],
    f.corroboradores
  );
}

function razonesReventa(h) {
  const p = h.publicacion;
  const razones = [
    ...h.originales.map(
      (o) =>
        `Compró "${o.producto.nombre}" (producto #${o.producto.id}) a ${o.vendedor.nombre} (cuenta #${o.vendedor.id}): ${pluralUnidades(o.unidades)}${o.precioUnitario != null ? ` a ${formatoQ(o.precioUnitario)} c/u` : ''}, ${o.pedidos.length === 1 ? 'pedido' : 'pedidos'} ${o.pedidos.map((x) => `#${x.compraId}`).join(', ')} (${formatoFechaHora(o.primera)}).`
    ),
    `Hoy vende "${p.nombre}" (producto #${p.id}, ${p.estado}${p.precio != null ? `, ${formatoQ(p.precio)}` : ''}, ${p.cantidad} en stock${p.creadaEn ? `, publicado el ${formatoFechaHora(p.creadaEn)}` : ''}).`,
  ];
  if (h.variacionPrecio != null) {
    const porcentaje = Math.round(Math.abs(h.variacionPrecio) * 100);
    razones.push(porcentaje === 0 ? 'Lo publica al mismo precio que pagó por unidad.' : `Lo publica ${porcentaje}% ${h.variacionPrecio > 0 ? 'por encima de' : 'por debajo de'} lo que pagó por unidad.`);
  }
  razones.push(
    h.compromiso.aceptados > 0
      ? `Aceptó el compromiso de no reventa en ${h.compromiso.aceptados} de ${h.compromiso.pedidos} pedido${h.compromiso.pedidos === 1 ? '' : 's'} (el primero, el ${formatoFechaHora(h.compromiso.primeraAceptacion)}): lo dejó asentado al comprar.`
      : 'Esas compras no llevan constancia de un compromiso de no reventa (son anteriores a que se pidiera).',
    'La coincidencia es de título (mismas palabras significativas, sin importar el orden ni los artículos): no prueba que sea la misma pieza. Por eso parte en "posible" y sube con corroboración.'
  );
  return conCorroboradores(razones, h.corroboradores);
}

function razonesRafaga(r) {
  const razones = [`${pluralPedidos(r.pedidos)} el ${formatoDia(r.dia)} (día de Guatemala), ${formatoQ(r.gastado)} en total.`];
  if (r.reglas.muchosPedidos) {
    razones.push(
      r.maxPedidos === 0
        ? 'No tenía pedidos previos: un volumen así en un solo día es el patrón de una cuenta que prueba un medio de pago.'
        : `Su día más activo hasta entonces tenía ${pluralPedidos(r.maxPedidos)}; este llega al menos al doble.`
    );
  }
  if (r.reglas.muchoGasto) {
    razones.push(`Su gasto diario promedio era ${formatoQ(r.promedioGasto)} (sobre ${r.diasPrevios} días con compras) y el máximo ${formatoQ(r.maxGasto)}: este día lo supera con varios pedidos.`);
  }
  if (r.usuario.ficha?.cuentaReciente) razones.push(`La cuenta es reciente (creada ${diasATexto(r.usuario.ficha.diasDesdeCreacion)}).`);
  return conCorroboradores(razones, r.corroboradores);
}

function razonesGasto(g) {
  const razones = [
    `Compra de ${formatoQ(g.total)} el ${formatoFechaHora(g.fecha)}: ${g.lineas.map((l) => l.nombre).join(', ')}.`,
    `Su compra promedio anterior era ${formatoQ(g.promedio)} y la más alta ${formatoQ(g.maximo)} (sobre ${pluralCompras(g.ordenesPrevias)}).`,
    g.vecesPromedio === null ? 'El monto es muy superior a su promedio previo.' : `El monto equivale a ${g.vecesPromedio.toFixed(1)} veces su promedio y supera su máximo histórico.`,
  ];
  if (g.usuario.ficha?.cuentaReciente) razones.push(`La cuenta es reciente (creada ${diasATexto(g.usuario.ficha.diasDesdeCreacion)}).`);
  return conCorroboradores(razones, g.corroboradores);
}

function razonesCategoria(c) {
  const razones = [
    `Primera compra de ${c.usuario.nombre} en la categoría "${c.categoria}": ${c.productos.map((p) => `${p.nombre} (${p.subcategoria}, ${formatoQ(p.monto)})`).join(', ')}.`,
    `Hasta entonces tenía ${pluralCompras(c.ordenesPrevias)} a lo largo de ${c.diasHistorial} días, solo en: ${c.habituales.map((h) => `${h.categoria} (${h.porcentaje}%)`).join(', ')}.`,
  ];
  if (c.usuario.ficha?.cuentaReciente) razones.push(`La cuenta es reciente (creada ${diasATexto(c.usuario.ficha.diasDesdeCreacion)}).`);
  return conCorroboradores(razones, c.corroboradores);
}

function InsigniaConfianza({ nivel }) {
  const alta = nivel === 'alta';
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-bold uppercase tracking-wide ${alta ? 'bg-danger-600 text-white' : 'bg-neutral-200 text-neutral-600'}`}
    >
      {alta ? 'Confianza alta' : 'Posible coincidencia'}
    </span>
  );
}

// Las reseñas coordinadas no se cruzan con las otras señales (no hay corroboradores que subirlas de nivel), así que el
// servidor no les da nivel de confianza: se dice tal cual en vez de inventarles uno.
function InsigniaSinNivel() {
  return <span className="rounded-full bg-warning-500/10 px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-warning-500">Sin nivel de confianza</span>;
}

function Corroborado({ corroboradores }) {
  if (!corroboradores?.length) return null;
  const tipos = [...new Set(corroboradores.map((c) => ETIQUETAS_SENAL[c.tipo] ?? c.tipo))];
  return <span className="mt-1 block text-xs text-danger-600">Corroborado por: {tipos.join(' + ')}.</span>;
}

const Subtitulo = ({ children }) => <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">{children}</p>;

// Qué vínculo(s) tiene CADA cuenta del grupo, como insignias de su ficha: en una
// cadena, A solo comparte dispositivo, B dispositivo y buzón, C solo buzón.
function notasDeMiembro(a, id) {
  const notas = [];
  if (a.vinculos.some((v) => v.tipo === 'dispositivo' && v.ids.includes(id))) notas.push('Mismo dispositivo');
  if (a.vinculos.some((v) => v.tipo === 'correo' && v.ids.includes(id))) notas.push('Mismo buzón');
  return notas;
}

// ---------- Qué dice cada tipo de caso ----------
//
// Cada señal llega con su propia forma (ver fraudeService.js). Para que la lista de la izquierda y el panel de la
// derecha traten igual a las siete, cada tipo declara aquí lo que muestra, siempre a partir de los mismos campos que el
// servidor ya manda:
//   resumen   una línea para la tarjeta de la lista (y para «otros casos de estas cuentas»)
//   nota      una aclaración corta bajo el resumen, o null
//   razones   los hechos sueltos de «por qué se marcó»
//   fichas    las cuentas involucradas, cada una con las insignias de su papel en el caso
//   cuando    cuándo ocurrió: pares [etiqueta, valor]
//   datos     las cifras que más pesan: pares [etiqueta, valor]
//   visual    el diagrama de relaciones o las barras de magnitud (con el título que lo introduce)

const ficha = (cuenta, notas = []) => ({ id: cuenta.id, nombre: cuenta.nombre, ficha: cuenta.ficha, notas });

const instantes = (fechas) => fechas.filter(Boolean).map((f) => ({ f, t: Date.parse(f) })).filter((x) => Number.isFinite(x.t));
const primeraFecha = (fechas) => instantes(fechas).sort((a, b) => a.t - b.t)[0]?.f ?? null;
const ultimaFecha = (fechas) => instantes(fechas).sort((a, b) => b.t - a.t)[0]?.f ?? null;
const hora = (f) => new Date(f).toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit' });

const VISTAS = {
  autocompra: {
    resumen: resumenAutocompra,
    // Solo el buzón compartido hace «alta» a una compra entre cuentas; con dispositivo o equipo parecido parte en «posible».
    nota: (f) => (!f.mismaCuenta && f.mismoBuzon ? 'Compra entre cuentas con el mismo buzón de correo: alta por sí sola.' : null),
    razones: razonesAutocompra,
    fichas: (f) => [ficha(f.comprador, [f.mismaCuenta ? 'Compra y vende' : 'Comprador']), ...(f.mismaCuenta ? [] : [ficha(f.vendedor, ['Vendedor'])])],
    cuando: (f) =>
      f.primera === f.ultima
        ? [['Pedido', formatoFechaHora(f.primera)]]
        : [['Primer pedido', formatoFechaHora(f.primera)], ['Último pedido', formatoFechaHora(f.ultima)], ['Entre el primero y el último', duracionTexto(f.primera, f.ultima)]],
    datos: (f) => [
      ['Comprador', `${f.comprador.nombre} #${f.comprador.id}`],
      ['Vendedor', f.mismaCuenta ? 'La misma cuenta' : `${f.vendedor.nombre} #${f.vendedor.id}`],
      ['Pedidos', String(f.pedidos)],
      ['Total', formatoQ(f.total)],
      ['Vínculo', f.mismaCuenta ? 'Es la misma cuenta' : vinculoAutocompra(f)],
      ['Productos', f.productos.join(', ')],
    ],
    tituloVisual: 'Relaciones (Neo4j)',
    visual: (f) => <DiagramaAutocompra f={f} />,
  },

  reventa: {
    resumen: resumenReventa,
    nota: () => null,
    razones: razonesReventa,
    fichas: (h) => [
      ficha(h.vendedor, ['Revende']),
      ...[...new Map(h.originales.map((o) => [o.vendedor.id, o.vendedor])).values()].map((v) => ficha(v, ['Vendedor original'])),
    ],
    cuando: (h) => [
      ['Primera compra del original', formatoFechaHora(primeraFecha(h.originales.map((o) => o.primera)))],
      ['Última compra del original', formatoFechaHora(ultimaFecha(h.originales.map((o) => o.ultima ?? o.primera)))],
      ...(h.publicacion.creadaEn ? [['Publicó el suyo', formatoFechaHora(h.publicacion.creadaEn)]] : []),
      ...(h.compromiso.aceptados > 0 ? [['Aceptó no revender desde', formatoFechaHora(h.compromiso.primeraAceptacion)]] : []),
    ],
    datos: (h) => [
      ['Vendedor que revende', `${h.vendedor.nombre} #${h.vendedor.id}`],
      ['Le compró a', [...new Set(h.originales.map((o) => `${o.vendedor.nombre} #${o.vendedor.id}`))].join(', ')],
      ['Compras equivalentes', String(h.originales.length)],
      ['Unidades compradas', String(h.originales.reduce((n, o) => n + o.unidades, 0))],
      ['Hoy vende', `${h.publicacion.nombre} (${h.publicacion.estado})`],
      ...(h.publicacion.precio != null ? [['Precio publicado', formatoQ(h.publicacion.precio)]] : []),
      ...(h.variacionPrecio != null ? [['Frente a lo que pagó', `${h.variacionPrecio > 0 ? '+' : ''}${Math.round(h.variacionPrecio * 100)} %`]] : []),
      ['Compromiso de no reventa', h.compromiso.aceptados > 0 ? `aceptado en ${h.compromiso.aceptados} de ${h.compromiso.pedidos} pedidos` : 'sin constancia'],
    ],
    tituloVisual: 'Relaciones (Neo4j)',
    visual: (h) => <DiagramaReventa h={h} />,
  },

  persona: {
    resumen: resumenPersona,
    nota: (a) => (tieneVinculo(a, 'correo') ? 'Alta por sí sola: comparten buzón de correo.' : null),
    razones: razonesPersona,
    fichas: (a) => a.miembros.map((m) => ficha(m, notasDeMiembro(a, m.id))),
    cuando: (a) => {
      const creadas = a.miembros.map((m) => m.ficha?.creadoEn);
      const filas = [];
      if (primeraFecha(creadas)) {
        filas.push(['Cuenta más antigua creada', formatoFechaHora(primeraFecha(creadas))], ['Cuenta más reciente creada', formatoFechaHora(ultimaFecha(creadas))]);
      }
      // Del dispositivo que comparten solo llega su referencia: el último inicio sale de las fichas de las cuentas.
      for (const v of a.vinculos.filter((x) => x.tipo === 'dispositivo')) {
        const entradas = a.miembros.flatMap((m) => m.ficha?.dispositivos ?? []).filter((d) => d.referencia === v.referencia);
        if (entradas.length > 0) filas.push([`Último inicio desde ${v.referencia}`, formatoFechaHora(ultimaFecha(entradas.map((d) => d.ultimaVez)))]);
      }
      return filas;
    },
    datos: (a) => [
      ['Cuentas', String(a.miembros.length)],
      ['Compras en total', String(a.totalOrdenes)],
      ['Gastado en total', formatoQ(a.totalGastado)],
      ['Vínculo', [tieneVinculo(a, 'dispositivo') && 'mismo dispositivo', tieneVinculo(a, 'correo') && 'mismo buzón de correo'].filter(Boolean).join(' y ')],
      ...(a.mismaFechaNacimiento ? [['Fecha de nacimiento', 'declararon la misma']] : []),
    ],
    tituloVisual: 'Relaciones (Neo4j)',
    visual: (a) => <DiagramaPersona a={a} />,
  },

  resenas: {
    resumen: resumenResenas,
    nota: (r) => {
      const recientes = [r.usuario1, r.usuario2].filter((u) => u.ficha?.cuentaReciente).length;
      return recientes === 0 ? null : recientes === 2 ? 'Las dos cuentas son recientes.' : 'Una de las cuentas es reciente.';
    },
    razones: razonesResenas,
    fichas: (r) => [ficha(r.usuario1), ficha(r.usuario2)],
    cuando: (r) => [
      ...(r.ultimaActividad ? [['Última reseña del grupo', formatoFechaHora(r.ultimaActividad)]] : []),
      ...[r.usuario1, r.usuario2].filter((u) => u.ficha?.creadoEn).map((u) => [`Cuenta #${u.id} creada`, formatoFechaHora(u.ficha.creadoEn)]),
    ],
    datos: (r) => [
      ['Productos en común', String(r.productosCompartidos)],
      ['Calificación promedio', `${r.promedio1.toFixed(1)}★ / ${r.promedio2.toFixed(1)}★`],
      ['Productos', r.productos.join(', ')],
    ],
    tituloVisual: 'Relaciones (Neo4j)',
    visual: (r) => <DiagramaResenas r={r} />,
  },

  rafaga: {
    resumen: resumenRafaga,
    nota: () => null,
    razones: razonesRafaga,
    fichas: (r) => [ficha(r.usuario)],
    cuando: (r) => {
      const fechas = r.ordenes.map((o) => o.fecha);
      return [
        ['Día (hora de Guatemala)', formatoDia(r.dia)],
        ['Primer pedido', primeraFecha(fechas) ? formatoFechaHora(primeraFecha(fechas)) : ''],
        ['Último pedido', ultimaFecha(fechas) ? formatoFechaHora(ultimaFecha(fechas)) : ''],
        ['Entre el primero y el último', duracionTexto(primeraFecha(fechas), ultimaFecha(fechas))],
      ];
    },
    datos: (r) => [
      ['Pedidos ese día', String(r.pedidos)],
      ['Gasto ese día', formatoQ(r.gastado)],
      ['Gasto diario promedio', formatoQ(r.promedioGasto)],
      ['Gasto diario máximo', formatoQ(r.maxGasto)],
      ['Máximo de pedidos en un día', String(r.maxPedidos)],
      ['Reglas que se cumplieron', [r.reglas.muchosPedidos && 'muchos pedidos', r.reglas.muchoGasto && 'mucho gasto'].filter(Boolean).join(' y ')],
    ],
    tituloVisual: 'Ese día frente a su historial',
    visual: (r) => (
      <>
        <Barras
          filas={[
            { etiqueta: 'Gasto diario promedio', valor: r.promedioGasto, texto: formatoQ(r.promedioGasto), tono: 'neutro' },
            { etiqueta: 'Gasto diario máximo', valor: r.maxGasto, texto: formatoQ(r.maxGasto), tono: 'normal' },
            { etiqueta: 'Gasto ese día', valor: r.gastado, texto: formatoQ(r.gastado), tono: 'alerta' },
          ]}
        />
        <Barras
          filas={[
            { etiqueta: 'Pedidos máx. por día', valor: r.maxPedidos, texto: String(r.maxPedidos), tono: 'normal' },
            { etiqueta: 'Pedidos ese día', valor: r.pedidos, texto: String(r.pedidos), tono: 'alerta' },
          ]}
        />
        <Subtitulo>Los pedidos de ese día</Subtitulo>
        <ul className="mt-2 grid max-w-xl grid-cols-1 gap-x-6 gap-y-0.5 text-xs text-neutral-600 sm:grid-cols-2">
          {r.ordenes.map((o) => (
            <li key={o.compraId} className="flex justify-between gap-3">
              <span>
                #{o.compraId} · {hora(o.fecha)}
              </span>
              <span className="tabular-nums">{formatoQ(o.total)}</span>
            </li>
          ))}
        </ul>
      </>
    ),
  },

  gasto: {
    resumen: resumenGasto,
    nota: () => null,
    razones: razonesGasto,
    fichas: (g) => [ficha(g.usuario)],
    cuando: (g) => [['Fecha de la compra', formatoFechaHora(g.fecha)], ['Compra', `#${g.compraId}`]],
    datos: (g) => [
      ['Total de la compra', formatoQ(g.total)],
      ['Promedio previo', formatoQ(g.promedio)],
      ['Máximo previo', formatoQ(g.maximo)],
      ['Frente a su promedio', g.vecesPromedio === null ? 'muy superior' : `${g.vecesPromedio.toFixed(1)} veces`],
      ['Compras previas', String(g.ordenesPrevias)],
      ['Productos', g.lineas.map((l) => l.nombre).join(', ')],
    ],
    tituloVisual: 'Esta compra frente a su historial',
    visual: (g) => (
      <Barras
        filas={[
          { etiqueta: 'Promedio previo', valor: g.promedio, texto: formatoQ(g.promedio), tono: 'neutro' },
          { etiqueta: 'Máximo previo', valor: g.maximo, texto: formatoQ(g.maximo), tono: 'normal' },
          { etiqueta: 'Esta compra', valor: g.total, texto: formatoQ(g.total), tono: 'alerta' },
        ]}
      />
    ),
  },

  categoria: {
    resumen: resumenCategoria,
    nota: () => null,
    razones: razonesCategoria,
    fichas: (c) => [ficha(c.usuario)],
    cuando: (c) => [['Fecha de la compra', formatoFechaHora(c.fecha)], ['Compra', `#${c.compraId}`], ['Historial previo', `${c.diasHistorial} días`]],
    datos: (c) => [
      ['Categoría nueva', c.categoria],
      ['Compras previas', String(c.ordenesPrevias)],
      ['Días de historial', String(c.diasHistorial)],
      ['Categorías habituales', c.habituales.map((h) => `${h.categoria} ${h.porcentaje} %`).join(', ')],
      ['Productos', c.productos.map((p) => `${p.nombre} (${formatoQ(p.monto)})`).join(', ')],
    ],
    tituloVisual: 'Categorías de su historial frente a la nueva',
    visual: (c) => (
      <Barras
        filas={[
          ...c.habituales.map((h) => ({ etiqueta: h.categoria, valor: h.ordenes, texto: `${pluralCompras(h.ordenes)} · ${h.porcentaje}%`, tono: 'normal' })),
          { etiqueta: `${c.categoria} (nueva)`, valor: 1, texto: 'primera compra', tono: 'alerta' },
        ]}
      />
    ),
  },
};

const TITULOS = Object.fromEntries(TIPOS.map((tipo) => [tipo.id, tipo.titulo]));

const DESCRIPCIONES = {
  autocompra:
    'Una cuenta que le compra a sí misma, o a otra cuenta de la misma persona (mismo buzón de correo, mismo dispositivo o un equipo parecido; el nombre ya no cuenta): la forma más directa de mover dinero por el comercio. Hoy el sistema ya impide comprar los propios productos; acá aparecen los pedidos de antes de esa regla y las compras entre cuentas distintas.',
  reventa:
    'Un vendedor que le compró un producto a otro vendedor y hoy tiene publicado y activo uno equivalente. Las cuentas que pueden vender aceptan, al comprar, un compromiso de no reventa; revender lo comprado incumple los Términos de Servicio. La coincidencia es por título: es un candidato para revisión, no una prueba.',
  persona:
    'Varias cuentas que entraron desde el mismo dispositivo (el identificador que el navegador manda al iniciar sesión) o que usan el mismo buzón de correo (ignorando alias «+» y puntos de Gmail), todas comprando por separado. Compartir buzón pesa más que compartir dispositivo; llamarse igual ya no cuenta, porque dos personas distintas pueden hacerlo.',
  resenas: 'Cuentas distintas que reseñaron los mismos productos, calificación alta, dentro de una ventana de tiempo corta.',
  rafaga: 'Muchos pedidos, o mucho gasto, en un solo día — aunque cada pedido por separado parezca normal para esa cuenta.',
  gasto: 'Una compra muy por encima de lo que esa misma cuenta gastó en el pasado, como un banco vigila el gasto de sus clientes.',
  categoria: 'La primera compra en una categoría ajena para una cuenta que ya tenía muchas compras y meses de historial.',
};

// ---------- La lista (izquierda) ----------

// Una tarjeta es un botón: elegirla abre el caso en el panel de la derecha. Es la misma tarjeta de siempre (insignia de
// confianza, resumen de una línea, aclaración y señales que la corroboran); el detalle que antes se desplegaba debajo
// ahora vive en el panel.
function TarjetaCaso({ caso, seleccionado, onElegir }) {
  const vista = VISTAS[caso.tipo];
  const nota = vista.nota(caso.datos);
  const alta = caso.nivel === 'alta';
  const sinNivel = caso.nivel === null;
  const tono = alta ? 'border-danger-500/30 bg-danger-500/5' : sinNivel ? 'border-warning-500/30 bg-warning-500/5' : 'border-neutral-200 bg-neutral-50';
  return (
    <button
      type="button"
      onClick={() => onElegir(caso.clave)}
      aria-pressed={seleccionado}
      data-caso={caso.clave}
      className={`block w-full scroll-mt-32 rounded-lg border p-3 text-left transition-shadow hover:shadow-sm focus-visible:outline-2 focus-visible:outline-brand-500 ${tono} ${seleccionado ? 'ring-2 ring-brand-500' : ''}`}
    >
      {caso.nivel && <InsigniaConfianza nivel={caso.nivel} />}
      <span className={`block text-sm text-neutral-800 ${caso.nivel ? 'mt-2' : ''}`}>{vista.resumen(caso.datos)}</span>
      {nota && <span className={`mt-1 block text-xs ${sinNivel ? 'text-warning-500' : 'text-danger-600'}`}>{nota}</span>}
      <Corroborado corroboradores={caso.datos.corroboradores} />
      <span className="mt-2 block text-xs font-medium text-brand-700">{seleccionado ? 'Viendo este caso →' : 'Ver el caso →'}</span>
    </button>
  );
}

function Seccion({ titulo, descripcion, casos, seleccionado, onElegir }) {
  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-neutral-800">
        {titulo} <span className="font-normal text-neutral-400">({casos.length})</span>
      </h2>
      <p className="mt-1 text-xs text-neutral-500">{descripcion}</p>
      {casos.length === 0 ? (
        <p className="mt-3 text-sm text-neutral-500">Sin patrones señalados por ahora.</p>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          {casos.map((caso) => (
            <TarjetaCaso key={caso.clave} caso={caso} seleccionado={caso.clave === seleccionado} onElegir={onElegir} />
          ))}
        </div>
      )}
    </section>
  );
}

// ---------- El caso (derecha) ----------

function Bloque({ titulo, children }) {
  return (
    <section className="mt-5 border-t border-neutral-200 pt-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{titulo}</h3>
      <div className="mt-2">{children}</div>
    </section>
  );
}

// Pares etiqueta / valor. Un valor vacío se dice con una raya: que falte un dato no puede desalinear la lista.
function ListaDatos({ filas }) {
  return (
    <dl className="grid grid-cols-[minmax(0,9.5rem)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
      {filas.map(([etiqueta, valor], i) => (
        <Fragment key={`${etiqueta}-${i}`}>
          <dt className="text-neutral-500">{etiqueta}</dt>
          <dd className="break-words text-neutral-800">{valor || '—'}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

function PanelCaso({ caso, casos, fueraDeFiltro, marcadas, onElegir, onCerrar }) {
  const vista = VISTAS[caso.tipo];
  const d = caso.datos;
  const nota = vista.nota(d);
  const cuentas = vista.fichas(d);
  const otros = relacionados(casos, caso);

  return (
    <article aria-label={`Caso: ${TITULOS[caso.tipo]}`}>
      <button type="button" onClick={onCerrar} className="mb-3 text-sm font-medium text-brand-700 hover:underline lg:hidden">
        ← Volver a la lista
      </button>

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{TITULOS[caso.tipo]}</p>
          <div className="mt-1.5">{caso.nivel ? <InsigniaConfianza nivel={caso.nivel} /> : <InsigniaSinNivel />}</div>
        </div>
        <button
          type="button"
          onClick={onCerrar}
          className="hidden shrink-0 rounded-lg border border-neutral-300 px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50 lg:inline-block"
        >
          Cerrar ✕
        </button>
      </div>

      <p className="mt-3 text-sm text-neutral-800">{vista.resumen(d)}</p>
      {nota && <p className={`mt-1 text-xs ${caso.nivel === null ? 'text-warning-500' : 'text-danger-600'}`}>{nota}</p>}
      <Corroborado corroboradores={d.corroboradores} />
      {fueraDeFiltro && (
        <p className="mt-3 rounded-lg bg-neutral-100 p-2 text-xs text-neutral-600">Este caso no coincide con los filtros actuales; sigue abierto hasta que elijas otro.</p>
      )}

      <Bloque titulo={cuentas.length === 1 ? 'Cuenta involucrada' : `Cuentas involucradas (${cuentas.length})`}>
        <div className="flex flex-col gap-3">
          {cuentas.map((c) => (
            <FichaUsuario key={c.id} id={c.id} nombre={c.nombre} ficha={c.ficha} notasExtra={c.notas} />
          ))}
        </div>
      </Bloque>

      <Bloque titulo="Cuándo">
        <ListaDatos filas={vista.cuando(d)} />
      </Bloque>

      <Bloque titulo="Datos clave">
        <ListaDatos filas={vista.datos(d)} />
      </Bloque>

      <Bloque titulo="Por qué se marcó">
        {d.motivo && <p className="text-sm text-neutral-800">{d.motivo}</p>}
        <ListaRazones razones={vista.razones(d)} />
      </Bloque>

      <Bloque titulo={vista.tituloVisual}>{vista.visual(d)}</Bloque>

      {otros.length > 0 && (
        <Bloque titulo={`Otros casos de estas cuentas (${otros.length})`}>
          <ul className="flex flex-col gap-2">
            {otros.map((otro) => (
              <li key={otro.clave}>
                <button
                  type="button"
                  onClick={() => onElegir(otro.clave)}
                  className="block w-full rounded-lg border border-neutral-200 p-2.5 text-left text-xs hover:bg-neutral-50"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-neutral-800">{TITULOS[otro.tipo]}</span>
                    {otro.nivel ? <InsigniaConfianza nivel={otro.nivel} /> : <InsigniaSinNivel />}
                  </span>
                  <span className="mt-1 line-clamp-2 block text-neutral-600">{VISTAS[otro.tipo].resumen(otro.datos)}</span>
                </button>
              </li>
            ))}
          </ul>
        </Bloque>
      )}

      {marcadas && (
        <p className="mt-5 border-t border-neutral-200 pt-4 text-xs text-neutral-500">
          Alguna de estas cuentas está suspendida o bajo vigilancia.{' '}
          <Link to="/admin/bloqueos" className="font-medium text-brand-700 hover:underline">
            Ver «Cuentas bloqueadas» →
          </Link>
        </p>
      )}
    </article>
  );
}

function PanelVacio({ casos }) {
  const altas = casos.filter((c) => c.nivel === 'alta').length;
  const cuentas = new Set(casos.flatMap((c) => c.usuarios.map((u) => u.id))).size;
  return (
    <div className="px-2 py-10 text-center">
      <p className="text-sm font-semibold text-neutral-800">Elige un caso de la lista</p>
      <p className="mx-auto mt-1 max-w-xs text-sm text-neutral-500">Aquí verás quiénes son las cuentas, cuándo ocurrió, las cifras que más pesan y por qué se marcó.</p>
      <dl className="mx-auto mt-5 grid max-w-xs grid-cols-3 gap-2 text-center">
        {[
          ['Casos', casos.length],
          ['Confianza alta', altas],
          ['Cuentas', cuentas],
        ].map(([etiqueta, valor]) => (
          <div key={etiqueta} className="flex flex-col-reverse rounded-lg bg-neutral-50 p-2">
            <dt className="text-[11px] text-neutral-500">{etiqueta}</dt>
            <dd className="text-lg font-bold tabular-nums text-neutral-900">{valor}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function CasoNoEncontrado({ onCerrar }) {
  return (
    <div className="px-2 py-10 text-center">
      <p className="text-sm font-semibold text-neutral-800">Este caso ya no aparece</p>
      <p className="mx-auto mt-1 max-w-xs text-sm text-neutral-500">Los datos cambiaron desde que se abrió el enlace, o el caso dejó de cumplir la señal. Elige otro de la lista.</p>
      <button type="button" onClick={onCerrar} className="mt-4 rounded-lg border border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50">
        Volver a la lista
      </button>
    </div>
  );
}

// ---------- La pantalla ----------

const esPantallaChica = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches;

// Señales de posible fraude (Neo4j, ver IA/PLAN-NEO4J-DETECCION-FRAUDE.md §17-§19 y §23) en dos ventanas: a la
// izquierda la lista de siempre, por señal y con su insignia de confianza; a la derecha, el caso elegido con las
// cuentas, cuándo ocurrió, las cifras clave, por qué se marcó y sus relaciones. Arriba, filtros por cuenta, probabilidad,
// relación y vínculo. Los filtros y el caso elegido viven en la URL: un enlace copiado, recargar o el botón «atrás»
// reproducen la misma vista. En el celular las dos ventanas se turnan: la lista, o el caso con un botón para volver.
// Nunca una acusación — candidatos para revisión humana, se dice explícito en la UI, no solo en el documento de diseño.
export function AdminFraudePage() {
  const { token } = useAuth();
  const [parametros, setParametros] = useSearchParams();
  const consulta = parametros.toString();
  const filtros = useMemo(() => leerFiltros(new URLSearchParams(consulta)), [consulta]);

  const [datos, setDatos] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');
  const [actualizadoEn, setActualizadoEn] = useState(null);
  const panelRef = useRef(null);
  const scrollGuardado = useRef(0);

  // El panel de la derecha queda fijo a la vista mientras se baja por la lista, pero la cabecera del sitio también está
  // fija: se mide su altura (cambia con el ancho y si el menú de categorías ocupa dos líneas) para que el panel empiece
  // justo debajo y no quede escondido detrás de ella. El observador avisa una vez al empezar a mirarla.
  const [alturaCabecera, setAlturaCabecera] = useState(104);
  useEffect(() => {
    const cabecera = document.querySelector('header');
    if (!cabecera) return undefined;
    const observador = new ResizeObserver(() => setAlturaCabecera(Math.round(cabecera.getBoundingClientRect().height)));
    observador.observe(cabecera);
    return () => observador.disconnect();
  }, []);

  function cargar() {
    setCargando(true);
    setError('');
    fraudeApi
      .consultar(token)
      .then((respuesta) => {
        setDatos(respuesta);
        setActualizadoEn(new Date());
      })
      .catch((err) => setError(err.message))
      .finally(() => setCargando(false));
  }

  useEffect(cargar, [token]);

  // El texto de la cuenta se muestra tal como se escribe aunque la URL tarde un instante en seguirlo (el router
  // actualiza su estado como transición): `de` recuerda el valor de la URL con el que se escribió, y si la URL cambia
  // por otro lado (atrás, «Limpiar filtros») se muestra la de la URL.
  const [escrito, setEscrito] = useState(null);
  const textoUsuario = escrito && escrito.de === filtros.usuario ? escrito.texto : filtros.usuario;
  const efectivos = useMemo(() => ({ ...filtros, usuario: textoUsuario }), [filtros, textoUsuario]);

  const casos = useMemo(() => (datos ? aplanarCasos(datos) : []), [datos]);
  const visibles = useMemo(() => filtrar(casos, efectivos), [casos, efectivos]);
  const cuentas = useMemo(() => conteos(casos, efectivos), [casos, efectivos]);
  const seleccionado = useMemo(() => casos.find((c) => c.clave === filtros.caso) ?? null, [casos, filtros.caso]);
  const activos = hayFiltros(efectivos);

  // Un solo objeto por carga, no uno nuevo en cada render: lo leen todas las fichas.
  const cuentasMarcadas = useMemo(() => ({ bloqueadas: datos?.bloqueadas ?? {}, restringidas: datos?.restringidas ?? {} }), [datos]);

  // Los filtros reemplazan la entrada del historial (no se llena de una entrada por letra); elegir un caso la agrega,
  // para que «atrás» en el celular vuelva a la lista.
  const cambiar = (siguientes, reemplazar = true) => setParametros(aParametros(siguientes), { replace: reemplazar });
  const escribirUsuario = (texto) => {
    setEscrito({ de: filtros.usuario, texto });
    cambiar(conUsuario(efectivos, texto));
  };
  const elegir = (clave) => {
    if (esPantallaChica()) scrollGuardado.current = window.scrollY;
    cambiar(conCaso(efectivos, clave), false);
  };
  const cerrar = () => cambiar(conCaso(efectivos, ''));
  const limpiar = () => {
    setEscrito(null);
    cambiar(sinFiltros(efectivos));
  };

  // En el celular, abrir un caso lleva arriba (donde está el panel) y cerrarlo devuelve a donde se estaba en la lista.
  // En pantalla grande el panel se queda a la vista y solo vuelve a su inicio al cambiar de caso.
  useEffect(() => {
    if (esPantallaChica()) window.scrollTo(0, filtros.caso ? 0 : scrollGuardado.current);
    if (panelRef.current) panelRef.current.scrollTop = 0;
    // Si el caso se abrió desde «Otros casos de estas cuentas», su tarjeta puede estar lejos en la lista: se acerca a la vista.
    if (!esPantallaChica() && filtros.caso) document.querySelector('button[data-caso][aria-pressed="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [filtros.caso]);

  return (
    <div className="flex flex-col gap-4">
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
          <div className="flex items-center gap-3">
            {actualizadoEn && (
              <span className="text-xs text-neutral-400">
                Actualizado a las {actualizadoEn.toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
            <button onClick={cargar} className="rounded-lg border border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50">
              Actualizar
            </button>
          </div>
        </div>
      </div>

      {cargando && <Spinner />}
      {error && <p className="rounded-lg bg-danger-500/10 p-4 text-sm text-danger-600">{error}</p>}

      {datos && (
        // `bloqueadas` y `restringidas` ({ id → hasta cuándo }) dejan que cada ficha marque
        // a la cuenta si ya está suspendida o bajo vigilancia (ver Cuentas bloqueadas,
        // /admin/bloqueos).
        <BloqueadasContext.Provider value={cuentasMarcadas}>
          {datos.advertencias?.length > 0 && (
            <div className="rounded-lg bg-warning-500/10 p-3 text-sm text-warning-500">
              {datos.advertencias.map((a, i) => (
                <p key={i}>{a}</p>
              ))}
            </div>
          )}

          {/* En el celular, con un caso abierto, los filtros no se ven: filtran la lista, que en ese momento está oculta. */}
          <div className={filtros.caso ? 'hidden lg:block' : ''}>
            <FiltrosFraude
              filtros={efectivos}
              usuarioEscrito={textoUsuario}
              cuentas={cuentas}
              onUsuario={escribirUsuario}
              onNivel={(valor) => cambiar(conNivel(efectivos, valor))}
              onRelacion={(valor) => cambiar(conRelacion(efectivos, valor))}
              onVinculo={(valor) => cambiar(conVinculo(efectivos, valor))}
              onLimpiar={limpiar}
            />
          </div>

          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
            <div className={`min-w-0 flex-col gap-4 ${filtros.caso ? 'hidden lg:flex' : 'flex'}`}>
              {activos && visibles.length === 0 && (
                <div className="rounded-xl border border-neutral-200 bg-white p-6 text-center">
                  <p className="text-sm font-semibold text-neutral-800">Ningún caso coincide con estos filtros</p>
                  <button type="button" onClick={limpiar} className="mt-2 text-sm font-medium text-brand-700 hover:underline">
                    Limpiar filtros
                  </button>
                </div>
              )}
              {TIPOS.map((tipo) => {
                const delTipo = visibles.filter((c) => c.tipo === tipo.id);
                // Con filtros puestos solo se muestran las secciones que tienen algo; sin filtros, todas, como siempre.
                if (activos && delTipo.length === 0) return null;
                return <Seccion key={tipo.id} titulo={tipo.titulo} descripcion={DESCRIPCIONES[tipo.id]} casos={delTipo} seleccionado={filtros.caso} onElegir={elegir} />;
              })}
            </div>

            <aside
              ref={panelRef}
              aria-label="Detalle del caso"
              style={{ '--cabecera': `${alturaCabecera}px` }}
              className={`min-w-0 rounded-xl border border-neutral-200 bg-white p-4 lg:sticky lg:top-[calc(var(--cabecera)+1rem)] lg:max-h-[calc(100vh-var(--cabecera)-2rem)] lg:overflow-y-auto ${filtros.caso ? 'block' : 'hidden lg:block'}`}
            >
              {seleccionado ? (
                <PanelCaso
                  key={seleccionado.clave}
                  caso={seleccionado}
                  casos={casos}
                  fueraDeFiltro={!visibles.some((c) => c.clave === seleccionado.clave)}
                  marcadas={seleccionado.usuarios.some((u) => u.id in cuentasMarcadas.bloqueadas || u.id in cuentasMarcadas.restringidas)}
                  onElegir={elegir}
                  onCerrar={cerrar}
                />
              ) : filtros.caso ? (
                <CasoNoEncontrado onCerrar={cerrar} />
              ) : (
                <PanelVacio casos={casos} />
              )}
            </aside>
          </div>
        </BloqueadasContext.Provider>
      )}
    </div>
  );
}
