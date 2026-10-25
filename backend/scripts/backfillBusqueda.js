require('dotenv').config();
const mongoose = require('mongoose');
const prisma = require('../src/config/prisma');
const elasticsearch = require('../src/config/elasticsearch');
const redisConfig = require('../src/config/redis');
const productoService = require('../src/services/productoService');
const busquedaSyncService = require('../src/services/busquedaSyncService');
const embeddingService = require('../src/services/embeddingService');
// Nunca se usa directo acá — pero productoService.listar() hace populate()
// hasta Categoria a través de Subcategoria, y Mongoose necesita el modelo
// YA REGISTRADO (algún require en algún lado) antes de poder resolverlo. El
// backend real lo registra sin darse cuenta porque algo en su árbol de
// requires ya importa Categoria; este script, aislado, no — sin esto falla
// con "Schema hasn't been registered for model Categoria".
require('../src/models/mongo/Categoria');

// Backfill hacia Elasticsearch (ver IA/PLAN-ELASTICSEARCH-BUSQUEDA.md §7) —
// necesario para el catálogo que ya existía antes de este cambio, y para
// reconstruir el índice completo si el mapping cambia. Reutiliza
// productoService.listar()/obtener() (ya resuelve subcategoría/categoría/
// inventario) en vez de reimplementar esa resolución acá — mismo criterio
// que backfillNeo4j.js reutiliza fraudeSyncService en vez de una segunda
// implementación. index:producto_id hace que reindexar sea un overwrite
// natural — correr esto de nuevo tantas veces como haga falta es seguro.
//
// Además RECALCULA el vector de cada producto (campo `embedding`, ver embeddingService.js): los vectores solo
// viven en Elasticsearch, así que reconstruir el índice exige tener el modelo (`npm run modelo:descargar`).
// Sin el modelo el script se detiene antes de tocar nada: indexar igual dejaría los productos sin vector, o
// con uno viejo, y el resumen diría «indexados» como si estuviera todo bien.
async function main() {
  await elasticsearch.conectar(); // asegura que el índice exista con el mapping explícito antes de indexar nada
  await embeddingService.incrustar(['comprobación del modelo']);
  const productos = await productoService.listar({ mostrarInactivos: true });
  let conVector = 0;
  for (const producto of productos) {
    if (await busquedaSyncService.indexarProducto(producto)) conVector += 1;
  }
  console.log(`Productos: ${productos.length} indexados en Elasticsearch, ${conVector} con su vector recalculado.`);
  if (conVector < productos.length) {
    console.error(`Quedaron ${productos.length - conVector} productos sin vector nuevo (mira los errores de arriba); correlo de nuevo.`);
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await mongoose.disconnect();
    await elasticsearch.cerrar();
    await embeddingService.cerrar();
    // productoService.listar() pregunta a Redis qué vendedores están suspendidos: esa
    // conexión mantendría vivo el proceso después de terminar.
    redisConfig.cerrar();
  });
