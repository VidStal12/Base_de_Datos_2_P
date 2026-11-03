// Lista «Mis productos» del vendedor: búsqueda, filtros, orden y paginación sobre los productos ya cargados (GET
// /api/productos?vendedorId=…, que trae TODOS los del vendedor en una sola respuesta). Funciones puras (sin React ni DOM)
// para poder probarlas desde backend/tests, igual que utils/filtrosBusqueda.js y utils/ofertas.js. El estado vive en la URL
// (?q=&estado=&sub=&stock=&orden=&pagina=&por=): el botón «atrás», un enlace copiado y la vuelta desde «Editar» lo restauran.
//
// Todo se resuelve en el navegador porque un vendedor tiene a lo sumo cientos o pocos miles de productos y cada tecla tiene
// que filtrar al instante. Si la API algún día pagina, esta capa se reemplaza por una consulta con los mismos parámetros
// sin tocar la pantalla.

export const POR_PAGINA = [10, 25, 50];
export const POR_PAGINA_INICIAL = 10;
// «Poco stock»: de 1 a 5 unidades (el mismo umbral que utils/ofertas.js usa para avisar que un cupo se agota).
export const POCO_STOCK = 5;
const MAX_TOKENS = 8;
export const LARGO_MAXIMO_BUSQUEDA = 120;

export const ESTADOS = [
  { valor: '', texto: 'Todos' },
  { valor: 'activo', texto: 'Activos' },
  { valor: 'inactivo', texto: 'Inactivos' },
];

export const NIVELES_STOCK = [
  { valor: '', texto: 'Todo el stock' },
  { valor: 'con', texto: 'Con stock' },
  { valor: 'poco', texto: `Poco stock (1 a ${POCO_STOCK})` },
  { valor: 'agotado', texto: 'Agotados' },
];

// 'relevancia' solo tiene sentido con un texto buscado; sin texto, el orden por defecto es el de los más recientes.
export const ORDENES = [
  { valor: 'relevancia', texto: 'Relevancia' },
  { valor: 'recientes', texto: 'Más recientes' },
  { valor: 'nombreAsc', texto: 'Nombre: de A a Z' },
  { valor: 'nombreDesc', texto: 'Nombre: de Z a A' },
  { valor: 'precioAsc', texto: 'Precio: de menor a mayor' },
  { valor: 'precioDesc', texto: 'Precio: de mayor a menor' },
  { valor: 'stockAsc', texto: 'Stock: de menos a más' },
  { valor: 'stockDesc', texto: 'Stock: de más a menos' },
  { valor: 'vendidos', texto: 'Más vendidos' },
];

// ── Normalización ───────────────────────────────────────────────────────────────────────────────────────────────────
// «Algodón» y «algodon» son lo mismo para quien busca. `normalizarConMapa` conserva a qué posición del texto ORIGINAL
// corresponde cada carácter normalizado (una letra con tilde se descompone en varias unidades), para poder resaltar el
// original sin perder la tilde.
function normalizarConMapa(texto) {
  let normal = '';
  const inicio = [];
  const fin = [];
  let posicion = 0;
  for (const caracter of String(texto ?? '')) {
    const base = caracter.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    for (let k = 0; k < base.length; k++) {
      normal += base[k];
      inicio.push(posicion);
      fin.push(posicion + caracter.length);
    }
    posicion += caracter.length;
  }
  return { normal, inicio, fin };
}

export const normalizar = (texto) => String(texto ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

// Las palabras de la búsqueda: todas tienen que aparecer (en cualquier orden y en cualquier campo). Sin repetidas.
export function tokensDeBusqueda(consulta) {
  return [...new Set(normalizar(String(consulta ?? '').slice(0, LARGO_MAXIMO_BUSQUEDA)).split(' ').filter(Boolean))].slice(0, MAX_TOKENS);
}

// ── Qué se busca de cada producto ───────────────────────────────────────────────────────────────────────────────────
// Se normaliza una sola vez por producto (la lista cargada no cambia mientras se escribe).
const indices = new WeakMap();
function indice(producto) {
  let hecho = indices.get(producto);
  if (!hecho) {
    hecho = {
      id: String(producto.id),
      nombre: normalizar(producto.nombre),
      categoria: normalizar(`${producto.subcategoria?.subcategoria ?? ''} ${producto.subcategoria?.categoria ?? ''}`),
      descripcion: normalizar(producto.descripcion),
      atributos: normalizar((producto.atributos ?? []).map((a) => `${a.nombre} ${a.valor}`).join(' ')),
    };
    indices.set(producto, hecho);
  }
  return hecho;
}

const esNumero = (token) => /^\d+$/.test(token);
// «#12» es EXACTAMENTE el producto 12; «12» también lo encuentra, además de lo que tenga ese número en el texto («128GB»).
function coincideToken(i, token) {
  if (token.startsWith('#')) return i.id === token.slice(1);
  if (esNumero(token) && i.id === token) return true;
  return i.nombre.includes(token) || i.categoria.includes(token) || i.atributos.includes(token) || i.descripcion.includes(token);
}

export const coincide = (producto, tokens) => tokens.length === 0 || tokens.every((t) => coincideToken(indice(producto), t));

// Qué tan buena es la coincidencia: el nombre pesa más que la categoría, y esta más que los atributos y la descripción;
// empezar una palabra vale más que estar en el medio de ella.
function puntajeToken(i, token) {
  if (token.startsWith('#')) return i.id === token.slice(1) ? 100 : 0;
  let puntos = esNumero(token) && i.id === token ? 100 : 0;
  const enNombre = i.nombre.indexOf(token);
  if (enNombre === 0) puntos = Math.max(puntos, 50);
  else if (enNombre > 0) puntos = Math.max(puntos, i.nombre[enNombre - 1] === ' ' ? 40 : 30);
  if (i.categoria.includes(token)) puntos = Math.max(puntos, 20);
  if (i.atributos.includes(token)) puntos = Math.max(puntos, 12);
  if (i.descripcion.includes(token)) puntos = Math.max(puntos, 10);
  return puntos;
}
export const puntaje = (producto, tokens) => tokens.reduce((suma, token) => suma + puntajeToken(indice(producto), token), 0);

// ── Filtros ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export const FILTROS_VACIOS = { q: '', estado: '', sub: '', stock: '', orden: '', pagina: 1, por: 0 };

const cantidadDe = (producto) => Number(producto.inventario?.cantidad ?? 0) || 0;
const precioDe = (producto) => Number(producto.inventario?.precio ?? 0) || 0;
export function nivelStock(producto) {
  const cantidad = cantidadDe(producto);
  if (cantidad <= 0) return 'agotado';
  return cantidad <= POCO_STOCK ? 'poco' : 'con';
}

// `omitir` deja fuera UN filtro: así se cuenta cada faceta con todos los demás aplicados menos el suyo (la misma idea que
// la barra lateral de la portada: marcar «Activos» no esconde cuántos hay inactivos).
function cumple(producto, filtros, omitir) {
  if (omitir !== 'estado' && filtros.estado && producto.estado !== filtros.estado) return false;
  if (omitir !== 'sub' && filtros.sub && producto.subcategoria?.id !== filtros.sub) return false;
  if (omitir !== 'stock' && filtros.stock && nivelStock(producto) !== filtros.stock) return false;
  return true;
}

export function filtrar(productos, filtros) {
  const tokens = tokensDeBusqueda(filtros.q);
  return productos.filter((p) => cumple(p, filtros, null) && coincide(p, tokens));
}

// Los conteos de cada opción de los filtros (estado, stock y categoría) según lo que HAY elegido en los demás.
export function facetas(productos, filtros) {
  const tokens = tokensDeBusqueda(filtros.q);
  const coincidentes = productos.filter((p) => coincide(p, tokens));
  const estados = { total: 0, activo: 0, inactivo: 0 };
  const stock = { total: 0, con: 0, poco: 0, agotado: 0 };
  const subcategorias = new Map();
  // Todas las subcategorías del vendedor figuran siempre (con 0 si nada coincide): el filtro no cambia de forma al escribir.
  for (const p of productos) {
    const id = p.subcategoria?.id;
    if (id && !subcategorias.has(id)) subcategorias.set(id, { id, nombre: p.subcategoria.subcategoria ?? 'Sin nombre', categoria: p.subcategoria.categoria ?? 'Sin categoría', cantidad: 0 });
  }
  for (const p of coincidentes) {
    if (cumple(p, filtros, 'estado')) {
      estados.total += 1;
      if (p.estado === 'activo' || p.estado === 'inactivo') estados[p.estado] += 1;
    }
    if (cumple(p, filtros, 'stock')) {
      stock.total += 1;
      stock[nivelStock(p)] += 1;
    }
    if (cumple(p, filtros, 'sub') && p.subcategoria?.id) subcategorias.get(p.subcategoria.id).cantidad += 1;
  }
  const ordenadas = [...subcategorias.values()].sort((a, b) => a.categoria.localeCompare(b.categoria, 'es') || a.nombre.localeCompare(b.nombre, 'es'));
  return { estados, stock, subcategorias: ordenadas };
}

// Las subcategorías agrupadas por categoría, para un <select> con <optgroup>.
export function agruparPorCategoria(subcategorias) {
  const grupos = [];
  for (const sub of subcategorias) {
    const grupo = grupos.find((g) => g.categoria === sub.categoria);
    if (grupo) grupo.subs.push(sub);
    else grupos.push({ categoria: sub.categoria, subs: [sub] });
  }
  return grupos;
}

// ── Orden ───────────────────────────────────────────────────────────────────────────────────────────────────────────
export const ordenEfectivo = (orden, hayTexto) => orden || (hayTexto ? 'relevancia' : 'recientes');

// Una copia ordenada (la lista original no se toca). A igual valor, el producto más reciente (el de mayor id) va primero.
export function ordenar(productos, orden, tokens = []) {
  const elegido = ordenEfectivo(orden, tokens.length > 0);
  const reciente = (a, b) => b.id - a.id;
  const comparar = {
    relevancia: (a, b) => puntaje(b, tokens) - puntaje(a, tokens),
    recientes: reciente,
    nombreAsc: (a, b) => String(a.nombre ?? '').localeCompare(String(b.nombre ?? ''), 'es', { sensitivity: 'base', numeric: true }),
    nombreDesc: (a, b) => String(b.nombre ?? '').localeCompare(String(a.nombre ?? ''), 'es', { sensitivity: 'base', numeric: true }),
    precioAsc: (a, b) => precioDe(a) - precioDe(b),
    precioDesc: (a, b) => precioDe(b) - precioDe(a),
    stockAsc: (a, b) => cantidadDe(a) - cantidadDe(b),
    stockDesc: (a, b) => cantidadDe(b) - cantidadDe(a),
    vendidos: (a, b) => (Number(b.total_vendido) || 0) - (Number(a.total_vendido) || 0),
  }[elegido] ?? reciente;
  return [...productos].sort((a, b) => comparar(a, b) || reciente(a, b));
}

// ── Paginación ──────────────────────────────────────────────────────────────────────────────────────────────────────
// La página pedida se acota al rango real: un enlace viejo con ?pagina=9 cuando ahora hay 3 muestra la última, no nada.
export function paginar(items, pagina, por) {
  const tamano = POR_PAGINA.includes(por) ? por : POR_PAGINA_INICIAL;
  const total = items.length;
  const paginas = Math.max(1, Math.ceil(total / tamano));
  const actual = Math.min(Math.max(1, Math.trunc(pagina) || 1), paginas);
  return {
    items: items.slice((actual - 1) * tamano, actual * tamano),
    pagina: actual,
    paginas,
    por: tamano,
    total,
    desde: total === 0 ? 0 : (actual - 1) * tamano + 1,
    hasta: Math.min(actual * tamano, total),
  };
}

// ── La URL ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// `por: 0` es «sin elegir en esta URL»: la pantalla usa entonces la preferencia guardada del vendedor.
export function leerFiltros(parametros) {
  const estado = parametros.get('estado');
  const stock = parametros.get('stock');
  const orden = parametros.get('orden');
  const por = Number.parseInt(parametros.get('por'), 10);
  return {
    q: (parametros.get('q') || '').slice(0, LARGO_MAXIMO_BUSQUEDA),
    estado: estado === 'activo' || estado === 'inactivo' ? estado : '',
    sub: parametros.get('sub') || '',
    stock: NIVELES_STOCK.some((n) => n.valor && n.valor === stock) ? stock : '',
    orden: ORDENES.some((o) => o.valor === orden && o.valor !== 'relevancia') ? orden : '',
    pagina: Math.max(1, Number.parseInt(parametros.get('pagina'), 10) || 1),
    por: POR_PAGINA.includes(por) ? por : 0,
  };
}

// Objeto plano de strings, sin lo vacío ni lo que es el valor por defecto: sirve para la URL de la página.
export function aParametros(filtros) {
  const salida = {};
  if (filtros.q) salida.q = filtros.q;
  if (filtros.estado) salida.estado = filtros.estado;
  if (filtros.sub) salida.sub = filtros.sub;
  if (filtros.stock) salida.stock = filtros.stock;
  if (filtros.orden) salida.orden = filtros.orden;
  if (filtros.pagina > 1) salida.pagina = String(filtros.pagina);
  if (filtros.por) salida.por = String(filtros.por);
  return salida;
}

// Cualquier cambio de filtro vuelve a la página 1.
export const conBusqueda = (f, q) => ({ ...f, q: String(q ?? '').slice(0, LARGO_MAXIMO_BUSQUEDA), pagina: 1 });
export const conEstado = (f, estado) => ({ ...f, estado, pagina: 1 });
export const conSubcategoria = (f, sub) => ({ ...f, sub, pagina: 1 });
export const conStock = (f, stock) => ({ ...f, stock, pagina: 1 });
export const conOrden = (f, orden) => ({ ...f, orden, pagina: 1 });
export const conPagina = (f, pagina) => ({ ...f, pagina });
export const conPor = (f, por) => ({ ...f, por, pagina: 1 });
// «Limpiar»: se va todo lo que filtra; el orden y el tamaño de página son preferencias, no filtros, y se conservan.
export const sinFiltros = (f) => ({ ...f, q: '', estado: '', sub: '', stock: '', pagina: 1 });
export const hayFiltros = (f) => Boolean(f.q || f.estado || f.sub || f.stock);

// Una subcategoría de la URL que el vendedor ya no tiene (o nunca tuvo) se ignora en vez de dejar la lista vacía sin motivo.
export function sanear(filtros, productos) {
  if (filtros.sub && !productos.some((p) => p.subcategoria?.id === filtros.sub)) return { ...filtros, sub: '' };
  return filtros;
}

// ── Resaltado y fragmento ───────────────────────────────────────────────────────────────────────────────────────────
// El texto partido en tramos, marcando los que coinciden con alguna palabra buscada (sin importar tildes ni mayúsculas).
// Devuelve el texto ORIGINAL: nunca se reconstruye a partir del normalizado.
export function resaltar(texto, tokens) {
  const original = String(texto ?? '');
  const buscados = tokens.filter((t) => t && !t.startsWith('#'));
  if (!original || buscados.length === 0) return [{ texto: original, resaltado: false }];
  const { normal, inicio, fin } = normalizarConMapa(original);
  const rangos = [];
  for (const token of buscados) {
    for (let desde = normal.indexOf(token); desde !== -1; desde = normal.indexOf(token, desde + token.length)) {
      rangos.push([inicio[desde], fin[desde + token.length - 1]]);
    }
  }
  if (rangos.length === 0) return [{ texto: original, resaltado: false }];
  rangos.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const unidos = [];
  for (const [desde, hasta] of rangos) {
    const ultimo = unidos[unidos.length - 1];
    if (ultimo && desde <= ultimo[1]) ultimo[1] = Math.max(ultimo[1], hasta);
    else unidos.push([desde, hasta]);
  }
  const tramos = [];
  let cursor = 0;
  for (const [desde, hasta] of unidos) {
    if (desde > cursor) tramos.push({ texto: original.slice(cursor, desde), resaltado: false });
    tramos.push({ texto: original.slice(desde, hasta), resaltado: true });
    cursor = hasta;
  }
  if (cursor < original.length) tramos.push({ texto: original.slice(cursor), resaltado: false });
  return tramos;
}

// Cuando el producto salió por algo que no se ve en su fila (la descripción o un atributo), un trozo de ese texto alrededor
// de la coincidencia: como el extracto que muestra un buscador. Con el nombre, la categoría o el ID ya se ve por qué salió.
export function fragmento(producto, tokens, ancho = 90) {
  const i = indice(producto);
  const sinExplicar = tokens.filter((t) => !(t.startsWith('#') ? i.id === t.slice(1) : (esNumero(t) && i.id === t) || i.nombre.includes(t) || i.categoria.includes(t)));
  if (sinExplicar.length === 0) return null;
  const fuentes = [
    ['Descripción', producto.descripcion],
    ['Atributos', (producto.atributos ?? []).map((a) => `${a.nombre}: ${a.valor}`).join(' · ')],
  ];
  for (const [etiqueta, texto] of fuentes) {
    if (!texto) continue;
    const { normal, inicio, fin } = normalizarConMapa(texto);
    for (const token of sinExplicar) {
      const posicion = normal.indexOf(token);
      if (posicion === -1) continue;
      // Un texto corto se muestra entero. Uno largo se recorta alrededor de la coincidencia, sin partir palabras.
      if (texto.length <= ancho * 1.5) return { etiqueta, texto: texto.trim() };
      const coincideDesde = inicio[posicion];
      const coincideHasta = fin[posicion + token.length - 1];
      let desde = Math.max(0, coincideDesde - Math.floor(ancho / 3));
      let hasta = Math.min(texto.length, coincideHasta + Math.ceil((2 * ancho) / 3));
      if (desde > 0) {
        const espacio = texto.indexOf(' ', desde);
        if (espacio !== -1 && espacio < coincideDesde) desde = espacio + 1;
      }
      if (hasta < texto.length) {
        const espacio = texto.lastIndexOf(' ', hasta);
        if (espacio > coincideHasta) hasta = espacio;
      }
      return { etiqueta, texto: `${desde > 0 ? '… ' : ''}${texto.slice(desde, hasta).trim()}${hasta < texto.length ? ' …' : ''}` };
    }
  }
  return null;
}
