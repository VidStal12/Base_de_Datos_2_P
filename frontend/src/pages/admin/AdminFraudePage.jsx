import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { fraudeApi } from '../../api/fraude';
import { Spinner } from '../../components/common/Spinner';
import { FichaUsuario } from '../../components/admin/FichaUsuario';
import { BloqueadasContext } from '../../components/admin/bloqueadasContext';
import { diasATexto, formatoQ } from '../../utils/format';

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

// Relaciones REALES: (u)-[:SE_LLAMA]->(:Nombre)<-[:SE_LLAMA]-(otra) y
// (u)-[:USA_CORREO]->(:Correo)<-[:USA_CORREO]-(otra). Cada vínculo del grupo es
// un nodo COMPARTIDO — el nombre normalizado o el buzón normalizado — al que
// convergen las cuentas que lo comparten; un grupo puede tener varios (una
// pareja con el mismo nombre Y el mismo buzón, o una cadena donde A y B se
// llaman igual y B y C comparten buzón). Las cuentas se reparten en una elipse y
// los nodos compartidos van apilados en el centro; con 2-8 cuentas y 1-3
// vínculos por grupo el reparto se mantiene legible. El hash del buzón nunca
// llega al navegador: el nodo solo dice "mismo buzón".
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
    titulo: v.tipo === 'nombre' ? v.nombre : 'Mismo buzón',
    subtitulo: v.tipo === 'nombre' ? 'mismo nombre' : 'correo normalizado',
    etiqueta: v.tipo === 'nombre' ? 'se llama' : 'usa el buzón',
  }));

  return (
    <svg viewBox="0 0 540 260" className="mt-2 w-full max-w-xl" role="img" aria-label="Diagrama de cuentas que comparten nombre o buzón de correo">
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
// dos cuentas distintas, las une un nodo compartido — el mismo nombre, el mismo
// buzón, o los dos — (las dos SE_LLAMA igual / USA_CORREO el mismo); si es la
// misma cuenta, el mismo nodo compra y vende el mismo producto.
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
  if (f.mismoNombre) hubs.push({ titulo: 'Mismo nombre', subtitulo: 'nombre normalizado', etiqueta: 'se llama' });
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
      <NodoSvg x={270} y={42} w={150} h={42} titulo={original.producto.descripcion} subtitulo="lo que compró" tono="dato" />
      <NodoSvg x={465} y={42} w={130} h={42} titulo={original.vendedor.nombre} subtitulo={`vendedor #${original.vendedor.id}`} tono="otro" />
      <NodoSvg x={270} y={192} w={150} h={42} titulo={h.publicacion.descripcion} subtitulo="lo que hoy vende" tono="dato" />
      <NodoSvg x={465} y={118} w={130} h={36} titulo="Mismo artículo" subtitulo="descripción canónica" tono="dato" />
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
  const porNombre = tieneVinculo(a, 'nombre');
  const porBuzon = tieneVinculo(a, 'correo');
  const quienes = porNombre && porBuzon
    ? `${a.miembros.length} cuentas relacionadas por nombre ("${a.nombre}") y por buzón de correo`
    : porBuzon
      ? `${a.miembros.length} cuentas usan el mismo buzón de correo`
      : `${a.miembros.length} cuentas se llaman "${a.nombre}"`;
  return `${quienes}: ${pluralCompras(a.totalOrdenes)} y ${formatoQ(a.totalGastado)} en total.`;
}

// Cómo se relacionan comprador y vendedor, para una frase: "con el mismo
// nombre", "con el mismo buzón de correo" o las dos.
const vinculoAutocompra = (f) =>
  [f.mismoNombre && 'el mismo nombre', f.mismoBuzon && 'el mismo buzón de correo'].filter(Boolean).join(' y ');

function resumenAutocompra(f) {
  return f.mismaCuenta
    ? `${f.comprador.nombre}: ${pluralPedidos(f.pedidos)} (${formatoQ(f.total)}) de sus propios productos.`
    : `${f.comprador.nombre} (#${f.comprador.id}) le compró ${pluralPedidos(f.pedidos)} (${formatoQ(f.total)}) a ${f.vendedor.nombre} (#${f.vendedor.id}), otra cuenta con ${vinculoAutocompra(f)}.`;
}

const pluralUnidades = (n) => `${n} unidad${n === 1 ? '' : 'es'}`;

function resumenReventa(h) {
  const original = h.originales[0];
  const otras = h.originales.length > 1 ? ` (+${h.originales.length - 1} compra${h.originales.length === 2 ? '' : 's'} equivalente${h.originales.length === 2 ? '' : 's'})` : '';
  return `${h.vendedor.nombre} (#${h.vendedor.id}) le compró "${original.producto.descripcion}" a ${original.vendedor.nombre} (#${original.vendedor.id})${otras} y hoy vende "${h.publicacion.descripcion}"${h.publicacion.precio != null ? ` a ${formatoQ(h.publicacion.precio)}` : ''}.`;
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
    if (v.tipo === 'nombre') {
      return `Las cuentas ${cuentas} se llaman exactamente igual: "${v.nombre}" (mayúsculas, tildes y espacios ya normalizados).`;
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
        ? 'Compartir buzón es evidencia fuerte por sí sola: parte en confianza alta, y delata incluso a quien cambia el nombre en cada cuenta.'
        : 'Dos personas distintas pueden llamarse igual: el nombre solo es una coincidencia a verificar, por eso parte en "posible" salvo que otra cosa lo corrobore.',
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
        : 'Un comprador que le compra a un vendedor de su misma persona (mismo nombre o mismo buzón) no es una coincidencia habitual: parte en confianza alta.',
    ],
    f.corroboradores
  );
}

function razonesReventa(h) {
  const p = h.publicacion;
  const razones = [
    ...h.originales.map(
      (o) =>
        `Compró "${o.producto.descripcion}" (producto #${o.producto.id}) a ${o.vendedor.nombre} (cuenta #${o.vendedor.id}): ${pluralUnidades(o.unidades)}${o.precioUnitario != null ? ` a ${formatoQ(o.precioUnitario)} c/u` : ''}, ${o.pedidos.length === 1 ? 'pedido' : 'pedidos'} ${o.pedidos.map((x) => `#${x.compraId}`).join(', ')} (${formatoFechaHora(o.primera)}).`
    ),
    `Hoy vende "${p.descripcion}" (producto #${p.id}, ${p.estado}${p.precio != null ? `, ${formatoQ(p.precio)}` : ''}, ${p.cantidad} en stock${p.creadaEn ? `, publicado el ${formatoFechaHora(p.creadaEn)}` : ''}).`,
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
    `Compra de ${formatoQ(g.total)} el ${formatoFechaHora(g.fecha)}: ${g.lineas.map((l) => l.descripcion).join(', ')}.`,
    `Su compra promedio anterior era ${formatoQ(g.promedio)} y la más alta ${formatoQ(g.maximo)} (sobre ${pluralCompras(g.ordenesPrevias)}).`,
    g.vecesPromedio === null ? 'El monto es muy superior a su promedio previo.' : `El monto equivale a ${g.vecesPromedio.toFixed(1)} veces su promedio y supera su máximo histórico.`,
  ];
  if (g.usuario.ficha?.cuentaReciente) razones.push(`La cuenta es reciente (creada ${diasATexto(g.usuario.ficha.diasDesdeCreacion)}).`);
  return conCorroboradores(razones, g.corroboradores);
}

function razonesCategoria(c) {
  const razones = [
    `Primera compra de ${c.usuario.nombre} en la categoría "${c.categoria}": ${c.productos.map((p) => `${p.descripcion} (${p.subcategoria}, ${formatoQ(p.monto)})`).join(', ')}.`,
    `Hasta entonces tenía ${pluralCompras(c.ordenesPrevias)} a lo largo de ${c.diasHistorial} días, solo en: ${c.habituales.map((h) => `${h.categoria} (${h.porcentaje}%)`).join(', ')}.`,
  ];
  if (c.usuario.ficha?.cuentaReciente) razones.push(`La cuenta es reciente (creada ${diasATexto(c.usuario.ficha.diasDesdeCreacion)}).`);
  return conCorroboradores(razones, c.corroboradores);
}

function BotonDetalle({ expandido, onClick }) {
  return (
    <button onClick={onClick} className="mt-2 flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline">
      {expandido ? '▴ Ocultar detalle completo' : '▾ Ver detalle completo — por qué y relaciones'}
    </button>
  );
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

function Corroborado({ corroboradores }) {
  if (!corroboradores?.length) return null;
  const tipos = [...new Set(corroboradores.map((c) => ETIQUETAS_SENAL[c.tipo] ?? c.tipo))];
  return <p className="mt-1 text-xs text-danger-600">Corroborado por: {tipos.join(' + ')}.</p>;
}

// Contenedor común a las señales con nivel de confianza: borde y fondo en tono
// de peligro cuando la confianza es alta, neutro cuando es solo posible. `nota`:
// por qué es "alta" cuando la evidencia es propia del hallazgo y no una segunda
// señal (el buzón compartido, o una compra entre cuentas de una misma persona).
function TarjetaHallazgo({ nivel, resumen, corroboradores, nota, children }) {
  const [expandido, setExpandido] = useState(false);
  const alta = nivel === 'alta';
  return (
    <div className={`rounded-lg border p-3 ${alta ? 'border-danger-500/30 bg-danger-500/5' : 'border-neutral-200 bg-neutral-50'}`}>
      <InsigniaConfianza nivel={nivel} />
      <p className="mt-2 text-sm text-neutral-800">{resumen}</p>
      {nota && <p className="mt-1 text-xs text-danger-600">{nota}</p>}
      <Corroborado corroboradores={corroboradores} />
      <BotonDetalle expandido={expandido} onClick={() => setExpandido((v) => !v)} />
      {expandido && <div className={`mt-3 border-t pt-3 ${alta ? 'border-danger-500/20' : 'border-neutral-200'}`}>{children}</div>}
    </div>
  );
}

const Subtitulo = ({ children }) => <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">{children}</p>;
const GrillaFichas = ({ children }) => <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">{children}</div>;

function HallazgoResenas({ r }) {
  const [expandido, setExpandido] = useState(false);
  const recientes = [r.usuario1, r.usuario2].filter((u) => u.ficha?.cuentaReciente).length;

  return (
    <div className="rounded-lg border border-warning-500/30 bg-warning-500/5 p-3">
      <p className="text-sm text-neutral-800">{resumenResenas(r)}</p>
      {recientes > 0 && (
        <p className="mt-1 text-xs text-warning-500">{recientes === 2 ? 'Las dos cuentas son recientes.' : 'Una de las cuentas es reciente.'}</p>
      )}
      <BotonDetalle expandido={expandido} onClick={() => setExpandido((v) => !v)} />

      {expandido && (
        <div className="mt-3 border-t border-warning-500/20 pt-3">
          <p className="text-sm text-neutral-800">{r.motivo}</p>
          <Subtitulo>Por qué se marcó</Subtitulo>
          <ListaRazones razones={razonesResenas(r)} />
          <Subtitulo>Relaciones (Neo4j)</Subtitulo>
          <DiagramaResenas r={r} />
          <GrillaFichas>
            <FichaUsuario id={r.usuario1.id} nombre={r.usuario1.nombre} ficha={r.usuario1.ficha} />
            <FichaUsuario id={r.usuario2.id} nombre={r.usuario2.nombre} ficha={r.usuario2.ficha} />
          </GrillaFichas>
          {r.ultimaActividad && <p className="mt-2 text-xs text-neutral-400">Última reseña del grupo: {new Date(r.ultimaActividad).toLocaleString('es-GT')}</p>}
        </div>
      )}
    </div>
  );
}

// Qué vínculo(s) tiene CADA cuenta del grupo, como insignias de su ficha: en una
// cadena, A solo comparte nombre, B nombre y buzón, C solo buzón.
function notasDeMiembro(a, id) {
  const notas = [];
  if (a.vinculos.some((v) => v.tipo === 'nombre' && v.ids.includes(id))) notas.push('Mismo nombre');
  if (a.vinculos.some((v) => v.tipo === 'correo' && v.ids.includes(id))) notas.push('Mismo buzón');
  return notas;
}

function HallazgoPersona({ a }) {
  return (
    <TarjetaHallazgo
      nivel={a.nivelConfianza}
      resumen={resumenPersona(a)}
      corroboradores={a.corroboradores}
      nota={tieneVinculo(a, 'correo') ? 'Alta por sí sola: comparten buzón de correo.' : null}
    >
      <p className="text-sm text-neutral-800">{a.motivo}</p>
      <Subtitulo>Por qué se marcó</Subtitulo>
      <ListaRazones razones={razonesPersona(a)} />
      <Subtitulo>Relaciones (Neo4j)</Subtitulo>
      <DiagramaPersona a={a} />
      <GrillaFichas>
        {a.miembros.map((m) => (
          <FichaUsuario key={m.id} id={m.id} nombre={m.nombre} ficha={m.ficha} notasExtra={notasDeMiembro(a, m.id)} />
        ))}
      </GrillaFichas>
    </TarjetaHallazgo>
  );
}

function HallazgoAutocompra({ f }) {
  return (
    <TarjetaHallazgo
      nivel={f.nivelConfianza}
      resumen={resumenAutocompra(f)}
      corroboradores={f.corroboradores}
      nota={f.mismaCuenta ? null : 'Compra entre cuentas de una misma persona: alta por sí sola.'}
    >
      <p className="text-sm text-neutral-800">{f.motivo}</p>
      <Subtitulo>Por qué se marcó</Subtitulo>
      <ListaRazones razones={razonesAutocompra(f)} />
      <Subtitulo>Relaciones (Neo4j)</Subtitulo>
      <DiagramaAutocompra f={f} />
      <GrillaFichas>
        <FichaUsuario id={f.comprador.id} nombre={f.comprador.nombre} ficha={f.comprador.ficha} notasExtra={[f.mismaCuenta ? 'Compra y vende' : 'Comprador']} />
        {!f.mismaCuenta && <FichaUsuario id={f.vendedor.id} nombre={f.vendedor.nombre} ficha={f.vendedor.ficha} notasExtra={['Vendedor']} />}
      </GrillaFichas>
    </TarjetaHallazgo>
  );
}

function HallazgoReventa({ h }) {
  return (
    <TarjetaHallazgo nivel={h.nivelConfianza} resumen={resumenReventa(h)} corroboradores={h.corroboradores}>
      <p className="text-sm text-neutral-800">{h.motivo}</p>
      <Subtitulo>Por qué se marcó</Subtitulo>
      <ListaRazones razones={razonesReventa(h)} />
      <Subtitulo>Relaciones (Neo4j)</Subtitulo>
      <DiagramaReventa h={h} />
      <GrillaFichas>
        <FichaUsuario id={h.vendedor.id} nombre={h.vendedor.nombre} ficha={h.vendedor.ficha} notasExtra={['Revende']} />
        {[...new Map(h.originales.map((o) => [o.vendedor.id, o.vendedor])).values()].map((v) => (
          <FichaUsuario key={v.id} id={v.id} nombre={v.nombre} ficha={v.ficha} notasExtra={['Vendedor original']} />
        ))}
      </GrillaFichas>
    </TarjetaHallazgo>
  );
}

function HallazgoRafaga({ r }) {
  return (
    <TarjetaHallazgo nivel={r.nivelConfianza} resumen={resumenRafaga(r)} corroboradores={r.corroboradores}>
      <p className="text-sm text-neutral-800">{r.motivo}</p>
      <Subtitulo>Por qué se marcó</Subtitulo>
      <ListaRazones razones={razonesRafaga(r)} />
      <Subtitulo>Ese día frente a su historial</Subtitulo>
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
              #{o.compraId} · {new Date(o.fecha).toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit' })}
            </span>
            <span className="tabular-nums">{formatoQ(o.total)}</span>
          </li>
        ))}
      </ul>
      <GrillaFichas>
        <FichaUsuario id={r.usuario.id} nombre={r.usuario.nombre} ficha={r.usuario.ficha} />
      </GrillaFichas>
    </TarjetaHallazgo>
  );
}

function HallazgoGasto({ g }) {
  return (
    <TarjetaHallazgo nivel={g.nivelConfianza} resumen={resumenGasto(g)} corroboradores={g.corroboradores}>
      <p className="text-sm text-neutral-800">{g.motivo}</p>
      <Subtitulo>Por qué se marcó</Subtitulo>
      <ListaRazones razones={razonesGasto(g)} />
      <Subtitulo>Esta compra frente a su historial</Subtitulo>
      <Barras
        filas={[
          { etiqueta: 'Promedio previo', valor: g.promedio, texto: formatoQ(g.promedio), tono: 'neutro' },
          { etiqueta: 'Máximo previo', valor: g.maximo, texto: formatoQ(g.maximo), tono: 'normal' },
          { etiqueta: 'Esta compra', valor: g.total, texto: formatoQ(g.total), tono: 'alerta' },
        ]}
      />
      <GrillaFichas>
        <FichaUsuario id={g.usuario.id} nombre={g.usuario.nombre} ficha={g.usuario.ficha} />
      </GrillaFichas>
      <p className="mt-2 text-xs text-neutral-400">
        Compra #{g.compraId} · {formatoFechaHora(g.fecha)}
      </p>
    </TarjetaHallazgo>
  );
}

function HallazgoCategoria({ c }) {
  return (
    <TarjetaHallazgo nivel={c.nivelConfianza} resumen={resumenCategoria(c)} corroboradores={c.corroboradores}>
      <p className="text-sm text-neutral-800">{c.motivo}</p>
      <Subtitulo>Por qué se marcó</Subtitulo>
      <ListaRazones razones={razonesCategoria(c)} />
      <Subtitulo>Categorías de su historial frente a la nueva</Subtitulo>
      <Barras
        filas={[
          ...c.habituales.map((h) => ({ etiqueta: h.categoria, valor: h.ordenes, texto: `${pluralCompras(h.ordenes)} · ${h.porcentaje}%`, tono: 'normal' })),
          { etiqueta: `${c.categoria} (nueva)`, valor: 1, texto: 'primera compra', tono: 'alerta' },
        ]}
      />
      <GrillaFichas>
        <FichaUsuario id={c.usuario.id} nombre={c.usuario.nombre} ficha={c.usuario.ficha} />
      </GrillaFichas>
      <p className="mt-2 text-xs text-neutral-400">
        Compra #{c.compraId} · {formatoFechaHora(c.fecha)}
      </p>
    </TarjetaHallazgo>
  );
}

function Seccion({ titulo, descripcion, hallazgos, renderizar }) {
  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-neutral-800">{titulo}</h2>
      <p className="mt-1 text-xs text-neutral-500">{descripcion}</p>
      {hallazgos.length === 0 ? (
        <p className="mt-3 text-sm text-neutral-500">Sin patrones señalados por ahora.</p>
      ) : (
        <div className="mt-3 flex flex-col gap-4">{hallazgos.map(renderizar)}</div>
      )}
    </section>
  );
}

// Señales de posible fraude (Neo4j, ver IA/PLAN-NEO4J-DETECCION-FRAUDE.md
// §17-§19) — cada hallazgo se muestra colapsado por defecto (resumen de una línea
// + insignia de confianza), con un botón para expandir el motivo completo en
// prosa, la lista de razones y las relaciones/magnitudes que lo respaldan.
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

  // Un solo objeto por carga, no uno nuevo en cada render: lo leen todas las fichas.
  const cuentasMarcadas = useMemo(() => ({ bloqueadas: datos?.bloqueadas ?? {}, restringidas: datos?.restringidas ?? {} }), [datos]);

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

          <Seccion
            titulo="Autocompra"
            descripcion="Una cuenta que le compra a sí misma, o a otra cuenta de la misma persona (mismo nombre o mismo buzón de correo): la forma más directa de mover dinero por el comercio. Hoy el sistema ya impide comprar los propios productos; acá aparecen los pedidos de antes de esa regla y las compras entre cuentas distintas."
            hallazgos={datos.autocompra}
            renderizar={(f) => <HallazgoAutocompra key={`${f.comprador.id}-${f.vendedor.id}`} f={f} />}
          />
          <Seccion
            titulo="Reventa de lo comprado"
            descripcion="Un vendedor que le compró un producto a otro vendedor y hoy tiene publicado y activo uno equivalente. Las cuentas que pueden vender aceptan, al comprar, un compromiso de no reventa; revender lo comprado incumple los Términos de Servicio. La coincidencia es por título: es un candidato para revisión, no una prueba."
            hallazgos={datos.reventa ?? []}
            renderizar={(h) => <HallazgoReventa key={`${h.vendedor.id}-${h.publicacion.id}`} h={h} />}
          />
          <Seccion
            titulo="Cuentas de una misma persona"
            descripcion="Varias cuentas que se llaman exactamente igual (ignorando mayúsculas y tildes) o que usan el mismo buzón de correo (ignorando alias «+» y puntos de Gmail), todas comprando por separado. Compartir buzón pesa más que compartir nombre."
            hallazgos={datos.cuentasRelacionadas}
            renderizar={(a) => <HallazgoPersona key={a.clave} a={a} />}
          />
          <Seccion
            titulo="Reseñas coordinadas"
            descripcion="Cuentas distintas que reseñaron los mismos productos, calificación alta, dentro de una ventana de tiempo corta."
            hallazgos={datos.resenasCoordinadas}
            renderizar={(r, i) => <HallazgoResenas key={i} r={r} />}
          />
          <Seccion
            titulo="Ráfaga de gasto"
            descripcion="Muchos pedidos, o mucho gasto, en un solo día — aunque cada pedido por separado parezca normal para esa cuenta."
            hallazgos={datos.rafagaGasto}
            renderizar={(r) => <HallazgoRafaga key={`${r.usuario.id}-${r.dia}`} r={r} />}
          />
          <Seccion
            titulo="Gasto anómalo"
            descripcion="Una compra muy por encima de lo que esa misma cuenta gastó en el pasado, como un banco vigila el gasto de sus clientes."
            hallazgos={datos.gastoAnomalo}
            renderizar={(g) => <HallazgoGasto key={g.compraId} g={g} />}
          />
          <Seccion
            titulo="Categoría inusual"
            descripcion="La primera compra en una categoría ajena para una cuenta que ya tenía muchas compras y meses de historial."
            hallazgos={datos.categoriaInusual}
            renderizar={(c) => <HallazgoCategoria key={`${c.usuario.id}-${c.categoria}`} c={c} />}
          />
        </BloqueadasContext.Provider>
      )}
    </div>
  );
}
