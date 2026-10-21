// Facetas de la búsqueda: la parte que NO sabe de Elasticsearch ni de Mongo.
//
// Todo lo de este archivo son funciones puras (sin conexiones, sin Date, sin azar), así que se
// prueban sin levantar nada y las usan los DOS caminos de GET /api/busqueda:
//   - busquedaService.buscar()          → los números salen de las agregaciones del motor.
//   - catalogoLecturaService (respaldo) → con Elasticsearch apagado los mismos números salen de
//     la lista de Mongo, calculados en JavaScript (desdeLista).
// Los dos terminan en armarRespuesta(): una sola definición de la forma de la respuesta, para que
// la interfaz no se entere de cuál de los dos contestó.
//
// SEMÁNTICA de las facetas (la misma en los dos caminos):
//   - Disyuntivas. Cada faceta cuenta con TODOS los demás filtros aplicados MENOS el suyo: elegir
//     Talla=M no hace desaparecer Talla=L (sigue ahí, con su conteo), y elegir una categoría no
//     esconde a sus hermanas. Dentro de un mismo atributo los valores se suman (O: M o L); entre
//     atributos se exigen todos (Y: Talla M y Color Azul).
//   - El árbol de categorías cuenta texto + precio, pero NO atributos: los atributos son de cada
//     subcategoría y se descartan al cambiar de nodo.
//   - Los atributos solo se ofrecen cuando el contexto (texto + categoría) cae en UNA subcategoría:
//     "Talla" de camisetas (S, M, L) y "Talla" de zapatos (38, 40) no se mezclan en una lista.

const TAMANO_DEFECTO = 60; // múltiplo de 2, 3, 4 y 5 columnas: la grilla de HomePage siempre cierra
const TAMANO_MAXIMO = 100;
const VENTANA_MAXIMA = 10000; // index.max_result_window de Elasticsearch: desde + tamaño no puede pasar de acá
const ORDENES = ['masVendidos', 'precioAsc', 'precioDesc'];
const MAX_ATRIBUTOS = 10; // nombres de atributo distintos que una petición puede filtrar a la vez
const MAX_VALORES = 20; // valores elegidos por atributo

// Bordes de las cubetas de precio, en una escala 1-2-5 por década: sea cual sea el rango de la
// subcategoría (camisetas Q12-Q280, laptops Q3.000-Q19.000) siempre caen 3 a 6 cubetas con datos.
// Cada cubeta es [desde, hasta): quien hace clic en una manda precioMin=desde y precioMax=hasta-0.01.
const BORDES_PRECIO = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const RANGOS_PRECIO = [
  { to: BORDES_PRECIO[0] },
  ...BORDES_PRECIO.slice(0, -1).map((from, i) => ({ from, to: BORDES_PRECIO[i + 1] })),
  { from: BORDES_PRECIO[BORDES_PRECIO.length - 1] },
];

// ---------- Entrada: lo que llega por la URL ----------

function texto(valor, max = 200) {
  if (valor === undefined || valor === null) return undefined;
  const limpio = String(valor).trim();
  return limpio ? limpio.slice(0, max) : undefined;
}

function numeroNoNegativo(valor) {
  if (valor === undefined || valor === null || valor === '') return undefined;
  const n = Number(valor);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function entero(valor, porDefecto, minimo, maximo) {
  const n = Number.parseInt(valor, 10);
  if (!Number.isFinite(n)) return porDefecto;
  return Math.min(maximo, Math.max(minimo, n));
}

// `atributos` llega como JSON de { nombre: valor } o { nombre: [valores] } (ver productoRoutes.js:
// el formato de siempre sigue valiendo). Devuelve { nombre: [valores] } sin vacíos ni repetidos y
// con tope de tamaño: es un endpoint público y cada nombre elegido cuesta una agregación.
function normalizarAtributos(atributos) {
  if (!atributos) return {};
  let pares;
  try {
    pares = typeof atributos === 'string' ? JSON.parse(atributos) : atributos;
  } catch {
    return {}; // JSON inválido en un endpoint público de solo lectura: se ignora, no se rompe la búsqueda
  }
  if (!pares || typeof pares !== 'object' || Array.isArray(pares)) return {};
  const salida = {};
  for (const [nombre, valor] of Object.entries(pares)) {
    if (Object.keys(salida).length >= MAX_ATRIBUTOS) break;
    const valores = [...new Set((Array.isArray(valor) ? valor : [valor]).map((v) => texto(v, 100)).filter(Boolean))].slice(0, MAX_VALORES);
    const clave = texto(nombre, 100);
    if (clave && valores.length > 0) salida[clave] = valores;
  }
  return salida;
}

// Los filtros ya validados. tamanoMaximo: la ruta pública acepta hasta 100 por página; el catálogo
// servido desde el índice (busquedaService.listarDesdeIndice) pide 500 y lo dice a propósito.
function normalizarConsulta(opciones = {}, { tamanoMaximo = TAMANO_MAXIMO } = {}) {
  let precioMin = numeroNoNegativo(opciones.precioMin);
  let precioMax = numeroNoNegativo(opciones.precioMax);
  if (precioMin !== undefined && precioMax !== undefined && precioMin > precioMax) [precioMin, precioMax] = [precioMax, precioMin];
  const tamano = entero(opciones.tamano, Math.min(TAMANO_DEFECTO, tamanoMaximo), 1, tamanoMaximo);
  return {
    q: texto(opciones.q),
    categoriaId: texto(opciones.categoriaId, 64),
    subcategoriaId: texto(opciones.subcategoriaId, 64),
    atributos: normalizarAtributos(opciones.atributos),
    precioMin,
    precioMax,
    ordenarPor: ORDENES.includes(opciones.ordenarPor) ? opciones.ordenarPor : undefined,
    tamano,
    pagina: entero(opciones.pagina, 1, 1, Math.max(1, Math.floor(VENTANA_MAXIMA / tamano))),
  };
}

// ---------- Salida: la forma de la respuesta, igual venga del motor o de Mongo ----------

const redondear = (x) => (x === null || x === undefined ? null : Math.round(x * 100) / 100);
const porNombre = (a, b) => a.nombre.localeCompare(b.nombre, 'es');
const menorTexto = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// Más frecuente primero; a igual conteo, por texto (lo mismo que hace `terms` en el motor).
const porCantidad = (a, b) => b.cantidad - a.cantidad || menorTexto(a.valor ?? a.nombre, b.valor ?? b.nombre);

// Piezas neutrales (no importa quién las calculó):
//   arbolCrudo          [{ id, nombre, texto, cantidad, subcategorias: [{ id, nombre, texto, cantidad }] }]
//                       texto = productos que calzan con el texto; cantidad = además del rango de precio.
//   valoresPorAtributo  { nombre: [{ valor, cantidad }] } ya con la semántica disyuntiva.
//   precio              { min, max, rangos: [{ desde, hasta, cantidad }] }
function armarRespuesta({ total, pagina, tamano, resultados, arbolCrudo, valoresPorAtributo, precio, filtros }) {
  const { categoriaId, subcategoriaId } = filtros;
  const elegidos = filtros.atributos || {};
  const arbol = arbolCrudo.map((c) => ({ ...c, subcategorias: [...c.subcategorias].sort(porNombre) })).sort(porNombre);

  // Migas de pan: salen del mismo árbol (también cuando solo llegó subcategoriaId, como desde el menú).
  let ruta = [];
  for (const c of arbol) {
    const s = c.subcategorias.find((x) => x.id === subcategoriaId);
    if (s) ruta = [{ tipo: 'categoria', id: c.id, nombre: c.nombre }, { tipo: 'subcategoria', id: s.id, nombre: s.nombre }];
  }
  if (ruta.length === 0 && !subcategoriaId) {
    const c = arbol.find((x) => x.id === categoriaId);
    if (c) ruta = [{ tipo: 'categoria', id: c.id, nombre: c.nombre }];
  }

  // Contexto = subcategorías que calzan con el texto dentro de la categoría elegida (o de todas).
  // Con exactamente una, sus atributos tienen sentido; con varias, primero hay que elegir una.
  const enContexto = arbol
    .flatMap((c) => (subcategoriaId || !categoriaId || c.id === categoriaId ? c.subcategorias : []))
    .filter((s) => (subcategoriaId ? s.id === subcategoriaId : s.texto > 0));
  const atributos = enContexto.length !== 1
    ? []
    : Object.entries(valoresPorAtributo)
        .map(([nombre, valores]) => {
          const lista = valores.map((v) => ({ valor: v.valor, cantidad: v.cantidad, seleccionado: (elegidos[nombre] || []).includes(v.valor) }));
          // Un valor elegido sin resultados sigue en la lista (con 0): si no, no habría cómo desmarcarlo.
          for (const v of elegidos[nombre] || []) if (!lista.some((x) => x.valor === v)) lista.push({ valor: v, cantidad: 0, seleccionado: true });
          return { nombre, valores: lista.sort(porCantidad) };
        })
        .sort(porNombre); // orden estable: un grupo no salta de lugar al marcar algo

  const nodos = arbol.map((c) => ({
    id: c.id, nombre: c.nombre, cantidad: c.cantidad, seleccionada: c.id === categoriaId || c.subcategorias.some((s) => s.id === subcategoriaId),
    subcategorias: c.subcategorias.map((s) => ({ id: s.id, nombre: s.nombre, cantidad: s.cantidad, seleccionada: s.id === subcategoriaId })),
  }));

  return {
    resultados,
    total,
    pagina,
    tamano,
    paginas: Math.max(1, Math.ceil(total / tamano)),
    arbol: nodos,
    ruta,
    atributos,
    precio,
    filtros: {
      q: filtros.q, categoriaId, subcategoriaId, atributos: elegidos,
      precioMin: filtros.precioMin, precioMax: filtros.precioMax, ordenarPor: filtros.ordenarPor,
    },
    // Claves de la primera versión de la respuesta, derivadas de lo de arriba. Nadie de la interfaz las
    // lee ya (scripts/verificarRespuestaEscalonada.js sí lee `facetas`); se pueden borrar cuando se quiera.
    facetas: Object.fromEntries(atributos.map((a) => [a.nombre, a.valores.filter((v) => v.cantidad > 0 || v.seleccionado).map((v) => v.valor)])),
    categorias: nodos.filter((c) => c.cantidad > 0).map(({ id, nombre, cantidad }) => ({ id, nombre, cantidad })).sort(porCantidad),
    subcategorias: nodos
      .filter((c) => !(categoriaId || subcategoriaId) || c.seleccionada)
      .flatMap((c) => c.subcategorias)
      .filter((s) => s.cantidad > 0)
      .map(({ id, nombre, cantidad }) => ({ id, nombre, cantidad }))
      .sort(porCantidad),
  };
}

// ---------- El mismo cálculo en JavaScript: lo usa el respaldo cuando Elasticsearch está apagado ----------
//
// `productos` es la lista que devuelve productoService.listar({ q }): ya filtrada por texto, por
// estado activo y por vendedores suspendidos, con la forma { id, atributos, inventario, subcategoria,
// total_vendido }. Categoría, precio y atributos se aplican acá, uno por uno, porque cada faceta
// necesita "todos los filtros menos el suyo" y Mongo solo sabe devolver el conjunto ya recortado.
// Es el mismo cálculo que las agregaciones de busquedaService.buscar(); scripts/verificarBusqueda.js
// lo comprueba contra el motor real caso por caso.
function desdeLista(productos, filtros) {
  const { categoriaId, subcategoriaId, precioMin, precioMax, ordenarPor, pagina, tamano } = filtros;
  const elegidos = filtros.atributos || {};
  const nombres = Object.keys(elegidos);
  const precioDe = (p) => Number(p.inventario?.precio);

  const enCategoria = (p) => (subcategoriaId ? p.subcategoria?.id === subcategoriaId : categoriaId ? p.subcategoria?.categoria_id === categoriaId : true);
  const enPrecio = (p) => (precioMin === undefined || precioDe(p) >= precioMin) && (precioMax === undefined || precioDe(p) <= precioMax);
  const cumple = (p, nombre) => (p.atributos || []).some((a) => a.nombre === nombre && elegidos[nombre].includes(a.valor));
  const enAtributos = (p, salvo) => nombres.every((n) => n === salvo || cumple(p, n));

  const calzan = productos.filter((p) => enCategoria(p) && enPrecio(p) && enAtributos(p));
  const ordenes = {
    masVendidos: (a, b) => (b.total_vendido ?? 0) - (a.total_vendido ?? 0) || a.id - b.id,
    precioAsc: (a, b) => precioDe(a) - precioDe(b) || a.id - b.id,
    precioDesc: (a, b) => precioDe(b) - precioDe(a) || a.id - b.id,
  };
  const ordenados = [...calzan].sort(ordenes[ordenarPor] || ((a, b) => a.id - b.id));

  // Árbol: texto + precio (cada nodo cuenta el precio por separado), sin categoría ni atributos.
  const categorias = new Map();
  for (const p of productos) {
    const s = p.subcategoria;
    if (!s?.id || !s.categoria_id) continue; // sin categoría no hay dónde colgarlo (el motor tampoco lo agrupa)
    const c = categorias.get(s.categoria_id) || { id: s.categoria_id, nombre: s.categoria ?? 'Sin nombre', texto: 0, cantidad: 0, subs: new Map() };
    const n = c.subs.get(s.id) || { id: s.id, nombre: s.subcategoria ?? 'Sin nombre', texto: 0, cantidad: 0 };
    c.texto += 1;
    n.texto += 1;
    if (enPrecio(p)) { c.cantidad += 1; n.cantidad += 1; }
    c.subs.set(s.id, n);
    categorias.set(s.categoria_id, c);
  }
  const arbolCrudo = [...categorias.values()].map(({ subs, ...c }) => ({ ...c, subcategorias: [...subs.values()] }));

  // Atributos: los elegidos cuentan sin su propio filtro; los demás, con todos (el motor tiene tope de
  // 20 nombres y 30 valores por nombre: se respeta el mismo).
  const contar = (lista, nombre) => {
    const cuentas = new Map();
    for (const p of lista) for (const a of p.atributos || []) if (a.nombre === nombre) cuentas.set(a.valor, (cuentas.get(a.valor) || 0) + 1);
    return [...cuentas].map(([valor, cantidad]) => ({ valor, cantidad })).sort(porCantidad).slice(0, 30);
  };
  const valoresPorAtributo = {};
  for (const n of nombres) valoresPorAtributo[n] = contar(productos.filter((p) => enCategoria(p) && enPrecio(p) && enAtributos(p, n)), n);
  const libres = new Map();
  for (const p of calzan) for (const a of p.atributos || []) if (!nombres.includes(a.nombre)) libres.set(a.nombre, (libres.get(a.nombre) || 0) + 1);
  [...libres].sort((a, b) => b[1] - a[1] || menorTexto(a[0], b[0])).slice(0, 20).forEach(([n]) => { valoresPorAtributo[n] = contar(calzan, n); });

  // Precio: categoría y atributos elegidos, SIN el rango de precio (para poder ampliarlo).
  const precios = productos.filter((p) => enCategoria(p) && enAtributos(p)).map(precioDe);
  const rangos = RANGOS_PRECIO
    .map((r) => ({ desde: r.from ?? 0, hasta: r.to ?? null, cantidad: precios.filter((v) => (r.from === undefined || v >= r.from) && (r.to === undefined || v < r.to)).length }))
    .filter((r) => r.cantidad > 0);
  const precio = {
    min: precios.length ? redondear(Math.min(...precios)) : null,
    max: precios.length ? redondear(Math.max(...precios)) : null,
    rangos,
  };

  return armarRespuesta({
    total: calzan.length,
    pagina,
    tamano,
    resultados: ordenados.slice((pagina - 1) * tamano, pagina * tamano),
    arbolCrudo,
    valoresPorAtributo,
    precio,
    filtros,
  });
}

module.exports = { TAMANO_DEFECTO, TAMANO_MAXIMO, VENTANA_MAXIMA, RANGOS_PRECIO, normalizarConsulta, normalizarAtributos, armarRespuesta, desdeLista, redondear, porCantidad, menorTexto };
