const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// `entorno`: las variables de entorno que ve el módulo (process.env), para los que
// leen secretos o configuración al cargarse o al usarse. `globales`: lo que se quiera
// reemplazar del sandbox (p. ej. un `Date` con reloj propio, para los módulos que miden
// un memo con Date.now()).
function cargar(archivo, dependencias, entorno = {}, globales = {}) {
  const ruta = path.resolve(__dirname, archivo);
  const requireLocal = createRequire(ruta);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(ruta, 'utf8'), {
    module, require: (nombre) => Object.hasOwn(dependencias, nombre) ? dependencias[nombre] : requireLocal(nombre),
    Date, Map, Set, Promise, Number, JSON, console: { error() {}, log() {} }, process: { env: entorno }, ...globales,
  }, { filename: ruta });
  return module.exports;
}

function redisFalso() {
  const hashes = new Map();
  const valores = new Map();
  const ttls = new Map();
  const redis = {
    hashes, valores, ttls,
    async hgetall(k) { return { ...(hashes.get(k) || {}) }; },
    async get(k) { return valores.get(k) ?? null; },
    async mget(...ks) { return ks.map((k) => valores.get(k) || null); },
    async del(k) { hashes.delete(k); valores.delete(k); ttls.delete(k); },
    async set(k, v, ex, ttl, nx) {
      if (nx === 'NX' && valores.has(k)) return null;
      valores.set(k, v); ttls.set(k, ttl); return 'OK';
    },
    async leerCarrito(k, revision, ttl) {
      const contenido = hashes.get(k) || {};
      if (hashes.has(k)) ttls.set(k, ttl);
      return [valores.get(revision) || '0', Object.entries(contenido).flat()];
    },
    async publicarCarrito(k, revision, esperado, ttl, payload) {
      if ((valores.get(revision) || '0') !== esperado) return 0;
      hashes.set(k, { _formato: '3', ...JSON.parse(payload) }); ttls.set(k, ttl); return 1;
    },
    async invalidarCarrito(k, revision) {
      const siguiente = Number(valores.get(revision) || 0) + 1;
      valores.set(revision, String(siguiente)); await redis.del(k); return siguiente;
    },
    // Los tres scripts de la oferta flash (config/redis.js), con la misma semántica
    // que el Lua real — la prueba contra un Redis de verdad es verificar:ofertaCache.
    async leerOferta(k, revision, ttl, ahora) {
      if (valores.has(k)) { valores.delete(k); ttls.delete(k); } // clave de un formato anterior (cadena): se descarta
      const contenido = hashes.get(k) || {};
      if (Object.keys(contenido).length > 0) {
        let restante = ttl;
        const vence = Number(contenido.vence_en);
        if (vence && vence - ahora < restante) restante = vence - ahora; // el TTL deslizante nunca pasa del fin de la oferta
        if (restante > 0) ttls.set(k, restante);
        else { hashes.delete(k); ttls.delete(k); return [valores.get(revision) || '0', []]; }
      }
      return [valores.get(revision) || '0', Object.entries(contenido).flat()];
    },
    async publicarOferta(k, revision, esperado, ttl, payload, formato) {
      if ((valores.get(revision) || '0') !== esperado) return 0;
      hashes.set(k, { _formato: formato, ...JSON.parse(payload) }); ttls.set(k, Number(ttl)); return 1;
    },
    async invalidarOferta(k, revision) {
      const siguiente = Number(valores.get(revision) || 0) + 1;
      valores.set(revision, String(siguiente)); hashes.delete(k); ttls.delete(k); return siguiente;
    },
    pipeline() {
      const operaciones = [];
      const p = {};
      for (const metodo of ['del', 'hset', 'expire', 'set']) p[metodo] = (...args) => { operaciones.push([metodo, args]); return p; };
      p.exec = async () => {
        for (const [metodo, [k, v, ex, ttl, nx]] of operaciones) {
          if (metodo === 'del') await redis.del(k);
          if (metodo === 'hset') hashes.set(k, { ...hashes.get(k), ...v });
          if (metodo === 'expire') ttls.set(k, v);
          if (metodo === 'set') await redis.set(k, v, ex, ttl, nx);
        }
        return operaciones.map(() => [null, 1]);
      };
      return p;
    },
  };
  return redis;
}

// Doble de productoService para los servicios de compra: `propios` son los ids
// de producto que pertenecen a quien compra (la regla "nadie compra lo que él
// mismo vende"). Rechaza igual que el real: 403, antes de cualquier otra cosa.
// `suspendidos` son los vendedores suspendidos (sus productos no se muestran ni se
// pueden comprar): por omisión nadie. `catalogo` es el doble del modelo de Mongo
// (find().select().lean()): estadoPublicacion() lo consulta igual que el real.
function productoFalso({ propios = [], suspendidos = [], catalogo, ...resto } = {}) {
  const ids = new Set(propios);
  // Un Set compartido por referencia deja suspender y levantar a un vendedor a mitad de una prueba.
  const ocultos = suspendidos instanceof Set ? suspendidos : new Set(suspendidos);
  return {
    vendedoresOcultos: async () => ocultos,
    vendedorOculto: async (vendedorId) => ocultos.has(Number(vendedorId)),
    verificarVendedoresActivos: async () => {},
    estadoPublicacion: async (productoIds) => {
      const docs = catalogo ? await catalogo.find({ producto_id: { $in: productoIds } }).select().lean() : [];
      return new Map(docs.map((doc) => {
        const principal = doc.imagenes?.find((img) => img.principal) || doc.imagenes?.[0];
        return [doc.producto_id, { estado: doc.estado, vendedor_id: doc.vendedor_id, descripcion: doc.descripcion, imagen_url: principal?.url || '' }];
      }));
    },
    ...resto,
    verificarNoEsPropio: async (usuarioId, productoIds) => {
      if (productoIds.some((id) => ids.has(id))) {
        const err = new Error('No podés comprar tus propios productos');
        err.status = 403;
        throw err;
      }
    },
  };
}

// Doble de compromisoService: `vendedores` son las cuentas que pueden vender y
// por lo tanto tienen que aceptar el compromiso de no reventa. Mismo contrato
// que el real: 400 con `codigo` si falta la aceptación, y el instante que hay
// que guardar en el pedido si la hay.
const ACEPTADO_EN = new Date('2026-10-04T12:00:00Z');

function compromisoFalso({ vendedores = [] } = {}) {
  const cuentas = new Set(vendedores);
  const llamadas = [];
  return {
    llamadas,
    exigirCompromiso: async (usuarioId, aceptaNoReventa) => {
      llamadas.push({ usuarioId, aceptaNoReventa });
      if (!cuentas.has(usuarioId)) return { requerido: false, aceptadoEn: null };
      if (aceptaNoReventa !== true) {
        const err = new Error('Como vendedor tenés que aceptar el compromiso de no reventa');
        err.status = 400;
        err.codigo = 'COMPROMISO_NO_REVENTA';
        throw err;
      }
      return { requerido: true, aceptadoEn: ACEPTADO_EN };
    },
  };
}

// Doble de politicaAccesoService para las pruebas del middleware de roles: decide como el código (la lista de
// roles de requireRole) salvo lo que se le diga en `reglas` ({ 'GET /ruta': { comprador: true } }: un rol permitido
// o negado a mano). La política real, con sus reglas de MySQL, se prueba en tests/permisos*.test.js.
function politicaAccesoFalsa({ reglas = {} } = {}) {
  return {
    permite: async (usuario, clave, porDefecto) => {
      const regla = reglas[clave]?.[usuario.rol];
      return { permitido: regla ?? porDefecto.includes(usuario.rol), origen: regla === undefined ? 'codigo' : 'regla', rol: usuario.rol };
    },
  };
}

// Doble de auditoriaAccesoService: anota las denegaciones en vez de escribirlas en Mongo.
function auditoriaAccesoFalsa() {
  const denegaciones = [];
  return {
    denegaciones,
    registrarDenegacion: (usuario, ruta, rol) => {
      denegaciones.push({ id: usuario?.id_usuario, ruta, rol });
      return true;
    },
    registrar: async () => true,
    registrarVarios: async () => true,
  };
}

module.exports = { cargar, redisFalso, productoFalso, compromisoFalso, politicaAccesoFalsa, auditoriaAccesoFalsa, ACEPTADO_EN };
