const crypto = require('node:crypto');
const prisma = require('../config/prisma');
const fraudeSyncService = require('./fraudeSyncService');

// Dispositivos de las cuentas (IA/PLAN-NEO4J-DETECCION-FRAUDE.md §22). Reemplaza al NOMBRE como vínculo
// entre cuentas del antifraude: dos personas distintas pueden llamarse igual (homónimos), y hasta ahora eso
// bastaba para que una compra entre ellas arrancara en confianza «alta». Lo que sí delata a quien maneja varias
// cuentas es que todas entran desde el mismo lugar.
//
// QUÉ ES UN «DISPOSITIVO» AQUÍ. Un navegador no tiene un identificador de equipo que el sitio pueda leer (y
// leerlo sería invasivo), así que la propia tienda le pone uno: el frontend genera un valor aleatorio (UUID),
// lo guarda en el almacenamiento del sitio (utils/dispositivo.js) y lo manda SOLO al iniciar sesión y al
// registrarse (cabecera X-Dispositivo). Cada vez que una cuenta entra desde un navegador queda anotado el par
// (cuenta, dispositivo). Dos cuentas que comparten dispositivo entraron desde el mismo navegador.
//
// UN SEGUNDO NIVEL, MÁS DÉBIL: EL PERFIL. Quien borra los datos del sitio, o entra en una ventana de incógnito
// por cuenta, se presenta con un identificador nuevo cada vez. Para no depender solo de él, el frontend manda
// también rasgos gruesos del equipo (sistema, idioma, zona horaria, tamaño de pantalla, núcleos; cabecera
// X-Dispositivo-Perfil) y el servidor les suma la familia del navegador (Chrome, Windows…) que ve en el
// User-Agent. Su hash es el perfil: dos dispositivos con el mismo perfil son «equipos parecidos». Es una pista,
// NO una identidad — miles de teléfonos iguales comparten perfil —, por eso solo cuenta cuando las dos cuentas
// además se compran entre sí (ver fraudeService, señal F) y nunca une cuentas por sí sola.
//
// LÍMITES HONESTOS. Es un identificador que el cliente manda: quien lo conoce puede falsificarlo o rotarlo, y
// una familia que comparte un computador queda vinculada sin ser fraude. Por eso el vínculo por dispositivo
// parte en «posible» y solo sube con corroboración, igual que antes lo hacía el nombre. Se detecta al
// descuidado y a la persona que no sabe que la miran, no a quien se lo propone con método.
//
// PRIVACIDAD. Nunca se guarda ni se reenvía el identificador en claro: solo su SHA-256 (con un prefijo propio,
// así el valor no sirve para nada fuera de este sistema). Tampoco la IP ni el User-Agent completo: del
// navegador solo queda una etiqueta legible («Chrome · Windows») para que una persona del equipo reconozca el
// dispositivo en el panel. Los Términos de Servicio lo dicen (/terminos, sección de seguridad).

// El identificador que genera el navegador: un UUID (con o sin guiones) u otro valor aleatorio de 16 a 64
// caracteres alfanuméricos. Cualquier otra cosa se descarta: es un dato que escribe el cliente.
const ID_VALIDO = /^[A-Za-z0-9-]{16,64}$/;
const LARGO_MAXIMO_PERFIL = 200;

const sha256 = (texto) => crypto.createHash('sha256').update(texto).digest('hex');

// El prefijo hace que el hash solo sirva aquí: dos sistemas que usaran el mismo UUID producirían valores distintos.
function hashDispositivo(dispositivoId) {
  return sha256(`tiendaya:dispositivo:${dispositivoId}`);
}

// Familia del navegador y del sistema, SIN versiones (una actualización no debe cambiar el perfil). El orden de
// las comprobaciones importa: el User-Agent de Edge y de Opera dicen «Chrome», el de Chrome dice «Safari»; el de
// un iPhone dice «Mac OS X» y el de Android dice «Linux».
function familiaDelNavegador(userAgent) {
  const ua = String(userAgent ?? '');
  let navegador = 'Otro';
  if (/Edg(e|A|iOS)?\//.test(ua)) navegador = 'Edge';
  else if (/OPR\/|Opera/.test(ua)) navegador = 'Opera';
  else if (/Firefox\/|FxiOS\//.test(ua)) navegador = 'Firefox';
  else if (/Chrome\/|CriOS\//.test(ua)) navegador = 'Chrome';
  else if (/Safari\//.test(ua)) navegador = 'Safari';

  let sistema = 'Otro';
  if (/Windows/.test(ua)) sistema = 'Windows';
  else if (/Android/.test(ua)) sistema = 'Android';
  else if (/iPhone|iPad|iPod/.test(ua)) sistema = 'iOS';
  else if (/CrOS/.test(ua)) sistema = 'ChromeOS';
  else if (/Mac OS X|Macintosh/.test(ua)) sistema = 'macOS';
  else if (/Linux|X11/.test(ua)) sistema = 'Linux';
  return { navegador, sistema };
}

function etiquetaDe(userAgent) {
  const { navegador, sistema } = familiaDelNavegador(userAgent);
  return `${navegador} · ${sistema}`;
}

// Los rasgos que manda el navegador, en una forma estable: sin mayúsculas, sin espacios de más. Vacío = sin perfil.
function normalizarPerfil(perfil) {
  if (typeof perfil !== 'string') return '';
  return perfil.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, LARGO_MAXIMO_PERFIL);
}

// null si el navegador no mandó rasgos: sin perfil no hay «equipo parecido» que buscar.
function hashPerfil(perfil, userAgent) {
  const rasgos = normalizarPerfil(perfil);
  if (!rasgos) return null;
  const { navegador, sistema } = familiaDelNavegador(userAgent);
  return sha256(`tiendaya:perfil:${navegador}|${sistema}|${rasgos}`);
}

// De las cabeceras de la petición a lo que se registra. `cabecera` es `req.get`. Sin identificador válido
// (un script, un cliente viejo, una petición hecha a mano) devuelve null y no se registra nada: nunca se inventa
// un dispositivo a partir de datos más débiles.
function desdeCabeceras(cabecera) {
  const crudo = cabecera('x-dispositivo');
  const dispositivoId = typeof crudo === 'string' ? crudo.trim() : '';
  if (!ID_VALIDO.test(dispositivoId)) return null;
  return {
    dispositivoId,
    perfil: cabecera('x-dispositivo-perfil') ?? null,
    userAgent: cabecera('user-agent') ?? '',
  };
}

// Anota que `usuarioId` entró desde este dispositivo: fila durable en MySQL (la fuente) y, sin esperar, copia al
// grafo de Neo4j. El grafo es de mejor esfuerzo y se reconstruye con `npm run fraude:backfill`; que Neo4j esté
// apagado nunca puede hacer más lento ni más frágil un inicio de sesión, por eso el reenvío no se espera.
// `dispositivo` es lo que devuelve desdeCabeceras(); sin él no hace nada. `esperarGrafo`: espera a que el
// grafo también quede escrito (y propaga su error); lo usan los scripts de verificación, que consultan
// enseguida — el inicio de sesión real nunca espera.
async function registrarInicio({ usuarioId, usuarioNombre, usuarioRol, dispositivo, ahora = new Date(), esperarGrafo = false }) {
  if (!dispositivo) return null;
  const dispositivoHash = hashDispositivo(dispositivo.dispositivoId);
  const perfilHash = hashPerfil(dispositivo.perfil, dispositivo.userAgent);
  const etiqueta = etiquetaDe(dispositivo.userAgent);
  const clave = { id_usuario_dispositivo_hash: { id_usuario: usuarioId, dispositivo_hash: dispositivoHash } };
  // El perfil se actualiza solo si llegó uno: un inicio sin rasgos no debe borrar el que ya se conocía.
  const cambios = { ultima_vez: ahora, inicios: { increment: 1 }, etiqueta, ...(perfilHash && { perfil_hash: perfilHash }) };

  let fila;
  try {
    fila = await prisma.dispositivo_usuario.upsert({
      where: clave,
      create: { id_usuario: usuarioId, dispositivo_hash: dispositivoHash, perfil_hash: perfilHash, etiqueta, primera_vez: ahora, ultima_vez: ahora },
      update: cambios,
    });
  } catch (err) {
    // Prisma resuelve el upsert de MySQL con un SELECT y después un INSERT o un UPDATE: dos inicios de sesión
    // simultáneos de la MISMA cuenta desde el mismo dispositivo (dos pestañas) pueden chocar con el índice único
    // (P2002). El otro ya creó la fila: lo que falta es sumar este inicio.
    if (err.code !== 'P2002') throw err;
    fila = await prisma.dispositivo_usuario.update({ where: clave, data: cambios });
  }

  const reenvio = fraudeSyncService.registrarDispositivo({
    usuarioId,
    usuarioNombre,
    usuarioRol,
    dispositivoHash,
    perfilHash: fila.perfil_hash ?? perfilHash,
    etiqueta,
    primeraVez: fila.primera_vez,
    ultimaVez: fila.ultima_vez,
    inicios: fila.inicios,
  });
  if (esperarGrafo) await reenvio;
  else reenvio.catch((err) => console.error('No se pudo reenviar el dispositivo a Neo4j (se reconstruye con fraude:backfill):', err.message));
  return fila;
}

// Para login y registro: una falla acá (MySQL con un problema puntual, una migración que falta) se registra y se
// sigue — el antifraude es un efecto secundario del inicio de sesión, nunca una condición para entrar.
async function registrarInicioSeguro(datos) {
  try {
    return await registrarInicio(datos);
  } catch (err) {
    console.error('No se pudo registrar el dispositivo del inicio de sesión:', err.message);
    return null;
  }
}

// Los dispositivos de varias cuentas, para la ficha del panel (en lote: una consulta para todas). De cada uno
// solo sale una referencia corta —los primeros 8 caracteres del hash— que sirve para ver a simple vista que dos
// cuentas comparten el MISMO dispositivo; el hash completo no sale del servidor.
const REFERENCIA = 8;
const referenciaDe = (hash) => hash.slice(0, REFERENCIA);

async function dispositivosDe(ids, { porCuenta = 5 } = {}) {
  if (ids.length === 0) return new Map();
  const filas = await prisma.dispositivo_usuario.findMany({
    where: { id_usuario: { in: ids } },
    orderBy: { ultima_vez: 'desc' },
  });
  const mapa = new Map();
  for (const f of filas) {
    const lista = mapa.get(f.id_usuario) ?? [];
    if (lista.length < porCuenta) {
      lista.push({
        referencia: referenciaDe(f.dispositivo_hash),
        etiqueta: f.etiqueta,
        inicios: f.inicios,
        primeraVez: f.primera_vez.toISOString(),
        ultimaVez: f.ultima_vez.toISOString(),
      });
    }
    mapa.set(f.id_usuario, lista);
  }
  return mapa;
}

module.exports = {
  ID_VALIDO,
  hashDispositivo,
  hashPerfil,
  normalizarPerfil,
  familiaDelNavegador,
  etiquetaDe,
  desdeCabeceras,
  registrarInicio,
  registrarInicioSeguro,
  dispositivosDe,
  referenciaDe,
};
