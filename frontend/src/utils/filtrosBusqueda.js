// Filtros de la búsqueda: el estado vive en la URL (?q=&categoriaId=&subcategoriaId=&atributos=&precioMin=
// &precioMax=&ordenarPor=&pagina=), que son EXACTAMENTE los parámetros de GET /api/busqueda. Así el botón
// "atrás", un enlace copiado y los enlaces del menú de categorías funcionan sin estado aparte.
// Funciones puras (sin React ni DOM) para poder probarlas desde backend/tests, igual que utils/checkoutIntento.js.

export const FILTROS_VACIOS = { q: '', categoriaId: '', subcategoriaId: '', atributos: {}, precioMin: '', precioMax: '', ordenarPor: '', pagina: 1 };

export function leerFiltros(parametros) {
  let atributos = {};
  try {
    const crudo = JSON.parse(parametros.get('atributos') || '{}');
    if (crudo && typeof crudo === 'object' && !Array.isArray(crudo)) {
      for (const [nombre, valor] of Object.entries(crudo)) {
        const lista = (Array.isArray(valor) ? valor : [valor]).filter((v) => typeof v === 'string' && v);
        if (lista.length > 0) atributos[nombre] = lista;
      }
    }
  } catch {
    atributos = {}; // un enlace con JSON roto se trata como "sin atributos", no como pantalla en blanco
  }
  return {
    q: parametros.get('q') || '',
    categoriaId: parametros.get('categoriaId') || '',
    subcategoriaId: parametros.get('subcategoriaId') || '',
    atributos,
    precioMin: parametros.get('precioMin') || '',
    precioMax: parametros.get('precioMax') || '',
    ordenarPor: parametros.get('ordenarPor') || '',
    pagina: Math.max(1, Number.parseInt(parametros.get('pagina'), 10) || 1),
  };
}

// Objeto plano de strings, sin lo vacío: sirve para la URL de la página y para la llamada a la API.
export function aParametros(filtros) {
  const salida = {};
  for (const clave of ['q', 'categoriaId', 'subcategoriaId', 'precioMin', 'precioMax', 'ordenarPor']) {
    if (filtros[clave] !== '' && filtros[clave] !== undefined) salida[clave] = String(filtros[clave]);
  }
  if (Object.keys(filtros.atributos || {}).length > 0) salida.atributos = JSON.stringify(filtros.atributos);
  if (filtros.pagina > 1) salida.pagina = String(filtros.pagina);
  return salida;
}

// Cualquier cambio de filtro vuelve a la página 1; los atributos son de cada subcategoría: al cambiar de nodo se descartan.
export const conCategoria = (f, categoriaId) => ({ ...f, categoriaId, subcategoriaId: '', atributos: {}, pagina: 1 });
export const conSubcategoria = (f, subcategoriaId) => ({ ...f, categoriaId: '', subcategoriaId, atributos: {}, pagina: 1 });
export const conPagina = (f, pagina) => ({ ...f, pagina });
export const conOrden = (f, ordenarPor) => ({ ...f, ordenarPor, pagina: 1 });
export const conPrecio = (f, precioMin, precioMax) => ({ ...f, precioMin: precioMin ?? '', precioMax: precioMax ?? '', pagina: 1 });
export const sinAtributos = (f) => ({ ...f, atributos: {}, pagina: 1 });

// Marcar o desmarcar UN valor de un atributo, sin tocar los demás valores (selección múltiple).
export function alternarAtributo(f, nombre, valor) {
  const actuales = f.atributos[nombre] || [];
  const nuevos = actuales.includes(valor) ? actuales.filter((v) => v !== valor) : [...actuales, valor];
  const { [nombre]: _viejo, ...resto } = f.atributos;
  return { ...f, atributos: nuevos.length > 0 ? { ...resto, [nombre]: nuevos } : resto, pagina: 1 };
}

// Una cubeta de precio es [desde, hasta): el filtro de la API es inclusivo, así que el máximo es hasta - 0.01.
export function precioDeCubeta(rango) {
  return { precioMin: String(rango.desde), precioMax: rango.hasta === null ? '' : String(Math.round((rango.hasta - 0.01) * 100) / 100) };
}

// Las páginas que se muestran en el paginador: la primera, la última y la actual con sus vecinas; el resto, como «…».
export function paginasVisibles(actual, total) {
  const lista = [...new Set([1, total, actual - 1, actual, actual + 1])].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
  const salida = [];
  lista.forEach((n, i) => {
    if (i > 0 && n - lista[i - 1] > 1) salida.push('…');
    salida.push(n);
  });
  return salida;
}

export const hayFiltros = (f) => Boolean(f.q || f.categoriaId || f.subcategoriaId || Object.keys(f.atributos).length > 0 || f.precioMin !== '' || f.precioMax !== '' || f.ordenarPor);
