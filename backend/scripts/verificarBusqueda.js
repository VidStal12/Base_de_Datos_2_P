require('dotenv').config();
const elasticsearch = require('../src/config/elasticsearch');
const busquedaService = require('../src/services/busquedaService');

// Verifica contra el catálogo REAL ya indexado (correr npm run
// busqueda:backfill antes si hace falta) — no datos sintéticos armados
// solo para este script, mismo criterio que verificarCarrito.js. Las tres
// pruebas corresponden una a una a los tres requerimientos técnicos de
// Entrega 3 (ver IA/PLAN-ELASTICSEARCH-BUSQUEDA.md §1): mapping deliberado
// ya se prueba solo con que esto corra (el índice no existiría sin él),
// tolerancia ortográfica, y agregación real.
async function main() {
  await elasticsearch.conectar();
  let todasOk = true;

  // 1) Tolerancia ortográfica: "camiceta" (typo a propósito de "camiseta")
  // sigue encontrando productos con "camiseta" en la descripción.
  const conTypo = await busquedaService.buscar({ q: 'camiceta' });
  const encontroConTypo = conTypo.resultados.some((p) => p.descripcion.toLowerCase().includes('camiseta'));
  console.log(
    (encontroConTypo ? 'OK' : 'FALLA') +
      ` — "camiceta" (con error) encontró ${conTypo.resultados.length} resultado(s); incluye "camiseta": ${encontroConTypo}`
  );
  todasOk &&= encontroConTypo;

  // 2) Relevancia real, no orden arbitrario: hay dos camisetas en el
  // catálogo — "Camiseta premium de algodón orgánico" y "Camiseta de
  // algodón pima". Buscar "camiseta premium" tiene que rankear la primera
  // (coincide en las DOS palabras) antes que la segunda (coincide en una).
  const porRelevancia = await busquedaService.buscar({ q: 'camiseta premium' });
  const primero = porRelevancia.resultados[0];
  const relevanciaOk = primero?.descripcion === 'Camiseta premium de algodón orgánico';
  console.log((relevanciaOk ? 'OK' : 'FALLA') + ` — "camiseta premium" rankeó primero: "${primero?.descripcion}"`);
  todasOk &&= relevanciaOk;

  // 3) Agregación real, no decorativa: dentro de la subcategoría Camisetas,
  // los dos productos ORIGINALES del seed comparten Talla:M y Color:Azul —
  // se afirma que la faceta los INCLUYE (no que sea EXACTAMENTE ese
  // conjunto): el catálogo puede seguir creciendo (ver scripts/
  // sembrarCatalogo.js) sin que esta aserción quede obsoleta cada vez que
  // alguien agregue más camisetas — lo que importa es que la agregación siga
  // encontrando datos reales, no un conteo fijo congelado en el tiempo.
  const CAMISETAS_ID = '6a8aa3e599d4a899583bc867';
  const porSubcategoria = await busquedaService.buscar({ subcategoriaId: CAMISETAS_ID });
  const tallas = porSubcategoria.facetas.Talla || [];
  const colores = porSubcategoria.facetas.Color || [];
  const facetasOk = porSubcategoria.resultados.length >= 2 && tallas.includes('M') && colores.includes('Azul');
  console.log(
    (facetasOk ? 'OK' : 'FALLA') +
      ` — Camisetas: ${porSubcategoria.resultados.length} resultado(s), facetas Talla=${JSON.stringify(tallas)} Color=${JSON.stringify(colores)}`
  );
  todasOk &&= facetasOk;

  // 4) Autocompletado (completion suggester, ver config/elasticsearch.js):
  // un prefijo con una letra de más ("bicicletta") igual sugiere los
  // productos de "Bicicletas" — prueba la tolerancia difusa del suggester,
  // no solo la del multi_match de buscar().
  const sugerencias = await busquedaService.sugerir('bicicletta');
  const sugerenciasOk = sugerencias.length > 0 && sugerencias.every((s) => s.toLowerCase().includes('bicicleta'));
  console.log(
    (sugerenciasOk ? 'OK' : 'FALLA') + ` — sugerir("bicicletta") devolvió ${sugerencias.length}: ${JSON.stringify(sugerencias)}`
  );
  todasOk &&= sugerenciasOk;

  console.log(todasOk ? 'Todas las verificaciones de búsqueda pasaron.' : 'Hay verificaciones que fallaron.');
  process.exitCode = todasOk ? 0 : 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await elasticsearch.cerrar();
  });
