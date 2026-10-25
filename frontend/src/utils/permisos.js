// Lo que la pantalla de permisos (/admin/permisos) calcula sin tocar el DOM: orden de roles, grupos de la matriz,
// cambios sin guardar y su resumen. Funciones puras (sin React) para poder probarlas desde backend/tests, igual que
// utils/filtrosBusqueda.js. La decisión de verdad —quién puede qué— la toma siempre el servidor; esto solo prepara
// lo que se muestra y lo que se le manda.

export const ROLES_DEL_SISTEMA = ['comprador', 'vendedor', 'administrador'];

// Las rutas de roles que abren cada sección del panel: quien no tenga ninguna no ve el enlace.
export const RUTAS_DEL_PANEL = {
  ventas: 'GET /api/admin/ventas',
  fraude: 'GET /api/admin/fraude',
  bloqueos: 'GET /api/admin/bloqueos',
  estadisticas: 'GET /api/productos/estadisticas/ediciones',
  permisos: 'GET /api/admin/permisos',
};

const sinAcentos = (texto) => String(texto ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Los tres roles del sistema primero, en su orden de siempre; después los creados por un administrador, por nombre.
export function ordenarRoles(roles) {
  const lugar = (r) => {
    const i = ROLES_DEL_SISTEMA.indexOf(r.nombre);
    return i === -1 ? ROLES_DEL_SISTEMA.length : i;
  };
  return [...roles].sort((a, b) => lugar(a) - lugar(b) || a.nombre.localeCompare(b.nombre, 'es'));
}

// Las rutas de la matriz agrupadas por módulo, en el orden en que aparece cada grupo.
export function agruparRutas(rutas) {
  const grupos = [];
  for (const ruta of rutas) {
    let grupo = grupos.find((g) => g.grupo === ruta.grupo);
    if (!grupo) {
      grupo = { grupo: ruta.grupo, rutas: [] };
      grupos.push(grupo);
    }
    grupo.rutas.push(ruta);
  }
  return grupos;
}

// El buscador de la matriz: por lo que dice la ruta, su clave técnica o su grupo, sin importar acentos ni mayúsculas.
export function filtrarRutas(rutas, texto = '', { soloEditables = false } = {}) {
  const buscado = sinAcentos(texto).trim();
  return rutas.filter((r) => {
    if (soloEditables && !r.editable) return false;
    if (!buscado) return true;
    return [r.nota, r.clave, r.grupo].some((campo) => sinAcentos(campo).includes(buscado));
  });
}

// ── Cambios sin guardar ─────────────────────────────────────────────────────────────────────────────────────────

export const claveDeCelda = (clave, rol) => `${rol}\u0000${clave}`;

// El borrador es un Map (claveDeCelda → permitido). Marcar una celda como estaba en el servidor deja el borrador sin ella.
export function conCelda(borrador, rutas, clave, rol, permitido) {
  const siguiente = new Map(borrador);
  const celda = rutas.find((r) => r.clave === clave)?.celdas[rol];
  if (!celda || celda.bloqueada) return siguiente;
  if (celda.permitido === permitido) siguiente.delete(claveDeCelda(clave, rol));
  else siguiente.set(claveDeCelda(clave, rol), permitido);
  return siguiente;
}

export function valorMostrado(celda, borrador, clave, rol) {
  const k = claveDeCelda(clave, rol);
  return borrador.has(k) ? borrador.get(k) : celda.permitido;
}

// Lo que se le manda al servidor: solo las celdas que difieren de lo que ya está guardado, y solo las que se pueden tocar.
export function cambiosPendientes(rutas, borrador) {
  const cambios = [];
  for (const ruta of rutas) {
    for (const [rol, celda] of Object.entries(ruta.celdas)) {
      const k = claveDeCelda(ruta.clave, rol);
      if (celda.bloqueada || !borrador.has(k) || borrador.get(k) === celda.permitido) continue;
      cambios.push({ clave: ruta.clave, rol, permitido: borrador.get(k), antes: celda.permitido, nota: ruta.nota, grupo: ruta.grupo, porDefecto: celda.porDefecto });
    }
  }
  return cambios;
}

// «Conceder X al rol Y» / «Quitar X al rol Y» — y si lo que se quita lo daba el código (no solo otra regla).
export function describirCambio(cambio) {
  const verbo = cambio.permitido ? 'Conceder' : 'Quitar';
  return {
    texto: `${verbo} «${cambio.nota}» al rol «${cambio.rol}»`,
    quita: cambio.antes === true && cambio.permitido === false,
    contraElCodigo: cambio.permitido !== cambio.porDefecto,
  };
}

// Las celdas que un administrador cambió respecto de lo que declara el código (las que «restaurar» deshace).
export function celdasModificadas(rutas) {
  const lista = [];
  for (const ruta of rutas) {
    for (const [rol, celda] of Object.entries(ruta.celdas)) {
      if (celda.origen === 'regla') lista.push({ clave: ruta.clave, rol, nota: ruta.nota, permitido: celda.permitido });
    }
  }
  return lista;
}

// Todo lo que un rol puede hacer hoy, por módulo (lo que responde «¿qué puede este rol?»).
export function permisosDeRol(rutas, rol) {
  return agruparRutas(rutas.filter((r) => r.celdas[rol]?.permitido));
}

// ── Qué ve quien inició sesión ─────────────────────────────────────────────────────────────────────────────────

// `permisos` viene de GET /api/auth/me: las rutas de roles que el rol de esa cuenta puede usar hoy.
export function puedeUsar(permisos, clave) {
  return Array.isArray(permisos) && permisos.includes(clave);
}

export function puedeAlguna(permisos, claves) {
  return claves.some((clave) => puedeUsar(permisos, clave));
}

// ── Auditoría ───────────────────────────────────────────────────────────────────────────────────────────────────

export const TIPOS_DE_AUDITORIA = [
  { valor: '', texto: 'Todo' },
  { valor: 'cambios', texto: 'Todos los cambios' },
  { valor: 'regla', texto: 'Permisos cambiados' },
  { valor: 'restaurar', texto: 'Valores restaurados' },
  { valor: 'rol_cuenta', texto: 'Roles de cuentas' },
  { valor: 'rol_creado', texto: 'Roles creados' },
  { valor: 'rol_eliminado', texto: 'Roles borrados' },
  { valor: 'denegacion', texto: 'Accesos denegados' },
];

const nombreDe = (persona) => persona?.nombre || persona?.correo || (persona?.id !== undefined ? `la cuenta #${persona.id}` : 'alguien');

// La frase de una fila del registro, en lenguaje de persona.
export function describirRegistro(r) {
  const objetivo = r.objetivo ?? {};
  switch (r.tipo) {
    case 'regla': {
      const concede = r.despues?.permitido === true;
      return `${concede ? 'Concedió' : 'Quitó'} «${objetivo.nombre ?? objetivo.id}» al rol «${r.despues?.rol ?? r.antes?.rol}»`;
    }
    case 'restaurar': {
      const n = Array.isArray(r.antes) ? r.antes.length : 0;
      return `${r.detalle ?? 'Volvió a lo que declara el código'} (${n} ${n === 1 ? 'regla' : 'reglas'})`;
    }
    case 'rol_cuenta':
      return `Cambió el rol de ${nombreDe(objetivo)} de «${r.antes?.rol}» a «${r.despues?.rol}»`;
    case 'rol_creado':
      return `Creó el rol «${objetivo.nombre}»`;
    case 'rol_eliminado':
      return `Borró el rol «${objetivo.nombre}»${r.detalle ? ` (${r.detalle.charAt(0).toLowerCase()}${r.detalle.slice(1)})` : ''}`;
    case 'denegacion':
      return `Intentó «${objetivo.id}» y se le negó`;
    default:
      return r.tipo;
  }
}

export const etiquetaDeTipo = (tipo) => TIPOS_DE_AUDITORIA.find((t) => t.valor === tipo)?.texto ?? tipo;
