// Utilidades del spike de pagos (IA/ADR-005): medición con histogramas,
// concurrencia acotada y tablas en Markdown. Nada de esto se importa desde src/.
const { createHistogram } = require('node:perf_hooks');

const ahoraMs = () => Number(process.hrtime.bigint()) / 1e6;
const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Cola compartida: cada trabajador toma la siguiente tarea apenas termina la
// suya. Así la concurrencia efectiva se mantiene constante durante toda la
// corrida, en vez de ser una ráfaga inicial que luego decae a 1.
async function conConcurrencia(total, concurrencia, tarea) {
  let siguiente = 0;
  const resultados = new Array(total);
  async function trabajador() {
    for (;;) {
      const i = siguiente++;
      if (i >= total) return;
      resultados[i] = await tarea(i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrencia, total) }, trabajador));
  return resultados;
}

// Una celda del benchmark: latencia por operación (histograma en microsegundos,
// porque el histograma solo acepta enteros ≥ 1) y rendimiento total.
async function medir({ total, concurrencia, operacion }) {
  const h = createHistogram();
  let errores = 0;
  let primerError = null;
  const inicio = ahoraMs();
  await conConcurrencia(total, concurrencia, async (i) => {
    const a = ahoraMs();
    try {
      await operacion(i);
    } catch (err) {
      errores++;
      primerError ||= err.message;
      return;
    }
    h.record(Math.max(1, Math.round((ahoraMs() - a) * 1000)));
  });
  const segundos = (ahoraMs() - inicio) / 1000;
  const ok = total - errores;
  return {
    ok, errores, primerError, segundos,
    ops_s: ok / segundos,
    p50_ms: h.percentile(50) / 1000,
    p95_ms: h.percentile(95) / 1000,
    p99_ms: h.percentile(99) / 1000,
  };
}

const mediana = (valores) => {
  const orden = [...valores].sort((a, b) => a - b);
  const m = Math.floor(orden.length / 2);
  return orden.length % 2 ? orden[m] : (orden[m - 1] + orden[m]) / 2;
};

const f = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : String(n));

// Tabla Markdown. `columnas`: [{ clave, titulo }]; los valores ya vienen formateados.
function tabla(columnas, filas) {
  const cab = `| ${columnas.map((c) => c.titulo).join(' | ')} |`;
  const sep = `|${columnas.map(() => '---').join('|')}|`;
  const cuerpo = filas.map((fila) => `| ${columnas.map((c) => fila[c.clave] ?? '').join(' | ')} |`);
  return [cab, sep, ...cuerpo].join('\n');
}

// Registro de verificaciones de un experimento: cada una es una afirmación
// comprobable que puede fallar (el spike sale con código 1 si alguna falla).
function nuevoRegistro() {
  const checks = [];
  return {
    checks,
    chequear(nombre, condicion, detalle = '') {
      checks.push({ nombre, ok: !!condicion, detalle });
      return !!condicion;
    },
  };
}

module.exports = { ahoraMs, esperar, conConcurrencia, medir, mediana, f, tabla, nuevoRegistro };
