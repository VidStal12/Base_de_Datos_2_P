require('dotenv').config();
const elasticsearch = require('../src/config/elasticsearch');
const redisConfig = require('../src/config/redis');
const busquedaService = require('../src/services/busquedaService');
const embeddingService = require('../src/services/embeddingService');
const reglas = require('../src/services/reglasRelacionados');

// Evalúa «productos parecidos» (ver IA/ADR-006-recomendacion-semantica-vectorial.md) contra el catálogo REAL ya
// indexado: correr `npm run modelo:descargar` y `npm run busqueda:backfill` antes. Mide el camino de verdad
// (busquedaService.similares + reglas de negocio) y lo compara con lo que se tenía antes de los vectores
// (BM25 y more_like_this). Los números que cita el ADR salen de acá.
//
// La etiqueta de «relevante» es la subcategoría del catálogo (16 subcategorías): es automática y repetible, pero
// SOLO es una aproximación — un vecino de otra subcategoría puede ser perfectamente razonable (un short parecido a un
// pantalón corto), y el texto que se incrusta ya incluye la subcategoría (ver embeddingService.textoDeProducto), así que
// la cifra también mide esa pista. Por eso el informe imprime la variante «solo el título» y una muestra para
// que una persona juzgue los vecinos a ojo: la etiqueta automática no reemplaza ese juicio.
//
// Criterios (los de IA/PLAN-ENTREGA-FINAL.md §3.3, aplicados a la cadena completa):
//   1. todo producto activo tiene su vector;
//   2. precisión@5 ≥ 90 % (vecinos de la misma subcategoría entre los 5 primeros);
//   3. ningún producto queda sin sección: con menos de 2 parecidos por significado, la misma subcategoría los cubre;
//   4. con las consultas coloquiales, los vectores aciertan en más consultas que el buscador por texto;
//   5. las reglas de visibilidad se cumplen contra el motor real (ni el mismo producto, ni inactivos, ni lo propio).
const DE_PRUEBA = /^\[PRUEBA|^PRODUCTO DEMO/; // productos que dejan los scripts de verificación: no son catálogo
const PRECISION_MINIMA = 0.9;

const pct = (x) => `${(100 * x).toFixed(1)} %`;
const coseno = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const cuantil = (xs, q) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))];
const media = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const linea = (titulo) => console.log(`\n── ${titulo} ${'─'.repeat(Math.max(2, 76 - titulo.length))}`);

// Consultas coloquiales: lo que escribiría una persona que no usa el título exacto, y la(s) subcategoría(s) esperada(s).
const CONSULTAS = [
  ['celular', ['Celulares']], ['playera', ['Camisetas']], ['bici', ['Bicicletas']], ['tenis', ['Zapatos']],
  ['chumpa', ['Chaquetas']], ['compu', ['Laptops']], ['auriculares', ['Audífonos']], ['tele', ['Televisores']],
  ['pelota', ['Balones']], ['pesas para el gimnasio', ['Pesas']], ['cacerola', ['Cocina']], ['plantas y macetas', ['Jardín']],
  ['pants', ['Pantalones', 'Ropa deportiva']], ['sillón para la sala', ['Muebles']],
];

async function leerIndice() {
  const respuesta = await elasticsearch.conCircuito((cliente) => cliente.search({
    index: elasticsearch.indice(),
    size: 1000,
    sort: [{ producto_id: 'asc' }],
    _source: ['producto_id', 'descripcion', 'categoria', 'subcategoria', 'estado', 'vendedor_id', 'embedding'],
  }));
  return respuesta.hits.hits.map((hit) => ({ id: Number(hit._id), ...hit._source }));
}

async function main() {
  await elasticsearch.conectar();
  const todos = await leerIndice();
  const activos = todos.filter((d) => d.estado === 'activo');
  const reales = activos.filter((d) => !DE_PRUEBA.test(d.descripcion) && d.embedding);
  const inactivos = new Set(todos.filter((d) => d.estado !== 'activo').map((d) => d.id));
  const deSubcategoria = (doc, otro) => otro.subcategoria === doc.subcategoria;
  let todasOk = true;
  const criterio = (ok, texto) => { console.log(`${ok ? 'OK   ' : 'FALLA'} — ${texto}`); todasOk &&= ok; };

  console.log(`Índice ${elasticsearch.indice()}: ${todos.length} documentos, ${activos.length} activos (${reales.length} del catálogo real, sin los productos de prueba).`);

  // ── 1. Vectores ─────────────────────────────────────────────────────────────
  linea('1. Todo producto activo tiene su vector');
  const sinVector = activos.filter((d) => !d.embedding);
  criterio(sinVector.length === 0, `${activos.length - sinVector.length} de ${activos.length} productos activos con vector${sinVector.length ? `; sin vector: ${sinVector.map((d) => `#${d.id}`).join(' ')} (correr npm run busqueda:backfill)` : ''}`);
  if (reales.length < 10) throw new Error('Hay muy pocos productos con vector para evaluar: correr npm run busqueda:backfill');

  // ── 2. La cadena real: busquedaService.similares + reglas de negocio ────────
  linea('2. Parecidos por significado (el camino real) frente a la etiqueta «misma subcategoría»');
  const filas = [];
  const latencias = [];
  for (const doc of reales) {
    const t = performance.now();
    const { candidatos } = await busquedaService.similares(doc.id);
    latencias.push(performance.now() - t);
    const mostrados = reglas.elegir(candidatos.filter((c) => !DE_PRUEBA.test(c.descripcion)), { titulo: doc.descripcion });
    filas.push({ doc, mostrados, aciertos: mostrados.slice(0, 5).map((c) => c.subcategoria.subcategoria === doc.subcategoria) });
  }
  const conSeccion = filas.filter((f) => f.mostrados.length >= reglas.MINIMO);
  const precision = media(conSeccion.map((f) => f.aciertos.filter(Boolean).length / f.aciertos.length));
  const hit5 = media(conSeccion.map((f) => (f.aciertos.some(Boolean) ? 1 : 0)));
  const mrr = media(conSeccion.map((f) => { const i = f.aciertos.indexOf(true); return i < 0 ? 0 : 1 / (i + 1); }));
  const sinParecidos = filas.filter((f) => f.mostrados.length < reglas.MINIMO);
  // Los que no alcanzan por significado se cubren con la misma subcategoría (catalogoLecturaService.relacionados).
  const sinSeccion = sinParecidos.filter((f) => reales.filter((o) => o.id !== f.doc.id && deSubcategoria(f.doc, o)).length < reglas.MINIMO);
  console.log(`umbral de coseno ${reglas.UMBRAL_COSENO}, a lo sumo ${reglas.MOSTRAR} a mostrar, mínimo ${reglas.MINIMO}`);
  console.log(`  precisión@5 ${pct(precision)} · Hit@5 ${pct(hit5)} · MRR ${mrr.toFixed(3)}   (sobre los ${conSeccion.length} productos que muestran sección)`);
  console.log(`  por significado alcanzan ≥ ${reglas.MINIMO} parecidos: ${conSeccion.length} de ${filas.length} (${pct(conSeccion.length / filas.length)})`);
  if (sinParecidos.length > 0) console.log(`  caen a «misma subcategoría»: ${sinParecidos.map((f) => `#${f.doc.id} ${f.doc.descripcion}`).join(' · ')}`);
  console.log(`  latencia de similares() (leer el vector + kNN): p50 ${cuantil(latencias, 0.5).toFixed(0)} ms · p95 ${cuantil(latencias, 0.95).toFixed(0)} ms · máx ${Math.max(...latencias).toFixed(0)} ms`);
  criterio(precision >= PRECISION_MINIMA, `precisión@5 ${pct(precision)} (mínimo ${pct(PRECISION_MINIMA)})`);
  criterio(sinSeccion.length === 0, `ningún producto queda sin sección (${filas.length - sinParecidos.length} por significado + ${sinParecidos.length - sinSeccion.length} por subcategoría)${sinSeccion.length ? `; sin sección: ${sinSeccion.map((f) => `#${f.doc.id}`).join(' ')}` : ''}`);

  // ── 3. Lo que había antes: BM25 y more_like_this ────────────────────────────
  linea('3. Línea base sin vectores: el título como consulta (BM25) y more_like_this');
  let bm25Huerfanos = 0; let bm25Aciertos = 0; let bm25Con = 0; let mltDefecto = 0;
  for (const doc of reales) {
    const filtros = { filter: [{ term: { estado: 'activo' } }], must_not: [{ term: { producto_id: doc.id } }] };
    const [texto, similar] = await Promise.all([
      elasticsearch.conCircuito((c) => c.search({ index: elasticsearch.indice(), size: 5, _source: ['subcategoria', 'descripcion'], query: { bool: { must: [{ match: { descripcion: doc.descripcion } }], ...filtros } } })),
      elasticsearch.conCircuito((c) => c.search({ index: elasticsearch.indice(), size: 5, _source: ['subcategoria'], query: { bool: { must: [{ more_like_this: { fields: ['descripcion'], like: [{ _index: elasticsearch.indice(), _id: String(doc.id) }] } }], ...filtros } } })),
    ]);
    const vecinos = texto.hits.hits.map((h) => h._source).filter((s) => !DE_PRUEBA.test(s.descripcion));
    if (vecinos.length === 0) bm25Huerfanos += 1;
    else { bm25Con += 1; bm25Aciertos += vecinos.filter((s) => s.subcategoria === doc.subcategoria).length / vecinos.length; }
    if (similar.hits.hits.length > 0) mltDefecto += 1;
  }
  console.log(`  BM25 (título como consulta): ${bm25Huerfanos} de ${reales.length} productos sin ningún vecino · precisión@5 ${pct(bm25Aciertos / (bm25Con || 1))} entre los que sí tienen`);
  console.log(`  more_like_this con sus valores por defecto: ${mltDefecto} de ${reales.length} devuelven algo`);
  console.log(`  vectores: ${filas.length - sinParecidos.length} de ${filas.length} con ≥ ${reglas.MINIMO} parecidos · precisión@5 ${pct(precision)}`);

  // ── 4. Qué aporta el texto de la subcategoría (fuga de etiqueta) ────────────
  linea('4. Qué se incrusta: solo el título (A) o título + subcategoría + categoría (B)');
  const precisionExacta = (vectores) => media(reales.map((doc, i) => {
    const top = reales.map((o, j) => ({ j, s: j === i ? -2 : coseno(vectores[i], vectores[j]) })).sort((a, b) => b.s - a.s).slice(0, 5);
    return top.filter((x) => deSubcategoria(doc, reales[x.j])).length / 5;
  }));
  const soloTitulos = await embeddingService.incrustar(reales.map((d) => d.descripcion));
  const conCategoria = reales.map((d) => d.embedding);
  console.log(`  precisión@5 exacta (coseno en memoria, sin umbral): A solo título ${pct(precisionExacta(soloTitulos))} · B con subcategoría y categoría ${pct(precisionExacta(conCategoria))}`);
  console.log('  Ojo: B incluye la etiqueta que se mide, así que parte de esa diferencia es la pista y no «entendimiento».');

  // ── 5. Consultas coloquiales: donde el texto exacto falla ───────────────────
  linea('5. Consultas coloquiales: buscador por texto (BM25) frente a vectores');
  const vectoresConsulta = await embeddingService.incrustar(CONSULTAS.map(([texto]) => texto));
  let porTexto = 0; let porVectores = 0; let bm25SinResultados = 0;
  console.log('  consulta                    BM25: resultados · aciertos/5      vectores: aciertos/5 (mejor coseno)');
  for (const [k, [texto, esperadas]] of CONSULTAS.entries()) {
    const bm25 = await busquedaService.buscar({ q: texto, tamano: 5 });
    const aciertosTexto = bm25.resultados.slice(0, 5).filter((p) => esperadas.includes(p.subcategoria.subcategoria)).length;
    const vec = await elasticsearch.conCircuito((c) => c.search({
      index: elasticsearch.indice(),
      size: 5,
      _source: { excludes: ['embedding'] },
      knn: { field: 'embedding', query_vector: vectoresConsulta[k], k: 5, num_candidates: 100, filter: { term: { estado: 'activo' } } },
    }));
    const aciertosVec = vec.hits.hits.filter((h) => esperadas.includes(h._source.subcategoria)).length;
    if (bm25.total === 0) bm25SinResultados += 1;
    if (aciertosTexto >= 4) porTexto += 1;
    if (aciertosVec >= 4) porVectores += 1;
    console.log(`  ${`«${texto}»`.padEnd(26)} ${String(bm25.total).padStart(6)} · ${aciertosTexto}/5${' '.repeat(18)} ${aciertosVec}/5 (${(2 * (vec.hits.hits[0]?._score ?? 0.5) - 1).toFixed(2)})`);
  }
  console.log(`  consultas resueltas (≥ 4 de 5 correctos): texto ${porTexto} de ${CONSULTAS.length} · vectores ${porVectores} de ${CONSULTAS.length} · el buscador por texto no encontró nada en ${bm25SinResultados}`);
  criterio(porVectores > porTexto, `los vectores resuelven más consultas coloquiales que el texto (${porVectores} contra ${porTexto})`);

  // ── 6. Reglas de visibilidad contra el motor real ───────────────────────────
  linea('6. Reglas de visibilidad contra el motor real');
  const vendedores = [...new Set(reales.map((d) => d.vendedor_id))];
  const elegido = vendedores.map((v) => ({ v, n: reales.filter((d) => d.vendedor_id === v).length })).sort((a, b) => b.n - a.n)[0].v;
  let consigoMismo = 0; let deInactivos = 0; let conVector = 0; let delPropio = 0; let vecinosTotales = 0;
  for (const doc of reales) {
    const sano = await busquedaService.similares(doc.id);
    const propio = await busquedaService.similares(doc.id, { vendedorPropioId: elegido });
    for (const c of sano.candidatos) {
      vecinosTotales += 1;
      if (c.id === doc.id) consigoMismo += 1;
      if (inactivos.has(c.id)) deInactivos += 1;
      if ('embedding' in c) conVector += 1;
    }
    delPropio += propio.candidatos.filter((c) => c.vendedor_id === elegido).length;
  }
  criterio(consigoMismo === 0, `ningún producto aparece como parecido a sí mismo (${vecinosTotales} vecinos revisados)`);
  criterio(deInactivos === 0, `ningún producto inactivo aparece como parecido (${inactivos.size} inactivos en el índice)`);
  criterio(delPropio === 0, `con sesión del vendedor ${elegido} no se le ofrece nada suyo`);
  criterio(conVector === 0, 'ninguna respuesta devuelve el vector');

  // ── 7. El umbral ────────────────────────────────────────────────────────────
  linea('7. Calibración del umbral de coseno (con los vectores guardados, coseno exacto)');
  const mismas = []; const otras = [];
  for (let i = 0; i < reales.length; i++) for (let j = i + 1; j < reales.length; j++) (deSubcategoria(reales[i], reales[j]) ? mismas : otras).push(coseno(reales[i].embedding, reales[j].embedding));
  console.log(`  pares de la misma subcategoría: mediana ${cuantil(mismas, 0.5).toFixed(3)} · p5 ${cuantil(mismas, 0.05).toFixed(3)}   |   de otra: mediana ${cuantil(otras, 0.5).toFixed(3)} · p95 ${cuantil(otras, 0.95).toFixed(3)}`);
  console.log('  τ      productos con ≥ 2 vecinos   vecinos que son de la misma subcategoría');
  for (const tau of [0.86, 0.88, 0.9, 0.92, 0.94]) {
    let con2 = 0; let mismaSub = 0; let total = 0;
    reales.forEach((doc, i) => {
      const vecinos = reales.filter((o, j) => j !== i && coseno(doc.embedding, o.embedding) >= tau);
      if (vecinos.length >= reglas.MINIMO) con2 += 1;
      total += vecinos.length;
      mismaSub += vecinos.filter((o) => deSubcategoria(doc, o)).length;
    });
    console.log(`  ${tau.toFixed(2)}${tau === reglas.UMBRAL_COSENO ? ' ◄' : '  '}  ${pct(con2 / reales.length).padStart(8)}                    ${pct(total ? mismaSub / total : 0).padStart(8)}`);
  }

  // ── 8. Muestra para juzgar a ojo ────────────────────────────────────────────
  linea('8. Muestra para juzgar a ojo (1 de cada 9 productos): ¿son razonables estos parecidos?');
  filas.filter((_, i) => i % 9 === 0).forEach(({ doc, mostrados }) => {
    console.log(`  «${doc.descripcion}» [${doc.subcategoria}]`);
    for (const c of mostrados) console.log(`      ${(2 * c._score - 1).toFixed(3)}  ${c.descripcion} [${c.subcategoria.subcategoria}]${c.subcategoria.subcategoria === doc.subcategoria ? '' : '  ← otra subcategoría'}`);
    if (mostrados.length < reglas.MINIMO) console.log('      (no alcanza el mínimo por significado: se mostraría la misma subcategoría)');
  });

  console.log(todasOk ? '\nTodas las verificaciones de productos parecidos pasaron.' : '\nHay verificaciones que fallaron.');
  process.exitCode = todasOk ? 0 : 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await elasticsearch.cerrar();
    await embeddingService.cerrar();
    // buscar()/similares() preguntan a Redis qué vendedores están suspendidos: esa conexión mantendría vivo el proceso.
    redisConfig.cerrar();
  });
