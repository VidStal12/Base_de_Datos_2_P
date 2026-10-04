const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function cargar(archivo, dependencias) {
  const ruta = path.resolve(__dirname, archivo);
  const requireLocal = createRequire(ruta);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(ruta, 'utf8'), {
    module, require: (nombre) => Object.hasOwn(dependencias, nombre) ? dependencias[nombre] : requireLocal(nombre),
    Date, Map, Set, Promise, Number, JSON, console: { error() {} }, process: { env: {} },
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

module.exports = { cargar, redisFalso };
