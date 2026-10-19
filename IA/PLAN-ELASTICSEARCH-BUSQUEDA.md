# Plan — Elasticsearch para búsqueda de productos (Entrega 3)

> Creado: 2026-09-22.

## 1. Qué pide el PRD y qué falta

Entrega 3 (15 pts, PRD §5) tiene dos partes. La de consistencia distribuida ya está hecha:

| Requerimiento | Peso | Estado |
|---|---|---|
| Buscador con tolerancia a variaciones + filtros facetados | 5.0 pts | 🔲 Este documento |
| Documento de estrategia de consistencia del checkout distribuido | 5.0 pts | ✅ `ENTREGA-3-CONSISTENCIA.md` |
| Evidencia de prueba de falla simulada | 4.0 pts | ✅ mismo documento, dos fallas reales simuladas |
| Calidad del informe | 1.0 pt | 🟡 falta la parte de búsqueda |

Requerimientos técnicos exactos del buscador:
- Índice de búsqueda con **mapping definido deliberadamente** (no configuración por defecto).
- Al menos **autocompletado o corrección ortográfica** (una alcanza).
- Al menos **una agregación** para filtros facetados.

## 2. Estado actual (lo que esto reemplaza)

`productoService.listar()` (`backend/src/services/productoService.js`) filtra `descripcion` con `$regex` sobre MongoDB — substring simple, sin relevancia, sin tolerancia a errores de tipeo. Los filtros facetados ya existen en `HomePage.jsx` (`calcularFacetas()`), pero se calculan en el **cliente**, a partir de la lista completa de productos de una subcategoría — el propio código ya lo documenta como "simplificación deliberada, no recalcula conteos por opción restante como haría un sitio real". Es exactamente el hueco que una agregación real del motor de búsqueda cierra.

## 3. Decisión de consistencia: mejor esfuerzo, no outbox durable

Mismo principio ya usado en `ENTREGA-3-CONSISTENCIA.md` §3: la fuerza de la garantía de sincronización debe emparejar el costo real de que el dato quede desactualizado.

- Si el índice de búsqueda queda unos segundos atrás de Mongo, el costo es bajo: el producto sigue siendo comprable por su URL directa (`/productos/:id`), y precio/stock reales se vuelven a leer de Mongo en el detalle y en el carrito — nunca se confía en lo indexado para eso.
- No es comparable a perder una venta (por eso Cassandra tiene un outbox durable con reintentos, `ventasOutboxService.js`). Es más parecido al caso de Neo4j: reenvío de mejor esfuerzo (`fraudeSyncService.js`), sin outbox, recuperable con un script de backfill si algo falla.

**Decisión:** se sigue el patrón de `fraudeSyncService.js` (mejor esfuerzo, `try/catch` propio, backfill de recuperación), no el de `ventasOutboxService.js`.

## 4. Alcance de "autocompletado o corrección ortográfica": corrección ortográfica

Se implementa **tolerancia a errores de tipeo** (`fuzziness: 'AUTO'` en la query de texto principal) — es lo que además pide literalmente la sección "Funcionalidades" del PRD ("texto libre con tolerancia a variaciones"), y no exige mapping nuevo, solo un parámetro de consulta. Autocompletado (que necesitaría un `completion` suggester o un analizador `edge_ngram` aparte) queda fuera de este alcance — se puede agregar después sin tocar lo de acá.

## 5. Infraestructura

`docker-compose.yml` — nuevo servicio `elasticsearch`, un nodo de desarrollo (mismo criterio que Cassandra/Neo4j, no alta disponibilidad):

- `discovery.type=single-node`, `xpack.security.enabled=false` — sin autenticación en desarrollo, deliberado y documentado como tal (igual que Neo4j usa una contraseña fija de desarrollo). **Control de acceso en un componente NoSQL es un requerimiento de Entrega Final, no de esta** — no se resuelve acá a propósito.
- `ES_JAVA_OPTS=-Xms512m -Xmx512m`, `mem_limit: 1g` — catálogo de prueba de ~10 productos, no hace falta más; ya conviven Cassandra + Neo4j + Mongo + MySQL + Redis en la misma máquina de desarrollo.
- Puerto publicado solo en `127.0.0.1:9200` (mismo criterio que Cassandra/Neo4j).
- Volumen `elasticsearch_data` para no perder el índice entre reinicios.

`backend/package.json`: dependencia `@elastic/elasticsearch` (cliente oficial, mismo rol que `neo4j-driver`/`cassandra-driver`/`ioredis`).

`.env`/`.env.example` (raíz y `backend/`): `ELASTICSEARCH_URL`, `ELASTICSEARCH_INDICE`.

## 6. Mapping explícito

Definido en código (no configuración por defecto — requerimiento técnico explícito), reusado por el script de creación del índice y por `verificarBusqueda.js`:

```
descripcion:      text (analizador "spanish") + descripcion.keyword
vendedor_nombre:  text (analizador "spanish") + vendedor_nombre.keyword
categoria:        keyword   — denormalizado al indexar; Elasticsearch no hace joins
subcategoria:     keyword   — idem
atributos:        nested { nombre: keyword, valor: keyword }
precio:           float
cantidad:         integer
estado:           keyword
producto_id:      integer
total_vendido:    integer
```

`atributos` como `nested` (no un array de objetos plano) por la misma razón que `condicionesAtributos()` usa `$elemMatch` en Mongo: sin eso, un filtro por `{nombre: Talla, valor: M}` podría calzar cruzando el nombre de un atributo con el valor de OTRO atributo distinto del mismo producto — `nested` mantiene cada par `{nombre, valor}` como una unidad indivisible, igual que `$elemMatch`.

## 7. Sincronización

Mismo split ya establecido dos veces (`fraudeService.js`/`fraudeSyncService.js`, `ventasService.js`/`ventasSyncService.js`): un servicio de lectura y uno de sincronización.

- `busquedaSyncService.indexarProducto(productoCompleto)` recibe el mismo objeto que ya arma `productoService.obtener()` — no reinventa la resolución de subcategoría/categoría, la reutiliza — y hace `index({ id: String(productoCompleto.id), document })`. `id` = `producto_id`: una reindexación es un overwrite natural, mismo principio de idempotencia por clave natural que ya rige Cassandra (`detalle_id`) y Neo4j (`MERGE` por contenido).
- Llamado desde `productoService.crear()` y `productoService.actualizar()`, al final de cada uno. **No** desde el checkout — ver §3.
- Mejor esfuerzo con `try/catch` propio: que falle no debe romper la creación/edición del producto.

## 8. Búsqueda y agregaciones

`busquedaService.buscar({ q, categoriaId, subcategoriaId, atributos, precioMin, precioMax, ordenarPor })`:

- Con `q`: `multi_match` sobre `descripcion`/`vendedor_nombre`, `fuzziness: 'AUTO'`. Sin `q`: `match_all` filtrado — la misma consulta sirve de base a los facets incluso sin texto de búsqueda.
- Filtros exactos: `estado: 'activo'` (siempre — búsqueda es una vista pública, no repite la lógica de "vendedor ve sus propios inactivos" que sí tiene `GET /api/productos`), categoría/subcategoría, rango de precio, atributos vía filtro `nested`.
- Agregaciones (requerimiento técnico): `terms` sobre `categoria.keyword`/`subcategoria.keyword`, y una agregación `nested` sobre `atributos` con sub-agregaciones `terms` por `nombre`+`valor` — misma forma `{nombre: [valores]}` que ya espera `FacetFilters` en el frontend, para reusar ese componente.
- Devuelve `{ resultados, facetas, total }`.

`GET /api/busqueda` (público, sin auth — mismo criterio que `GET /api/productos`).

## 9. Frontend

- `frontend/src/api/busqueda.js` (nuevo), mismo patrón que `api/productos.js`.
- `HomePage.jsx`: con `q` presente, usa `busquedaApi.buscar()`; sin `q` (solo navegando por categoría), sigue exactamente como está — ese camino no se toca. `FacetFilters` pasa a recibir los facets reales de la búsqueda cuando aplica.

## 10. Verificación planeada

`backend/scripts/verificarBusqueda.js`, mismo espíritu que `verificarFraudeNeo4j.js`:
1. Búsqueda con una falta de ortografía a propósito (p. ej. "camiceta") sigue encontrando el producto — prueba tolerancia ortográfica real.
2. Un término que aparece más veces en la descripción rankea antes que uno donde aparece menos — prueba relevancia real, no orden arbitrario.
3. La respuesta trae `facetas` con conteos que coinciden con lo que hay realmente en Mongo — prueba que la agregación es real.

Más `npm run busqueda:backfill` (reindexar el catálogo existente) y una prueba en navegador real con una falta de ortografía deliberada en la barra de búsqueda ya existente.

## 11. Orden de trabajo

1. Este documento.
2. Infraestructura (`docker-compose.yml`, `.env.example`, dependencia).
3. `config/elasticsearch.js` + mapping + `backfillBusqueda.js`.
4. `busquedaSyncService.js`, enganchado en `crear()`/`actualizar()`.
5. `busquedaService.js` + `busquedaRoutes.js`.
6. `verificarBusqueda.js` contra datos reales.
7. Frontend: `api/busqueda.js` + integración en `HomePage.jsx`.
8. Prueba real en navegador.
9. Actualizar `ESTADO-PROYECTO.md`.

## 12. Autocompletado (agregado después, 2026-09-22)

§4 dejó el autocompletado fuera de alcance deliberadamente ("se puede agregar después sin tocar lo de acá"). Se agregó una vez que la tolerancia ortográfica ya estaba funcionando y verificada, sin tocar ninguno de los campos existentes del mapping.

**Por qué `completion` y no `edge_ngram`:** `completion` es el tipo de campo de Elasticsearch pensado específicamente para typeahead — un FST interno optimizado para prefijos — y soporta `fuzzy` de forma nativa (mismo criterio de tolerancia a errores que ya usa `buscar()`). Un analizador `edge_ngram` habría requerido definir un analizador de índice separado del de búsqueda para no explotar el índice con ngramas de cada substring; `completion` no necesita nada de eso.

**Campo agregado al mapping** (`config/elasticsearch.js`), sin tocar los campos existentes:
```
sugerencia: completion, contexts: [{ name: 'estado', type: 'category' }]
```
`contexts.estado` existe porque un producto inactivo se sigue indexando igual que uno activo (`busquedaSyncService.js` no filtra por estado al indexar) — sin el contexto, un producto pausado/inactivo seguiría apareciendo como sugerencia aunque `buscar()` ya lo excluye de los resultados reales, llevando a una sugerencia que resuelve en cero resultados. El contexto deja filtrar `estado:activo` en la propia consulta de sugerencias.

**`conectar()` cambiado para ser autosanable:** antes solo aplicaba el mapping al crear el índice (`indices.create()`); ahora llama `indices.putMapping()` también cuando el índice ya existe. Agregar un campo nuevo a un mapping ya aplicado es una operación válida en Elasticsearch (a diferencia de cambiar el tipo de un campo existente), así que esto permite seguir ampliando `MAPPING` sin necesitar borrar y recrear el índice a mano cada vez — confirmado corriendo `npm run busqueda:backfill` sobre el índice ya existente de 106 productos, sin recrearlo.

**`busquedaService.sugerir(q)`** — consulta `suggest`/`completion` separada de `buscar()` (prefijo + fuzzy sobre `sugerencia`, sin relevancia de texto libre ni agregaciones — pensada para responder mientras el usuario todavía escribe): `size: 8`, `skip_duplicates: true`, `fuzzy: { fuzziness: 'AUTO' }`, `contexts: { estado: ['activo'] }`. Expuesta en `GET /api/busqueda/sugerencias?q=` (público).

**Frontend (`Header.jsx`)** — debounce de 250ms sobre el input de búsqueda ya existente, dropdown con navegación por teclado (flechas + Enter + Escape) y clic-afuera-cierra (mismo patrón `mousedown`+`contains` que ya usa `CategoryMenu.jsx`, no `onBlur`, porque `onBlur` del input dispara antes que el `onClick` de una sugerencia y la cerraría antes de poder seleccionarla). Un `ultimaBusquedaRef` evita que el dropdown se reabra solo justo después de ejecutar una búsqueda: sin él, seleccionar una sugerencia deja ese mismo texto en el input, lo que vuelve a disparar el efecto de autocompletado y reabre el dropdown con sugerencias que calzan contra el propio texto ya buscado, encima de la página de resultados — encontrado y corregido probando en navegador real, no era el comportamiento esperado.

**Verificación:** `verificarBusqueda.js` (prueba 4) confirma `sugerir("bicicletta")` (typo deliberado) devuelve las 8 bicicletas del catálogo. Probado también en navegador real: prefijo con typo, selección por teclado (flechas + Enter) y por mouse, clic afuera para cerrar sin navegar, y confirmación de que escribir un texto nuevo después de seleccionar una sugerencia vuelve a disparar sugerencias frescas correctamente.

## 13. `vendedor_id` en el índice (agregado después, 2026-10-04)

Desde que un vendedor no puede comprar sus propios productos ([PLAN-NEO4J-DETECCION-FRAUDE.md](PLAN-NEO4J-DETECCION-FRAUDE.md) §18), la tarjeta de un resultado de búsqueda necesita saber si el producto es del usuario que mira, para no ofrecerle un botón que el servidor va a rechazar con 403. Se agregó un campo, sin tocar ninguno de los existentes:

```
vendedor_id: integer      — id de la cuenta vendedora (referencia a MySQL usuarios.id_usuario)
```

Se llena al indexar (`busquedaSyncService.aDocumento`, desde el `vendedor_id` que ya trae el documento de Mongo) y se devuelve en cada resultado (`busquedaService.aProducto`). Es solo un dato de **presentación**: la barrera real es `productoService.verificarNoEsPropio` en el servidor, que consulta MySQL, no este índice. Mismo mecanismo de §12: `conectar()` aplica `putMapping()` sobre el índice ya existente, así que no hizo falta recrearlo — solo `npm run busqueda:backfill` para que los documentos ya indexados lleven el campo (reindexados: 108 productos).

## 14. Mapping estricto y prueba de alineación (agregado después, 2026-10-18)

**Cambio:** `MAPPING` (`config/elasticsearch.js`) lleva ahora `dynamic: 'strict'`. Hasta entonces declaraba los 15 campos pero dejaba `dynamic` en su valor por defecto (`true`): un campo que `aDocumento()` agregara sin declararlo lo creaba Elasticsearch por su cuenta, adivinando el tipo — justo lo que el requerimiento ("mapping deliberado, no la configuración por defecto") pide evitar.

**Por qué importaba** (comprobado en un índice temporal con el mapping real, que se borró después): un campo olvidado (`descripcion_corta`) quedó como `text` con el analizador estándar y buscar "camisetas" no encontraba nada ahí, mientras que en `descripcion` (analizador `spanish`) encontraba 2; un campo mal escrito (`precioo`) creó un campo nuevo sin ningún error y ese producto desapareció del filtro de precio.

**Con `strict`**, un campo no declarado hace fallar el indexado con `strict_dynamic_mapping_exception`, también dentro de objetos internos (`atributos`). `dynamic` se puede cambiar sobre un índice que ya existe con `putMapping`, así que `conectar()` lo aplicó al índice real sin recrearlo (mismo mecanismo que §12 y §13); una escritura de prueba con un campo no declarado fue rechazada (400), y `npm run busqueda:backfill` reindexó después los productos reales sin rechazos.

**El costo de `strict` aquí y cómo se cubre:** `indexarProducto()` es de mejor esfuerzo (§3): ante un rechazo solo registra el error, así que un campo olvidado dejaría el producto *sin indexar* en vez de indexado con un tipo equivocado. Lo que lo evita es `tests/busquedaMapping.test.js` (`npm run test:busqueda`, 7 pruebas sin conexiones): el mapping es estricto; todo campo que produce `aDocumento()` está declarado (también dentro de `atributos` y en los contextos de `sugerencia`); todo campo declarado lo llena `aDocumento()` (el descuido inverso, que `strict` no detecta: buscar por ese campo nunca encontraría nada); el conjunto de campos no depende de los datos del producto; y cada campo declara su tipo y los `text`, su analizador. Verificada con seis descuidos simulados (campo olvidado, campo mal escrito, atributo con `_id`, campo declarado sin llenar, `strict` quitado, `text` sin analizador): cada uno hace fallar la prueba correspondiente.
