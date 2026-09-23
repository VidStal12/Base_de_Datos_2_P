require('dotenv').config();
const mongoose = require('mongoose');
const prisma = require('../src/config/prisma');
const elasticsearch = require('../src/config/elasticsearch');
const productoService = require('../src/services/productoService');
const busquedaSyncService = require('../src/services/busquedaSyncService');
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
async function main() {
  await elasticsearch.conectar(); // asegura que el índice exista con el mapping explícito antes de indexar nada
  const productos = await productoService.listar({ mostrarInactivos: true });
  let procesados = 0;
  for (const producto of productos) {
    await busquedaSyncService.indexarProducto(producto);
    procesados += 1;
  }
  console.log(`Productos: ${procesados} indexados en Elasticsearch.`);
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
  });
