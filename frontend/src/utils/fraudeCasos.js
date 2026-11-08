// Casos de fraude para el panel de dos ventanas (pages/admin/AdminFraudePage.jsx).
//
// GET /api/admin/fraude devuelve siete listas, una por señal, cada una con su propia forma. Para filtrarlas por cuenta,
// probabilidad y relación, y para saber qué OTROS hallazgos tiene una cuenta, se aplanan en una sola lista de «casos»
// con lo mínimo que tienen en común:
//
//   { clave, tipo, nivel, usuarios: [{ id, nombre, correo }], vinculos: ['dispositivo', ...], datos }
//
// `datos` es el hallazgo tal como llegó del servidor (la pantalla lo dibuja con él). Todo lo de este archivo son funciones
// y constantes puras, sin React ni reloj: las prueba backend/tests/fraudePanelFrontend.test.js. Los filtros viven en la URL
// (?usuario=&nivel=&relacion=&vinculo=&caso=), así que un enlace copiado y el botón «atrás» reproducen la misma vista.

// Una entrada por señal, en el orden en que la pantalla las muestra. `campo` es la clave de la respuesta de la API.
export const TIPOS = [
  { id: 'autocompra', campo: 'autocompra', titulo: 'Autocompra' },
  { id: 'reventa', campo: 'reventa', titulo: 'Reventa de lo comprado' },
  { id: 'persona', campo: 'cuentasRelacionadas', titulo: 'Cuentas de una misma persona' },
  { id: 'resenas', campo: 'resenasCoordinadas', titulo: 'Reseñas coordinadas' },
  { id: 'rafaga', campo: 'rafagaGasto', titulo: 'Ráfaga de gasto' },
  { id: 'gasto', campo: 'gastoAnomalo', titulo: 'Gasto anómalo' },
  { id: 'categoria', campo: 'categoriaInusual', titulo: 'Categoría inusual' },
];

// «sin»: las reseñas coordinadas no se cruzan con otras señales, así que el servidor no les da nivel de confianza.
export const NIVELES = [
  { id: 'alta', texto: 'Alta' },
  { id: 'posible', texto: 'Posible' },
  { id: 'sin', texto: 'Sin nivel' },
];

// Cómo se relacionan las cuentas de un caso (solo las señales de identidad y la autocompra lo tienen).
export const VINCULOS = [
  { id: 'dispositivo', texto: 'Mismo dispositivo' },
  { id: 'correo', texto: 'Mismo buzón de correo' },
  { id: 'perfil', texto: 'Equipo parecido' },
  { id: 'cuenta', texto: 'Misma cuenta' },
];

export const FILTROS_VACIOS = { usuario: '', nivel: '', relacion: '', vinculo: '', caso: '' };
export const LARGO_MAXIMO_USUARIO = 80;
const LARGO_MAXIMO_CASO = 160;

// ---------- De las siete listas a una sola ----------

const aUsuario = (u) => ({ id: u.id, nombre: u.nombre ?? u.ficha?.nombre ?? '', correo: u.ficha?.correo ?? '' });
const sinRepetir = (usuarios) => [...new Map(usuarios.map((u) => [u.id, u])).values()];
const nivelDe = (hallazgo) => (hallazgo.nivelConfianza === 'alta' || hallazgo.nivelConfianza === 'posible' ? hallazgo.nivelConfianza : null);

// Cada constructor recibe el hallazgo y devuelve su clave (estable entre cargas: sale de los ids, no del orden), las
// cuentas que involucra y cómo se relacionan.
const CONSTRUCTORES = {
  autocompra: (f) => ({
    clave: `autocompra:${f.comprador.id}-${f.vendedor.id}`,
    usuarios: sinRepetir([f.comprador, f.vendedor].map(aUsuario)),
    vinculos: [f.mismaCuenta && 'cuenta', f.mismoDispositivo && 'dispositivo', f.mismoBuzon && 'correo', f.mismoPerfil && 'perfil'].filter(Boolean),
  }),
  reventa: (h) => ({
    clave: `reventa:${h.vendedor.id}-${h.publicacion.id}`,
    usuarios: sinRepetir([h.vendedor, ...h.originales.map((o) => o.vendedor)].map(aUsuario)),
    vinculos: [],
  }),
  persona: (a) => ({
    clave: `persona:${a.clave}`,
    usuarios: sinRepetir(a.miembros.map(aUsuario)),
    vinculos: [...new Set(a.vinculos.map((v) => v.tipo))].filter((tipo) => tipo === 'dispositivo' || tipo === 'correo'),
  }),
  resenas: (r) => ({
    clave: `resenas:${r.usuario1.id}-${r.usuario2.id}`,
    usuarios: sinRepetir([r.usuario1, r.usuario2].map(aUsuario)),
    vinculos: [],
  }),
  rafaga: (r) => ({ clave: `rafaga:${r.usuario.id}-${r.dia}`, usuarios: [aUsuario(r.usuario)], vinculos: [] }),
  gasto: (g) => ({ clave: `gasto:${g.compraId}`, usuarios: [aUsuario(g.usuario)], vinculos: [] }),
  categoria: (c) => ({ clave: `categoria:${c.usuario.id}-${c.compraId}-${c.categoria}`, usuarios: [aUsuario(c.usuario)], vinculos: [] }),
};

// Las siete listas de la respuesta en una sola, en el orden de las secciones (dentro de cada una se conserva el del
// servidor: confianza alta primero). Si dos hallazgos dieran la misma clave, el segundo lleva «~2» para que cada caso
// se pueda elegir por separado.
export function aplanarCasos(datos) {
  const casos = [];
  const repetidas = new Map();
  for (const tipo of TIPOS) {
    for (const hallazgo of datos?.[tipo.campo] ?? []) {
      const base = CONSTRUCTORES[tipo.id](hallazgo);
      const veces = (repetidas.get(base.clave) ?? 0) + 1;
      repetidas.set(base.clave, veces);
      casos.push({ ...base, clave: veces === 1 ? base.clave : `${base.clave}~${veces}`, tipo: tipo.id, nivel: nivelDe(hallazgo), datos: hallazgo });
    }
  }
  return casos;
}

// ---------- Filtros ----------

// Sin tildes ni mayúsculas, para que «María» se encuentre escribiendo «maria».
export function normalizar(texto) {
  return String(texto ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

// «#12» es la cuenta 12 y nada más; «12» es la cuenta 12 o un 12 dentro del nombre o del correo; el resto, texto.
function cuentaCoincide(usuario, palabras) {
  const texto = normalizar(`${usuario.nombre} ${usuario.correo}`);
  return palabras.every((palabra) => {
    if (palabra.startsWith('#')) return String(usuario.id) === palabra.slice(1);
    if (/^\d+$/.test(palabra)) return String(usuario.id) === palabra || texto.includes(palabra);
    return texto.includes(palabra);
  });
}

// Todas las palabras tienen que calzar con UNA misma cuenta del caso («ana gomez» no se cumple con «Ana» de una y
// «Gómez» de otra). Vacío o solo espacios: calza con todo.
export function coincideUsuario(caso, consulta) {
  const palabras = normalizar(consulta).split(/\s+/).filter((p) => p && p !== '#');
  if (palabras.length === 0) return true;
  return caso.usuarios.some((usuario) => cuentaCoincide(usuario, palabras));
}

// `ignorar` deja fuera UNO de los filtros de opciones (nivel, relación o vínculo): es lo que permite contar cada opción
// con los demás filtros puestos (conteos). El de la cuenta se aplica siempre.
function cumple(caso, filtros, ignorar) {
  if (filtros.usuario && !coincideUsuario(caso, filtros.usuario)) return false;
  if (ignorar !== 'nivel' && filtros.nivel && (caso.nivel ?? 'sin') !== filtros.nivel) return false;
  if (ignorar !== 'relacion' && filtros.relacion && caso.tipo !== filtros.relacion) return false;
  if (ignorar !== 'vinculo' && filtros.vinculo && !caso.vinculos.includes(filtros.vinculo)) return false;
  return true;
}

export function filtrar(casos, filtros) {
  return casos.filter((caso) => cumple(caso, filtros, null));
}

// Cuántos casos hay por opción de cada filtro, contando con TODOS los demás filtros puestos menos el suyo (como las
// facetas disyuntivas de la tienda): así «Alta (3)» dice cuántos verías al elegirla, y elegir una opción nunca
// deja una pantalla vacía sin avisar. `todas` es el total de ese filtro sin elegir nada en él.
export function conteos(casos, filtros) {
  const por = (ignorar, clavesDe) => {
    const cuenta = { todas: 0 };
    for (const caso of casos) {
      if (!cumple(caso, filtros, ignorar)) continue;
      cuenta.todas += 1;
      for (const clave of clavesDe(caso)) cuenta[clave] = (cuenta[clave] ?? 0) + 1;
    }
    return cuenta;
  };
  return {
    total: casos.length,
    visibles: filtrar(casos, filtros).length,
    nivel: por('nivel', (caso) => [caso.nivel ?? 'sin']),
    relacion: por('relacion', (caso) => [caso.tipo]),
    vinculo: por('vinculo', (caso) => caso.vinculos),
  };
}

// ---------- Casos de las mismas cuentas ----------

const PESO_NIVEL = { alta: 0, posible: 1 };

// Los OTROS casos que involucran a alguna de las cuentas de `caso`: confianza alta primero y, a igual nivel, el orden
// de las secciones. Es lo que deja ver, desde un caso, que la misma cuenta aparece en otra señal.
export function relacionados(casos, caso) {
  const ids = new Set(caso.usuarios.map((u) => u.id));
  return casos
    .map((otro, posicion) => ({ otro, posicion }))
    .filter(({ otro }) => otro.clave !== caso.clave && otro.usuarios.some((u) => ids.has(u.id)))
    .sort((a, b) => (PESO_NIVEL[a.otro.nivel] ?? 2) - (PESO_NIVEL[b.otro.nivel] ?? 2) || a.posicion - b.posicion)
    .map(({ otro }) => otro);
}

// ---------- La URL ----------

export function leerFiltros(parametros) {
  const elegido = (nombre, validos) => {
    const valor = parametros.get(nombre) || '';
    return validos.some((v) => v.id === valor) ? valor : '';
  };
  return {
    usuario: (parametros.get('usuario') || '').slice(0, LARGO_MAXIMO_USUARIO),
    nivel: elegido('nivel', NIVELES),
    relacion: elegido('relacion', TIPOS),
    vinculo: elegido('vinculo', VINCULOS),
    caso: (parametros.get('caso') || '').slice(0, LARGO_MAXIMO_CASO),
  };
}

// Objeto plano de strings, sin lo vacío: sirve para la URL de la página. El texto del usuario se guarda tal como se
// escribió (recortarlo mientras se escribe se comería el espacio entre dos palabras).
export function aParametros(filtros) {
  const salida = {};
  for (const clave of ['usuario', 'nivel', 'relacion', 'vinculo', 'caso']) {
    if (filtros[clave] && (clave !== 'usuario' || filtros.usuario.trim())) salida[clave] = filtros[clave];
  }
  return salida;
}

export const hayFiltros = (f) => Boolean(f.usuario.trim() || f.nivel || f.relacion || f.vinculo);
export const sinFiltros = (f) => ({ ...f, usuario: '', nivel: '', relacion: '', vinculo: '' });
export const conUsuario = (f, usuario) => ({ ...f, usuario: String(usuario ?? '').slice(0, LARGO_MAXIMO_USUARIO) });
export const conNivel = (f, nivel) => ({ ...f, nivel });
export const conRelacion = (f, relacion) => ({ ...f, relacion });
export const conVinculo = (f, vinculo) => ({ ...f, vinculo });
export const conCaso = (f, caso) => ({ ...f, caso });

// ---------- Texto ----------

// «Dos horas», «3 días»: cuánto pasó entre dos instantes, para decir de un vistazo si un patrón fue cosa de minutos o
// de semanas. Vacío si alguna de las dos fechas no se entiende.
export function duracionTexto(desde, hasta) {
  const a = Date.parse(desde);
  const b = Date.parse(hasta);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '';
  const minutos = Math.round(Math.abs(b - a) / 60000);
  if (minutos < 1) return 'menos de un minuto';
  if (minutos < 60) return `${minutos} min`;
  const horas = Math.round(minutos / 60);
  if (horas < 48) return `${horas} h`;
  return `${Math.round(horas / 24)} días`;
}
