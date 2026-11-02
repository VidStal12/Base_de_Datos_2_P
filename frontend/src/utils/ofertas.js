// Ofertas flash en la interfaz: descuento, cuenta regresiva, nivel de urgencia, nivel de stock y orden. Funciones
// puras (sin React ni DOM) para poder probarlas desde backend/tests, igual que utils/filtrosBusqueda.js y
// utils/checkoutIntento.js.

const MINUTO = 60;
const HORA = 60 * MINUTO;
const DIA = 24 * HORA;

// Cuánto se ahorra con la oferta, en un entero entre 0 y 99 (un redondeo nunca dice «100 %»). Sin dos precios válidos,
// o con una «oferta» que no es más barata, es 0 y la tarjeta no muestra la etiqueta.
export function porcentajeDescuento(precioNormal, precioOferta) {
  const normal = Number(precioNormal);
  const oferta = Number(precioOferta);
  if (!(normal > 0) || !(oferta >= 0) || oferta >= normal) return 0;
  return Math.min(99, Math.max(0, Math.round((1 - oferta / normal) * 100)));
}

// Segundos que faltan para `vigenteHasta` (fecha ISO o Date). Una fecha inválida o que ya pasó es 0: la oferta terminó.
// Se redondea hacia arriba, así «00:01» se ve hasta el último instante y el 0 llega justo al vencer.
export function segundosRestantes(vigenteHasta, ahora = Date.now()) {
  const fin = vigenteHasta instanceof Date ? vigenteHasta.getTime() : Date.parse(vigenteHasta);
  if (!Number.isFinite(fin)) return 0;
  return Math.max(0, Math.ceil((fin - ahora) / 1000));
}

// «2 d 03:14:09», «03:14:09» o «14:09»: las horas, los minutos y los segundos siempre con dos cifras.
export function cuentaRegresiva(segundos) {
  const total = Number.isFinite(segundos) ? Math.max(0, Math.floor(segundos)) : 0;
  const dias = Math.floor(total / DIA);
  const horas = Math.floor((total % DIA) / HORA);
  const minutos = Math.floor((total % HORA) / MINUTO);
  const seg = total % MINUTO;
  const dos = (n) => String(n).padStart(2, '0');
  if (dias > 0) return `${dias} d ${dos(horas)}:${dos(minutos)}:${dos(seg)}`;
  if (horas > 0) return `${dos(horas)}:${dos(minutos)}:${dos(seg)}`;
  return `${dos(minutos)}:${dos(seg)}`;
}

// Qué tan cerca está el final: 'critica' (menos de 10 minutos), 'alta' (menos de una hora) o 'normal'. Decide el color
// del temporizador.
export function urgencia(segundos) {
  if (segundos < 10 * MINUTO) return 'critica';
  if (segundos < HORA) return 'alta';
  return 'normal';
}

// Qué parte del cupo queda, de 0 a 100. Sin un total válido se supone que queda todo (no se inventa un faltante).
export function porcentajeRestante(restante, total) {
  const resto = Number(restante);
  const cupo = Number(total);
  if (!(cupo > 0) || !Number.isFinite(resto)) return 100;
  return Math.min(100, Math.max(0, Math.round((resto / cupo) * 100)));
}

// Qué tan agotada va: 'agotandose' (queda el 10 % del cupo o menos, o 2 unidades o menos), 'poco' (el 25 % o menos, o 5
// unidades o menos) o 'normal'. Solo el porcentaje no alcanza: en un cupo de 4, «queda 1» es el 25 % y ya es la última;
// solo la cantidad tampoco: «quedan 5» en un cupo de 500 no apura a nadie.
export function nivelStock(restante, total) {
  const porcentaje = porcentajeRestante(restante, total);
  if (porcentaje <= 10 || restante <= 2) return 'agotandose';
  if (porcentaje <= 25 || restante <= 5) return 'poco';
  return 'normal';
}

// Una oferta lista para dibujar, a partir de lo que devuelven GET /api/productos?soloOfertas=true (el producto, con su
// precio normal y el tamaño original del cupo) y GET /api/ofertas/:id/stock (el precio de oferta, lo que queda AHORA
// —solo Redis lo sabe— y cuándo termina).
export function normalizarOferta({ producto, stock }) {
  const precioNormal = Number(producto.inventario?.precio ?? 0);
  const precioOferta = Number(stock.precio_oferta);
  return {
    id: producto.id,
    nombre: producto.nombre,
    descripcion: producto.descripcion,
    vendedorId: producto.vendedor_id,
    vendedor: producto.vendedor_nombre,
    imagen: producto.imagen_url || '',
    precioNormal,
    precioOferta,
    descuento: porcentajeDescuento(precioNormal, precioOferta),
    restante: stock.restante,
    total: producto.oferta_flash?.stock_oferta ?? stock.restante,
    vigenteHasta: stock.vigente_hasta ?? producto.oferta_flash?.vigente_hasta,
  };
}

export const ORDENES_OFERTA = [
  { valor: 'terminaPronto', texto: 'Terminan primero' },
  { valor: 'mayorDescuento', texto: 'Mayor descuento' },
  { valor: 'menorPrecio', texto: 'Menor precio' },
  { valor: 'ultimasUnidades', texto: 'Últimas unidades' },
];

const fin = (oferta) => {
  const t = Date.parse(oferta.vigenteHasta);
  return Number.isFinite(t) ? t : Infinity;
};

// Las ofertas en el orden pedido, sin tocar la lista original. A igual valor se conserva el orden en que llegaron; un
// criterio desconocido las deja como están.
export function ordenarOfertas(ofertas, criterio) {
  const copia = [...ofertas];
  const comparar = {
    terminaPronto: (a, b) => fin(a) - fin(b),
    mayorDescuento: (a, b) => b.descuento - a.descuento,
    menorPrecio: (a, b) => a.precioOferta - b.precioOferta,
    ultimasUnidades: (a, b) => a.restante - b.restante,
  }[criterio];
  return comparar ? copia.sort(comparar) : copia;
}

// Lo que resume el encabezado de un widget: cuántas hay y en cuánto termina la primera.
export function resumenOfertas(ofertas, ahora = Date.now()) {
  const restantes = ofertas.map((oferta) => segundosRestantes(oferta.vigenteHasta, ahora)).filter((s) => s > 0);
  return { cantidad: restantes.length, terminaPrimero: restantes.length > 0 ? Math.min(...restantes) : 0 };
}

// De la lista de productos con oferta (GET /api/productos?soloOfertas=true), los `limite` cuya oferta termina primero: son los que
// la portada pone al frente, así que recortar la lista por el orden en que llegó dejaría fuera a una que está por vencer. Sin
// fecha válida van al final; a igual fecha se conserva el orden de llegada.
export function primerasEnTerminar(productos, limite) {
  const fin = (producto) => {
    const t = Date.parse(producto.oferta_flash?.vigente_hasta);
    return Number.isFinite(t) ? t : Infinity;
  };
  return [...productos].sort((a, b) => (fin(a) === fin(b) ? 0 : fin(a) < fin(b) ? -1 : 1)).slice(0, limite);
}

// Milisegundos que faltan para que venza la primera oferta que sigue viva, o null si no hay ninguna: el momento justo en
// que conviene volver a pedir la lista para que la vencida desaparezca. Las que ya vencieron (o sin fecha válida) no
// cuentan: si el servidor las sigue devolviendo, esperar a que «venzan» otra vez sería un bucle.
export function proximoVencimiento(ofertas, ahora = Date.now()) {
  const faltan = ofertas.map((oferta) => Date.parse(oferta.vigenteHasta) - ahora).filter((ms) => ms > 0);
  return faltan.length > 0 ? Math.min(...faltan) : null;
}
