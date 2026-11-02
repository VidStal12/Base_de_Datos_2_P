require('dotenv').config();
const mongoose = require('mongoose');
const elasticsearch = require('../src/config/elasticsearch');
const redisConfig = require('../src/config/redis');
// productoService.listar (el respaldo de la prueba 11) arma la subcategoría con populate y Mongoose necesita Categoria registrado.
require('../src/models/mongo/Categoria');
const busquedaService = require('../src/services/busquedaService');
const productoService = require('../src/services/productoService');
const facetas = require('../src/services/facetasBusqueda');

const suma = (numeros) => numeros.reduce((a, b) => a + b, 0);
const iguales = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const idsOrdenados = (respuesta) => respuesta.resultados.map((p) => p.id).sort((a, b) => a - b);

// Verifica contra el catálogo REAL ya indexado (correr npm run
// busqueda:backfill antes si hace falta) — no datos sintéticos armados
// solo para este script, mismo criterio que verificarCarrito.js. Las
// pruebas 1 a 5 corresponden a los requerimientos técnicos de Entrega 3
// (ver IA/PLAN-ELASTICSEARCH-BUSQUEDA.md §1): mapping deliberado ya se
// prueba solo con que esto corra (el índice no existiría sin él),
// tolerancia ortográfica, agregación real y autocompletado. Las pruebas 6
// a 11 son las de las facetas de la pantalla (§15): árbol de categorías y
// precios que suman, facetas disyuntivas, clic en una cubeta de precio,
// paginación, parámetros internos fuera de la URL y paridad entre el motor
// y el respaldo en Mongo.
async function main() {
  await elasticsearch.conectar();
  let todasOk = true;

  // 1) Tolerancia ortográfica: "camiceta" (typo a propósito de "camiseta")
  // sigue encontrando productos con "camiseta" en la descripción.
  const conTypo = await busquedaService.buscar({ q: 'camiceta' });
  const encontroConTypo = conTypo.resultados.some((p) => p.nombre.toLowerCase().includes('camiseta'));
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
  const relevanciaOk = primero?.nombre === 'Camiseta premium de algodón orgánico';
  console.log((relevanciaOk ? 'OK' : 'FALLA') + ` — "camiseta premium" rankeó primero: "${primero?.nombre}"`);
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

  // 5) Autocompletado que se estrecha: un texto bien escrito no debe traer a sus
  // "vecinos" por tolerancia. "smartphone x" solo coincide con "Smartphone X100";
  // con fuzzy a secas traía también todos los demás "Smartphone ?" (difieren en
  // UNA letra). Las aproximadas solo se usan si no hay ninguna exacta — por eso
  // la prueba 4 ("bicicletta", sin exactas) sigue funcionando.
  const estrechas = await busquedaService.sugerir('smartphone x');
  const estrechasOk = estrechas.length > 0 && estrechas.every((s) => s.toLowerCase().startsWith('smartphone x'));
  console.log(
    (estrechasOk ? 'OK' : 'FALLA') + ` — sugerir("smartphone x") devolvió ${estrechas.length}: ${JSON.stringify(estrechas)}`
  );
  todasOk &&= estrechasOk;

  // 6) Árbol de categorías y rangos de precio SALIDOS de agregaciones: cada nivel suma lo de abajo, y la
  // suma de todo el árbol (y de todas las cubetas de precio) es el total de la búsqueda — si una
  // agregación contara de más o de menos, esto no cuadraría. Misma comprobación con texto de por medio.
  const todo = await busquedaService.buscar({});
  const conTexto = await busquedaService.buscar({ q: 'camiceta' });
  const arbolOk = [todo, conTexto].every(
    (r) =>
      r.total === suma(r.arbol.map((c) => c.cantidad)) &&
      r.arbol.every((c) => c.cantidad === suma(c.subcategorias.map((s) => s.cantidad))) &&
      r.total === suma(r.precio.rangos.map((rango) => rango.cantidad))
  );
  console.log(
    (arbolOk ? 'OK' : 'FALLA') +
      ` — el árbol (${todo.arbol.map((c) => `${c.nombre} ${c.cantidad}`).join(', ')}) y las cubetas de precio suman el total (${todo.total}; con "camiceta": ${conTexto.total})`
  );
  todasOk &&= arbolOk;

  // 7) Facetas DISYUNTIVAS: marcar Talla=M no esconde a S, L ni XL (siguen con su conteo de antes), marcar
  // dos tallas suma sus conteos (O dentro de un atributo), y otro atributo (Color) se recalcula con el filtro.
  const CAMISETAS_TODAS = await busquedaService.buscar({ subcategoriaId: CAMISETAS_ID });
  const cuentaTallas = Object.fromEntries(CAMISETAS_TODAS.atributos.find((a) => a.nombre === 'Talla').valores.map((v) => [v.valor, v.cantidad]));
  const conM = await busquedaService.buscar({ subcategoriaId: CAMISETAS_ID, atributos: { Talla: ['M'] } });
  const conML = await busquedaService.buscar({ subcategoriaId: CAMISETAS_ID, atributos: { Talla: ['M', 'L'] } });
  const tallasConM = Object.fromEntries(conM.atributos.find((a) => a.nombre === 'Talla').valores.map((v) => [v.valor, v.cantidad]));
  const disyuntivasOk =
    conM.total === cuentaTallas.M &&
    iguales(tallasConM, cuentaTallas) &&
    conML.total === cuentaTallas.M + cuentaTallas.L &&
    conM.atributos.find((a) => a.nombre === 'Color').valores.every((v) => v.cantidad <= conM.total);
  console.log(
    (disyuntivasOk ? 'OK' : 'FALLA') +
      ` — Talla=M: ${conM.total} resultado(s) y Talla sigue mostrando ${JSON.stringify(tallasConM)}; Talla=M,L: ${conML.total} (= ${cuentaTallas.M} + ${cuentaTallas.L})`
  );
  todasOk &&= disyuntivasOk;

  // 8) Un clic en una cubeta de precio trae EXACTAMENTE los productos que la cubeta contó (la cubeta es
  // [desde, hasta): la interfaz manda precioMax = hasta − 0.01), y las demás cubetas no se desinflan.
  const cubeta = todo.precio.rangos.find((rango) => rango.cantidad > 3);
  const clic = await busquedaService.buscar({ precioMin: cubeta.desde, precioMax: Math.round((cubeta.hasta - 0.01) * 100) / 100 });
  const precioOk = clic.total === cubeta.cantidad && iguales(clic.precio.rangos, todo.precio.rangos);
  console.log((precioOk ? 'OK' : 'FALLA') + ` — clic en Q${cubeta.desde}–Q${cubeta.hasta}: ${clic.total} resultado(s) (la cubeta decía ${cubeta.cantidad}) y las cubetas no cambian`);
  todasOk &&= precioOk;

  // 9) Paginación: las páginas no se pisan y entre todas suman el total (orden estable aunque haya empates).
  const paginas = [];
  for (let pagina = 1; pagina <= todo.paginas; pagina++) paginas.push(await busquedaService.buscar({ pagina }));
  const vistos = paginas.flatMap((r) => r.resultados.map((p) => p.id));
  const paginacionOk = new Set(vistos).size === vistos.length && vistos.length === todo.total;
  console.log((paginacionOk ? 'OK' : 'FALLA') + ` — ${todo.paginas} página(s) de ${todo.tamano}: ${vistos.length} productos distintos de ${todo.total}`);
  todasOk &&= paginacionOk;

  // 10) Lo interno no entra por la URL: la ruta pública le pasa a buscar() solo req.query, y
  // incluirInactivos / vendedorId son opciones INTERNAS (segundo argumento) — como parámetros de consulta no
  // cambian nada (antes un ?incluirInactivos=1 devolvía hasta los productos dados de baja).
  const intento = await busquedaService.buscar({ incluirInactivos: '1', vendedorId: '1', conFacetas: 'false', tamano: '500' });
  const internoOk = intento.total === todo.total && intento.arbol.length > 0 && intento.tamano <= 100;
  console.log((internoOk ? 'OK' : 'FALLA') + ` — incluirInactivos/vendedorId/conFacetas por la URL se ignoran: ${intento.total} de ${todo.total}, tamano ${intento.tamano}`);
  todasOk &&= internoOk;

  // 11) PARIDAD entre el motor y el respaldo: con Elasticsearch apagado la respuesta sale de Mongo y se
  // calcula en JavaScript (facetasBusqueda.desdeLista). Mismas combinaciones por los DOS caminos: tienen que
  // dar el mismo árbol, los mismos atributos y precios, los mismos totales y los mismos productos. Es un
  // contraste de dos implementaciones independientes sobre el catálogo real (y de que el índice está al día).
  const ROPA_ID = todo.arbol.find((c) => c.nombre === 'Ropa').id;
  const combinaciones = [
    {},
    { categoriaId: ROPA_ID },
    { subcategoriaId: CAMISETAS_ID },
    { subcategoriaId: CAMISETAS_ID, atributos: { Talla: ['M', 'L'] } },
    { subcategoriaId: CAMISETAS_ID, atributos: { Talla: ['M'], Color: ['Azul'] } },
    { precioMin: 50, precioMax: 99.99 },
    { categoriaId: ROPA_ID, precioMin: 20, precioMax: 100 },
    { ordenarPor: 'precioAsc', pagina: 2, tamano: 20 },
    { q: 'camiseta' },
    { q: 'smartphone' },
    { q: 'camiseta', categoriaId: ROPA_ID },
  ];
  const distintas = [];
  for (const combinacion of combinaciones) {
    const delMotor = await busquedaService.buscar(combinacion);
    const filtros = facetas.normalizarConsulta(combinacion);
    const deMongo = facetas.desdeLista(await productoService.listar({ q: filtros.q }), filtros);
    const claves = ['total', 'paginas', 'arbol', 'ruta', 'atributos', 'precio', 'filtros'];
    const mismoResumen = claves.every((clave) => iguales(delMotor[clave], deMongo[clave]));
    if (!mismoResumen || !iguales(idsOrdenados(delMotor), idsOrdenados(deMongo))) distintas.push(JSON.stringify(combinacion));
  }
  const paridadOk = distintas.length === 0;
  console.log(
    (paridadOk ? 'OK' : 'FALLA') +
      ` — motor y respaldo en Mongo coinciden en ${combinaciones.length - distintas.length} de ${combinaciones.length} combinaciones` +
      (paridadOk ? '' : `; difieren: ${distintas.join(' | ')}`)
  );
  todasOk &&= paridadOk;

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
    await mongoose.disconnect(); // la paridad (prueba 11) lee el catálogo de Mongo
    // buscar()/sugerir() preguntan a Redis qué vendedores están suspendidos (y no se
    // muestran): esa conexión mantendría vivo el proceso después de terminar.
    redisConfig.cerrar();
  });
