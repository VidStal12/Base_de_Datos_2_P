// Identificador del dispositivo para el antifraude (backend/src/services/dispositivoService.js,
// IA/PLAN-NEO4J-DETECCION-FRAUDE.md §22). El servidor no puede saber desde qué navegador entra una cuenta, así que este
// archivo le pone uno: un valor ALEATORIO que se genera la primera vez y se guarda en el almacenamiento del sitio.
// Dos cuentas que entran desde el mismo navegador mandan el mismo valor; el servidor solo guarda su hash.
//
// Lo que NO es: no es una huella invasiva. No se leen canvas, audio, fuentes ni nada que identifique a una persona
// fuera de esta tienda; borrar los datos del sitio lo cambia. Por eso hay un segundo dato, el PERFIL: rasgos gruesos
// del equipo (sistema, idioma, zona horaria, pantalla, núcleos) que sobreviven a borrar los datos o a una ventana de
// incógnito. Es una pista débil —miles de equipos iguales comparten perfil—, y el servidor la trata así.
//
// Solo viaja al iniciar sesión y al registrarse (api/client.js): en el resto de las peticiones no hace falta, y una
// cabecera propia en una lectura obligaría al navegador a pedir permiso al servidor antes de cada dirección.

const CLAVE = 'tiendaya.dispositivo';
// Lo mismo que acepta el servidor (dispositivoService.ID_VALIDO): 16 a 64 caracteres alfanuméricos o guiones.
const ID_VALIDO = /^[A-Za-z0-9-]{16,64}$/;

// Si el almacenamiento no está disponible (modo privado de algunos navegadores, datos bloqueados) el
// identificador vive solo mientras la pestaña esté abierta.
let enMemoria = null;

function nuevoIdentificador() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function idDispositivo() {
  try {
    const guardado = localStorage.getItem(CLAVE);
    if (guardado && ID_VALIDO.test(guardado)) return guardado;
    const nuevo = nuevoIdentificador();
    localStorage.setItem(CLAVE, nuevo);
    return nuevo;
  } catch {
    enMemoria ??= nuevoIdentificador();
    return enMemoria;
  }
}

// Una cabecera HTTP solo admite caracteres imprimibles ASCII: cualquier otro haría fallar la petición entera.
const imprimible = (texto) => String(texto ?? '').replace(/[^\x20-\x7E]/g, '').trim();

// Sistema, idioma, zona horaria, pantalla (ancho x alto x profundidad de color @ densidad de píxeles), núcleos y
// puntos táctiles. Cada dato puede faltar según el navegador: lo que no se conoce queda vacío o en cero, igual en
// cada visita, así el perfil no cambia por una ausencia.
export function perfilDispositivo() {
  try {
    const nav = globalThis.navigator ?? {};
    const pantalla = globalThis.screen ?? {};
    const zona = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
    const rasgos = [
      nav.userAgentData?.platform ?? nav.platform ?? '',
      nav.language ?? '',
      zona,
      `${pantalla.width ?? 0}x${pantalla.height ?? 0}x${pantalla.colorDepth ?? 0}@${globalThis.devicePixelRatio ?? 1}`,
      nav.hardwareConcurrency ?? 0,
      nav.maxTouchPoints ?? 0,
    ];
    return imprimible(rasgos.join('|'));
  } catch {
    return '';
  }
}

export function cabecerasDeDispositivo() {
  const cabeceras = { 'X-Dispositivo': idDispositivo() };
  const perfil = perfilDispositivo();
  if (perfil) cabeceras['X-Dispositivo-Perfil'] = perfil;
  return cabeceras;
}
