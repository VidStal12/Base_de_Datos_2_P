const { cargar } = require('./redisHelpers');

// Dobles en memoria para las pruebas aisladas del bloqueo de cuentas: un Redis con
// la semántica de PTTL/SET PX y del script Lua `bloquearCuenta` (escribe solo si el
// TTL nuevo es mayor), y un Prisma con la tabla `bloqueo_cuenta` (única por
// (id_usuario, huella)). La prueba contra un Redis y un MySQL de verdad es
// scripts/verificarBloqueoCuentas.js.

function redisBloqueos() {
  const claves = new Map(); // clave → { valor, venceEn (ms epoch) }
  const vigente = (k) => {
    const entrada = claves.get(k);
    if (!entrada) return null;
    if (entrada.venceEn <= Date.now()) {
      claves.delete(k);
      return null;
    }
    return entrada;
  };
  const redis = {
    claves,
    async pttl(k) {
      const entrada = vigente(k);
      return entrada ? entrada.venceEn - Date.now() : -2;
    },
    // Mismo contrato que el Lua real: escribe si el TTL actual es MENOR que el pedido.
    async bloquearCuenta(k, valor, ms) {
      if ((await redis.pttl(k)) < Number(ms)) {
        claves.set(k, { valor, venceEn: Date.now() + Number(ms) });
        return 1;
      }
      return 0;
    },
    async del(k) {
      if (!vigente(k)) return 0;
      claves.delete(k);
      return 1;
    },
    // Los dos scripts Lua de cupo por ventana (config/redis.js), con la misma semántica:
    // INCR + EXPIRE al abrir la ventana; si ya llegó al límite, deshace su INCR y
    // devuelve -1 con lo que falta; liberar nunca baja de cero ni resucita una ventana.
    async reservarCupo(k, limite, ventana) {
      let entrada = vigente(k);
      if (!entrada) {
        entrada = { valor: '0', venceEn: Date.now() + Number(ventana) * 1000 };
        claves.set(k, entrada);
      }
      const n = Number(entrada.valor) + 1;
      entrada.valor = String(n);
      const segundos = Math.max(1, Math.ceil((entrada.venceEn - Date.now()) / 1000));
      if (n > Number(limite)) {
        entrada.valor = String(n - 1);
        return [-1, segundos];
      }
      return [n, segundos];
    },
    async liberarCupo(k) {
      const entrada = vigente(k);
      if (!entrada || Number(entrada.valor) <= 0) return 0;
      entrada.valor = String(Number(entrada.valor) - 1);
      return Number(entrada.valor);
    },
    async scan(_cursor, _match, patron) {
      const prefijo = patron.replace('*', '');
      return ['0', [...claves.keys()].filter((k) => vigente(k) && k.startsWith(prefijo))];
    },
    pipeline() {
      const pedidos = [];
      const p = { pttl: (k) => (pedidos.push(k), p), exec: async () => Promise.all(pedidos.map(async (k) => [null, await redis.pttl(k)])) };
      return p;
    },
    // Adelanta el reloj de Redis: los TTL restantes bajan `ms` (lo que pasa cuando
    // el tiempo corre y no se toca nada).
    avanzar(ms) {
      for (const entrada of claves.values()) entrada.venceEn -= ms;
    },
  };
  return redis;
}

function coincide(fila, where = {}) {
  return Object.entries(where).every(([campo, condicion]) => {
    const valor = fila[campo];
    if (condicion !== null && typeof condicion === 'object' && !(condicion instanceof Date)) {
      if ('in' in condicion) return condicion.in.includes(valor);
      if ('lte' in condicion) return valor <= condicion.lte;
      throw new Error(`Condición no soportada por el doble de Prisma: ${JSON.stringify(condicion)}`);
    }
    return valor === condicion;
  });
}

function prismaBloqueos(usuarios) {
  const filas = [];
  let siguiente = 1;
  const usuarioDe = (id) => usuarios.find((u) => u.id_usuario === id) ?? null;
  return {
    filas,
    bloqueo_cuenta: {
      async create({ data }) {
        // Único (id_usuario, huella, tipo): el tipo por omisión es 'suspension', como en la tabla.
        const tipo = data.tipo ?? 'suspension';
        if (filas.some((f) => f.id_usuario === data.id_usuario && f.huella === data.huella && f.tipo === tipo)) {
          const err = new Error('Unique constraint failed');
          err.code = 'P2002';
          throw err;
        }
        const fila = { id: siguiente++, tipo: 'suspension', origen: 'automatico', estado: 'activo', evidencia: null, creado_en: new Date(), revisado_por: null, revisado_en: null, nota_revision: null, ...data };
        filas.push(fila);
        return { ...fila };
      },
      async findMany({ where, orderBy, take, include } = {}) {
        let resultado = filas.filter((f) => coincide(f, where));
        if (orderBy?.creado_en === 'desc') resultado = [...resultado].sort((a, b) => b.creado_en - a.creado_en || b.id - a.id);
        if (take) resultado = resultado.slice(0, take);
        return resultado.map((f) => ({
          ...f,
          ...(include?.usuario && { usuario: usuarioDe(f.id_usuario) }),
          ...(include?.revisor && { revisor: usuarioDe(f.revisado_por) }),
        }));
      },
      async updateMany({ where, data }) {
        let count = 0;
        for (const f of filas) {
          if (coincide(f, where)) {
            Object.assign(f, data);
            count += 1;
          }
        }
        return { count };
      },
      async update({ where, data }) {
        const fila = filas.find((f) => f.id === where.id);
        Object.assign(fila, data);
        return { ...fila };
      },
    },
    usuarios: {
      async findMany({ where }) {
        return usuarios.filter((u) => coincide(u, where));
      },
    },
    async $transaction(operaciones) {
      return Promise.all(operaciones);
    },
  };
}

const cuenta = (id, rol = 'comprador', nombres = `Cuenta${id}`) => ({ id_usuario: id, nombres, apellidos: 'Prueba', correo: `c${id}@example.com`, rol: { tipo_rol: rol } });

// bloqueoService + suspensionService + restriccionService reales, sobre un Redis y un
// Prisma en memoria; `consultarFraude` devuelve lo que se le ponga con `poner()`.
// Cada módulo se carga con el anterior como su doble de `require`, porque los
// `require` anidados de un módulo cargado en el vm no pasan por los dobles.
function escenario({ usuarios, hallazgos = {}, entorno = {} }) {
  const redis = redisBloqueos();
  const prisma = prismaBloqueos(usuarios);
  const candadoRedis = cargar('../src/services/candadoRedis.js', { '../config/redis': { conectar: () => redis } });
  const suspension = cargar('../src/services/suspensionService.js', { './candadoRedis': candadoRedis });
  const restriccion = cargar('../src/services/restriccionService.js', { './candadoRedis': candadoRedis, './suspensionService': suspension }, entorno);
  let datos = hallazgos;
  const servicio = cargar('../src/services/bloqueoService.js', {
    '../config/prisma': prisma,
    './suspensionService': suspension,
    './restriccionService': restriccion,
    './fraudeService': {
      consultarFraude: async () => datos,
      enriquecerUsuarios: async (ids) => ({
        fichas: new Map(ids.map((id) => [id, { id, nombre: `Cuenta${id} Prueba`, correo: `c${id}@example.com`, rol: usuarios.find((u) => u.id_usuario === id)?.rol.tipo_rol ?? 'comprador' }])),
      }),
    },
  }, entorno);
  return { redis, prisma, suspension, restriccion, servicio, poner: (nuevos) => { datos = nuevos; } };
}

// candadoRedis + suspensionService REALES sobre un Redis en memoria, para las pruebas que
// derivan la visibilidad de un vendedor del candado de suspensión (bloqueoOcultarVendedor).
// suspensionService mide su memo de 3 s con Date.now(): `reloj` es esa hora, que la prueba
// mueve a mano; `redis.avanzar(ms)` mueve la de los TTL de Redis, y `pasarTiempo(ms)` las
// dos juntas (lo que pasa en la vida real).
function suspensionReal() {
  const redis = redisBloqueos();
  const reloj = { ahora: Date.now() };
  class DateConReloj extends Date {
    static now() {
      return reloj.ahora;
    }
  }
  const candadoRedis = cargar('../src/services/candadoRedis.js', { '../config/redis': { conectar: () => redis } });
  const suspension = cargar('../src/services/suspensionService.js', { './candadoRedis': candadoRedis }, {}, { Date: DateConReloj });
  return {
    redis,
    reloj,
    suspension,
    pasarTiempo(ms) {
      redis.avanzar(ms);
      reloj.ahora += ms;
    },
  };
}

// Hallazgos con la forma que devuelve fraudeService.consultarFraude().
const ficha = (id, rol = 'comprador') => ({ id, nombre: `Cuenta${id} Prueba`, rol });
const hallazgoPersona = (ids, nivelConfianza = 'alta') => ({
  clave: ids.join('-'),
  nivelConfianza,
  motivo: `Las cuentas ${ids.join(', ')} son la misma persona.`,
  corroboradores: [{ tipo: 'fechaNacimiento', detalle: 'misma fecha de nacimiento' }],
  vinculos: [{ tipo: 'correo', ids }],
  totalOrdenes: 2,
  totalGastado: 100,
  miembros: ids.map((id) => ({ id, nombre: `Cuenta${id} Prueba`, ficha: ficha(id) })),
});
const hallazgoGasto = (usuarioId, compraId, nivelConfianza = 'alta') => ({
  nivelConfianza,
  motivo: `La cuenta ${usuarioId} gastó de más.`,
  corroboradores: [],
  usuario: { id: usuarioId, nombre: `Cuenta${usuarioId} Prueba`, ficha: ficha(usuarioId) },
  compraId,
  total: 5000,
  promedio: 80,
  vecesPromedio: 62.5,
});

module.exports = { redisBloqueos, prismaBloqueos, escenario, suspensionReal, cuenta, ficha, hallazgoPersona, hallazgoGasto };
