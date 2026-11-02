const test = require('node:test');
const assert = require('node:assert/strict');
const { cargar } = require('./redisHelpers');
const manifiesto = require('../src/config/embeddingsModelo');

// embeddingService con un modelo y un disco de mentira: no carga onnxruntime ni lee los 130 MB. Lo que se prueba es
// el contrato —prefijo siempre, lotes de 16, un cálculo a la vez, nada de internet, error claro si falta el
// modelo, sin reintentar en cada edición—; que el modelo real ponga cada producto cerca de sus parecidos lo mide
// scripts/verificarSimilares.js.
const DIMENSION = manifiesto.DIMENSION;

// `presentes`: archivos del manifiesto que existen en el «disco» (por defecto todos, con su tamaño exacto);
// `tamanos` pisa el tamaño de alguno (un archivo cortado). `falla`: hace que cargar la librería nativa lance.
function servicio({ presentes = manifiesto.ARCHIVOS.map((a) => a.ruta), tamanos = {}, falla = false, dimension = DIMENSION, ahora = { t: 1000 } } = {}) {
  const registro = { pipelines: [], lotes: [], activas: 0, maximoSimultaneas: 0, existe: 0, liberados: 0, entorno: {} };
  // «/» delante: sin él, «tokenizer_config.json» también termina en «config.json» y se confunden.
  const archivoDe = (ruta) => manifiesto.ARCHIVOS.find((a) => ruta.replaceAll('\\', '/').endsWith(`/${a.ruta}`));
  const fs = {
    existsSync: (ruta) => {
      registro.existe += 1;
      return presentes.includes(archivoDe(ruta)?.ruta);
    },
    statSync: (ruta) => ({ size: tamanos[archivoDe(ruta)?.ruta] ?? archivoDe(ruta)?.bytes }),
  };
  // El «modelo»: el primer número de cada vector es el largo del texto con su prefijo, para reconocer el orden y el prefijo.
  const extractor = async (textos) => {
    registro.activas += 1;
    registro.maximoSimultaneas = Math.max(registro.maximoSimultaneas, registro.activas);
    registro.lotes.push([...textos]);
    await new Promise((resolver) => setImmediate(resolver));
    registro.activas -= 1;
    if (textos.some((t) => t.includes('TEXTO QUE FALLA'))) throw new Error('fallo del runtime');
    const data = new Float32Array(textos.length * dimension);
    textos.forEach((texto, i) => { data[i * dimension] = texto.length; });
    return { dims: [textos.length, dimension], data };
  };
  extractor.dispose = async () => { registro.liberados += 1; };
  const transformers = {
    env: registro.entorno,
    pipeline: async (tarea, repositorio, opciones) => {
      registro.pipelines.push({ tarea, repositorio, opciones });
      return extractor;
    },
  };
  const dependencias = {
    'node:fs': fs,
    '../config/embeddingsModelo': { ...manifiesto, carpeta: () => 'C:/modelos-de-prueba' },
  };
  Object.defineProperty(dependencias, '@huggingface/transformers', {
    enumerable: true,
    get: () => { if (falla) throw new Error('no se pudo cargar onnxruntime-node'); return transformers; },
  });
  const modulo = cargar('../src/services/embeddingService.js', dependencias, {}, { Date: { now: () => ahora.t } });
  return { ...modulo, registro, ahora };
}

const largo = (texto) => `query: ${texto}`.length;

// ── Qué se incrusta ─────────────────────────────────────────────────────────

test('el texto de un producto es su descripción, la subcategoría y la categoría', () => {
  const { textoDeProducto } = servicio();
  assert.equal(textoDeProducto({ nombre: 'Marca A', descripcion: 'Camiseta polo clásica', subcategoria: { subcategoria: 'Camisetas', categoria: 'Ropa' } }), 'Camiseta polo clásica. Camisetas. Ropa.');
});

test('lo que falta se omite, sin escribir «undefined» ni «null»', () => {
  const { textoDeProducto } = servicio();
  assert.equal(textoDeProducto({ nombre: 'Solo título', subcategoria: { categoria: 'Ropa' } }), '');
  assert.equal(textoDeProducto({ descripcion: 'Producto sin datos' }), 'Producto sin datos.');
  assert.equal(textoDeProducto({ descripcion: 'X', subcategoria: { subcategoria: null, categoria: 'Ropa' } }), 'X. Ropa.');
});

// ── Cálculo ─────────────────────────────────────────────────────────────────

test('cada texto lleva SIEMPRE el prefijo «query: » (también en los lotes siguientes): el llamador no puede olvidarlo', async () => {
  const s = servicio();
  await s.incrustar(Array.from({ length: 20 }, (_, i) => `Producto ${i}`));
  const enviados = s.registro.lotes.flat();
  assert.equal(enviados.length, 20);
  assert.ok(enviados.every((t) => t.startsWith('query: ')));
  assert.equal(manifiesto.PREFIJO, 'query: ');
});

test('trabaja de a 16 y devuelve un vector por texto, en el mismo orden', async () => {
  const s = servicio();
  const textos = Array.from({ length: 40 }, (_, i) => `${'x'.repeat(i)} texto`);
  const vectores = await s.incrustar(textos);
  assert.deepEqual(s.registro.lotes.map((lote) => lote.length), [16, 16, 8]);
  assert.equal(vectores.length, 40);
  // Array.from: lo que devuelve el sandbox es de otro «realm» y deepEqual compara también el prototipo.
  assert.deepEqual(Array.from(vectores, (v) => v[0]), textos.map(largo), 'el vector i es el del texto i');
});

test('devuelve arreglos de números comunes de la dimensión del modelo: listos para ir al índice como JSON', async () => {
  const s = servicio();
  const [vector] = await s.incrustar(['Camiseta']);
  assert.ok(Array.isArray(vector), 'un Float32Array se serializaría como un objeto con índices');
  assert.equal(vector.length, DIMENSION);
  assert.equal(JSON.parse(JSON.stringify(vector)).length, DIMENSION);
  assert.equal(manifiesto.DIMENSION, 384);
});

test('si el modelo devuelve otra dimensión se rechaza: el índice no la aceptaría y el error diría poco', async () => {
  const s = servicio({ dimension: 768 });
  await assert.rejects(s.incrustar(['Camiseta']), /768 dimensiones.*384/);
});

test('una lista vacía no carga el modelo', async () => {
  const s = servicio();
  assert.deepEqual(Array.from(await s.incrustar([])), []);
  assert.equal(s.registro.pipelines.length, 0);
});

// ── Carga ───────────────────────────────────────────────────────────────────

test('el modelo se carga UNA vez, perezosamente, desde la carpeta local y sin permiso de bajar nada', async () => {
  const s = servicio();
  assert.equal(s.registro.pipelines.length, 0, 'al importar el módulo no se carga nada');
  await s.incrustar(['a']);
  await s.incrustar(['b']);
  await Promise.all([s.incrustar(['c']), s.incrustar(['d'])]);
  assert.equal(s.registro.pipelines.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(s.registro.pipelines[0])), {
    tarea: 'feature-extraction', repositorio: manifiesto.REPOSITORIO, opciones: { dtype: manifiesto.DTYPE },
  });
  assert.equal(s.registro.entorno.allowRemoteModels, false, 'nunca va a Internet por su cuenta');
  assert.equal(s.registro.entorno.localModelPath, 'C:/modelos-de-prueba');
});

test('si el modelo no está, el error dice qué falta y cómo bajarlo, y no se intenta cargar nada', async () => {
  const s = servicio({ presentes: ['config.json', 'tokenizer_config.json'] });
  await assert.rejects(s.incrustar(['a']), (err) => err instanceof s.ModeloNoDisponible
    && /npm run modelo:descargar/.test(err.message)
    && /onnx\/model_quantized\.onnx/.test(err.message)
    && /tokenizer\.json/.test(err.message));
  assert.equal(s.registro.pipelines.length, 0);
});

test('un archivo cortado (tamaño distinto al del manifiesto) cuenta como faltante', async () => {
  const s = servicio({ tamanos: { 'onnx/model_quantized.onnx': 1000 } });
  await assert.rejects(s.incrustar(['a']), /model_quantized\.onnx/);
  assert.deepEqual(Array.from(s.archivosFaltantes()), ['onnx/model_quantized.onnx']);
});

test('si la librería nativa no arranca en esta máquina es el mismo error, con la causa, no una caída del servidor', async () => {
  const s = servicio({ falla: true });
  await assert.rejects(s.incrustar(['a']), (err) => err instanceof s.ModeloNoDisponible && /no se pudo cargar/.test(err.message) && /onnxruntime/.test(err.cause.message));
});

test('tras una carga fallida no se reintenta en cada edición: se espera 30 s, y luego sí', async () => {
  const s = servicio({ presentes: [] });
  await assert.rejects(s.incrustar(['a']));
  const comprobaciones = s.registro.existe;
  s.ahora.t += 10000;
  await assert.rejects(s.incrustar(['b']), /modelo:descargar/);
  assert.equal(s.registro.existe, comprobaciones, 'dentro de la ventana ni siquiera se vuelve a mirar el disco');
  s.ahora.t += 21000; // ya pasaron 31 s
  await assert.rejects(s.incrustar(['c']));
  assert.ok(s.registro.existe > comprobaciones, 'pasada la ventana se vuelve a intentar');
});

// ── Un cálculo a la vez ─────────────────────────────────────────────────────

test('varias llamadas a la vez se atienden de a una (la memoria del runtime no depende de cuántos productos se editen juntos)', async () => {
  const s = servicio();
  const resultados = await Promise.all(Array.from({ length: 12 }, (_, i) => s.incrustar([`Producto ${i}`])));
  assert.equal(resultados.length, 12);
  assert.equal(s.registro.maximoSimultaneas, 1);
  assert.deepEqual(resultados.map(([[primero]]) => primero), Array.from({ length: 12 }, (_, i) => largo(`Producto ${i}`)), 'cada quien recibe SU vector');
  assert.ok(resultados.every((r) => r.length === 1));
});

test('un cálculo que falla no frena a los que esperan atrás', async () => {
  const s = servicio();
  const [malo, bueno] = await Promise.allSettled([s.incrustar(['TEXTO QUE FALLA']), s.incrustar(['Camiseta'])]);
  assert.equal(malo.status, 'rejected');
  assert.match(malo.reason.message, /fallo del runtime/);
  assert.equal(bueno.status, 'fulfilled');
  assert.equal(bueno.value[0].length, DIMENSION);
});

// ── Cierre ──────────────────────────────────────────────────────────────────

test('cerrar() suelta el modelo; la siguiente llamada lo vuelve a cargar', async () => {
  const s = servicio();
  await s.incrustar(['a']);
  await s.cerrar();
  assert.equal(s.registro.liberados, 1);
  await s.incrustar(['b']);
  assert.equal(s.registro.pipelines.length, 2);
  await s.cerrar();
  await s.cerrar(); // sin modelo cargado no hace nada
  assert.equal(s.registro.liberados, 2);
});
