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

Definido en código (no configuración por defecto — requerimiento técnico explícito), reusado por el script de creación del índice y por `verificarBusqueda.js`. Lista **vigente**: son 15 campos; los últimos se agregaron después (§12, §13) y el mapping completo es estricto (§14):

```
producto_id:      integer
descripcion:      text (analizador "spanish") + descripcion.keyword
vendedor_nombre:  text (analizador "spanish") + vendedor_nombre.keyword
imagen_url:       keyword, index:false — se guarda para mostrarla en los resultados; nunca se busca ni se agrega por ella
categoria:        keyword   — denormalizado al indexar; Elasticsearch no hace joins
subcategoria:     keyword   — idem
categoria_id:     keyword   — id de la categoría en Mongo (texto), para el filtro exacto por categoría
subcategoria_id:  keyword   — idem, para el filtro exacto por subcategoría
atributos:        nested { nombre: keyword, valor: keyword }
precio:           float
cantidad:         integer
estado:           keyword
total_vendido:    integer   — orden «más vendidos»
vendedor_id:      integer   — solo presentación (§13)
sugerencia:       completion, contexts: [estado] — autocompletado (§12)
```

Además `dynamic: 'strict'` en la raíz: un campo que no figure en esta lista hace fallar el indexado en vez de que Elasticsearch le adivine el tipo (§14).

`atributos` como `nested` (no un array de objetos plano) por la misma razón que `condicionesAtributos()` usa `$elemMatch` en Mongo: sin eso, un filtro por `{nombre: Talla, valor: M}` podría calzar cruzando el nombre de un atributo con el valor de OTRO atributo distinto del mismo producto — `nested` mantiene cada par `{nombre, valor}` como una unidad indivisible, igual que `$elemMatch`.

## 7. Sincronización

Mismo split ya establecido dos veces (`fraudeService.js`/`fraudeSyncService.js`, `ventasService.js`/`ventasSyncService.js`): un servicio de lectura y uno de sincronización.

- `busquedaSyncService.indexarProducto(productoCompleto)` recibe el mismo objeto que ya arma `productoService.obtener()` — no reinventa la resolución de subcategoría/categoría, la reutiliza — y hace `index({ id: String(productoCompleto.id), document })`. `id` = `producto_id`: una reindexación es un overwrite natural, mismo principio de idempotencia por clave natural que ya rige Cassandra (`detalle_id`) y Neo4j (`MERGE` por contenido).
- Llamado desde `productoService.crear()` y `productoService.actualizar()`, al final de cada uno. **No** desde el checkout — ver §3.
- Mejor esfuerzo con `try/catch` propio: que falle no debe romper la creación/edición del producto.

## 8. Búsqueda y agregaciones

> Primera versión. La forma vigente — una sola consulta para buscar **y** navegar por categorías, con facetas disyuntivas, árbol de categorías, precio y paginación — está en §15.

`busquedaService.buscar({ q, categoriaId, subcategoriaId, atributos, precioMin, precioMax, ordenarPor })`:

- Con `q`: `multi_match` sobre `descripcion`/`vendedor_nombre`, `fuzziness: 'AUTO'`. Sin `q`: `match_all` filtrado — la misma consulta sirve de base a los facets incluso sin texto de búsqueda.
- Filtros exactos: `estado: 'activo'` (siempre — búsqueda es una vista pública, no repite la lógica de "vendedor ve sus propios inactivos" que sí tiene `GET /api/productos`), categoría/subcategoría, rango de precio, atributos vía filtro `nested`.
- Agregaciones (requerimiento técnico): `terms` sobre `categoria`/`subcategoria` (ya son `keyword`, no llevan subcampo), y una agregación `nested` sobre `atributos` con sub-agregaciones `terms` por `nombre`+`valor` — misma forma `{nombre: [valores]}` que ya espera `FacetFilters` en el frontend, para reusar ese componente.
- Devuelve `{ resultados, total, facetas, categorias, subcategorias }`: `facetas` es `{nombre: [valores]}` de los atributos; `categorias`/`subcategorias` traen el conteo por cada una.

`GET /api/busqueda` (público, sin auth — mismo criterio que `GET /api/productos`).

## 9. Frontend

> Primera versión; `HomePage.jsx` se rehízo en §15 (ya no hay un camino por Mongo para navegar ni `FacetFilters`).

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

**`busquedaService.sugerir(q)`** — consulta `suggest`/`completion` separada de `buscar()` (prefijo sobre `sugerencia`, sin relevancia de texto libre ni agregaciones — pensada para responder mientras el usuario todavía escribe): `size: 8`, `skip_duplicates: true`, `contexts: { estado: ['activo'] }`. Expuesta en `GET /api/busqueda/sugerencias?q=` (público). La versión original usaba solo `fuzzy: { fuzziness: 'AUTO' }`; desde 2026-10-19 hace **exactas primero, aproximadas solo si no hay ninguna** (ver abajo).

**Exactas primero, aproximadas de respaldo (2026-10-19).** Con `fuzzy` a secas, un texto bien escrito traía también a sus «vecinos»: «smartphone x» (12 letras, hasta 2 ediciones con `AUTO`) devolvía los 8 smartphones, porque cada uno empieza con «smartphone » más UNA letra distinta (b, c, e, g, p: una edición), y los 8 puntuaban igual (12), así que nada ponía la coincidencia exacta por encima de las aproximadas. Ahora `sugerir()` manda **dos suggesters en una misma petición** — `exactas` (prefijo exacto) y `aproximadas` (el mismo con `fuzzy`) — y devuelve las exactas si hay alguna y las aproximadas solo cuando no hay ninguna. «smartphone x» → solo `Smartphone X100`; «camis» → 8 camisetas; «bicicletta» (error de tipeo, sin exactas) → las bicicletas, así que la tolerancia a errores se conserva. El descarte de vendedores suspendidos se hace **antes** de decidir: si todas las exactas eran de vendedores ocultos, se usan las aproximadas visibles. Cubierto por `tests/busquedaSugerencias.test.js` (8 pruebas sin conexiones: la forma de la consulta, la decisión exacta/aproximada, el tope de 8 y los suspendidos; verificadas con cinco regresiones simuladas) y por la prueba 5 de `verificarBusqueda.js` contra el motor real.

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

## 15. Una sola consulta para buscar y navegar, con facetas disyuntivas (agregado después, 2026-10-20)

**Problema.** §8 dejó la búsqueda de texto en Elasticsearch, pero la pantalla principal seguía partida en dos caminos: con texto, `GET /api/busqueda`; navegando por categoría, `GET /api/productos` (Mongo) con las facetas calculadas en el navegador (`calcularFacetas()`), solo para la subcategoría elegida y sin conteos. Y las facetas del motor tenían el defecto clásico de las facetas de selección múltiple: salían de la misma consulta ya filtrada, así que al marcar `Talla=M` desaparecían `S`, `L` y `XL`, y no se podían marcar dos tallas a la vez. Todo lo que hacía falta (`categoria_id`, `subcategoria_id`, `atributos` nested, `precio`, `total_vendido`) ya estaba en el mapping (§6): el cambio es de consulta y de pantalla, **el mapping no se tocó**.

**Qué hace ahora `GET /api/busqueda`** (`busquedaService.buscar` y `facetasBusqueda.js`):

- Sin `q` es un `match_all`: navegar por categorías es la misma consulta que buscar texto (con `q`, `multi_match` con `fuzziness: 'AUTO'`, como en §8).
- Parámetros: `q`, `categoriaId`, `subcategoriaId`, `atributos` (JSON `{ nombre: [valores] }`), `precioMin`, `precioMax`, `ordenarPor` (`masVendidos`, `precioAsc`, `precioDesc`; por defecto, relevancia con texto), `pagina` y `tamano` (60 por defecto, 100 como máximo; `from + size ≤ 10000`). Un valor inválido se ignora; un precio mínimo mayor que el máximo se intercambia.
- **Facetas disyuntivas con `post_filter`.** En `query` queda solo lo que no es una faceta (texto, `estado: activo` y el `must_not` de vendedores suspendidos). Categoría, precio y atributos van en `post_filter`, que recorta los resultados pero no las agregaciones, y cada agregación lleva dentro un `filter` con **todos los filtros menos el suyo**. Dentro de un atributo los valores se suman (M o L); entre atributos se exigen todos (Talla M y Color Azul). No se usa una agregación `global`: contaría los productos de vendedores suspendidos.
- **Árbol de categorías con conteos**, de agregaciones `terms` anidadas sobre los `keyword` que ya existían: `categoria_id` → `subcategoria_id` (con un `terms` de tamaño 1 sobre `categoria`/`subcategoria` para el nombre). Cuenta texto y precio, no atributos (son de cada subcategoría), y las hermanas de la categoría elegida no desaparecen.
- **Atributos** (`nested`): nombres (`terms`, 20) con sus valores (`terms`, 30) y conteos, más un bloque `filter` por cada atributo ya elegido para que no colapse a lo marcado (el nombre de la agregación es un índice, `attr_0`, porque un nombre de atributo con `[`, `]` o `>` la rompería). Solo se ofrecen cuando texto + categoría caen en **una** subcategoría (la «Talla» de camisetas y la de zapatos no se mezclan); con varias, la pantalla invita a elegir una.
- **Precio:** `stats` (mínimo y máximo reales) y `range` con bordes 1-2-5 por década (Q10, 20, 50, 100, 200…), sin el filtro de precio ya elegido. Cada cubeta es `[desde, hasta)`: un clic manda `precioMax = hasta − 0.01`, para que el total coincida con el número que se ve.
- **Orden estable:** `producto_id` de desempate, así paginar no repite ni salta productos.
- Respuesta: `{ resultados, total, pagina, tamano, paginas, arbol, ruta (migas de pan), atributos, precio, filtros }` y, por compatibilidad, `facetas`, `categorias` y `subcategorias` con la forma de §8.

**Un solo módulo para los dos caminos.** `facetasBusqueda.js` reúne lo que no sabe de Elasticsearch ni de Mongo: la validación de la entrada, `armarRespuesta` (la forma de la respuesta) y `desdeLista` (las mismas facetas calculadas en JavaScript sobre una lista de productos). Con Elasticsearch apagado, `catalogoLecturaService.buscar` contesta desde Mongo con esa misma forma y `modo: 'basico'` (sin tolerancia a errores de tipeo, y la pantalla lo avisa); también lo hace en la portada si el índice está vacío (todavía no se corrió `npm run busqueda:backfill`), para que la tienda no aparezca vacía. Como el índice no se actualiza al comprar (§3), el stock y las ventas de los productos de la página se vuelven a leer de Mongo (una consulta por página, `conExistenciasVigentes`); sin Mongo se muestran los del índice.

**Parámetros internos fuera de la URL.** `buscar(opciones, internos)`: `vendedorId`, `incluirInactivos`, `conFacetas` y `tamanoMaximo` van en el segundo argumento, que solo arman los llamadores internos. Antes viajaban en el mismo objeto que `req.query` y `GET /api/busqueda?incluirInactivos=1&tamano=500` devolvía productos dados de baja (comprobado: 121 en vez de 109); ahora la URL pública los ignora. De paso, `categoriasDelIndice()` (el menú cuando Mongo está apagado) contaba también los productos inactivos y ahora cuenta solo los activos.

**Frontend.** `HomePage.jsx` es una sola pantalla y una sola consulta; lo elegido vive en la URL (`?q=&categoriaId=&subcategoriaId=&atributos=<JSON>&precioMin=&precioMax=&ordenarPor=&pagina=`, con ayudantes puros en `utils/filtrosBusqueda.js`), así que el botón «atrás», un enlace copiado y los enlaces del menú de categorías (`/?categoriaId=…`) funcionan sin estado aparte. Componentes nuevos en `components/search/`: `CategoryTree`, `AttributeFacets` (casillas con conteo, «Ver N más», «Limpiar»), `PriceFacet`, `Pagination` y `Migas`. Se quitaron `calcularFacetas()` y `FacetFilters`. El menú del encabezado sigue leyendo las categorías de Mongo, y `GET /api/productos` sigue para las pantallas del administrador y del vendedor.

**Verificación (2026-10-20).**

- `tests/busquedaFacetas.test.js` (26 pruebas sin conexiones: la forma de la consulta — `post_filter`, un `filter` por faceta con todos los demás filtros menos el suyo, `must_not` fuera del `post_filter`, sin `global` —, la validación de la entrada, `desdeLista` y `armarRespuesta`), `tests/busquedaFiltrosFrontend.test.js` (8, el ayudante de la URL) y `tests/resilienciaCatalogo.test.js` (el respaldo, la relectura del stock, el índice vacío). `npm run test:busqueda`: 49 pruebas; `npm run test:resiliencia`: 57.
- `npm run verificar:busqueda` tiene ahora 11 pruebas contra el catálogo real (109 productos activos): el árbol y las cubetas de precio suman el total; `Talla=M` da 4 resultados y Talla sigue mostrando `{M:4, L:2, S:2, XL:1}`; `Talla=M,L` da 6 (= 4 + 2); el clic en `Q20–Q50` trae los 5 que decía la cubeta; 2 páginas (60 + 49) sin repetir; `incluirInactivos`/`vendedorId`/`conFacetas` por la URL no hacen nada; y **el motor y el respaldo en Mongo dan lo mismo en 11 de 11 combinaciones** — dos implementaciones independientes de las mismas cuentas: si el índice o las agregaciones se desviaran, no coincidirían.
- Vendedores suspendidos: con el vendedor 2 suspendido el total baja de 109 a 54 y los conteos del árbol también (no se filtran por las agregaciones); motor y Mongo coinciden en las 12 combinaciones probadas (4 conjuntos de suspendidos × 3 consultas).
- Con los contenedores apagados de verdad (HTTP real contra el backend): sin `tiendaya-elasticsearch`, 17 de 17 consultas responden 200 con `modo: 'basico'` y 16 de 17 son idénticas a las del motor (la distinta es «camiceta», que sin tolerancia a tipeo da 0 resultados); sin `tiendaya-mongo`, 17 de 17 salen del índice (con tolerancia a tipeo). Al volver cada contenedor, la respuesta vuelve sola al modo normal.
- Navegador real: Ropa → Camisetas → Talla M + L (6 resultados, con M/L/S/XL siempre visibles) → Color Azul (3) → «atrás» vuelve a M + L; clic en `Q50–Q100` (4) y «Quitar»; «camiceta» encuentra las 9 camisetas; `?pagina=99` se corrige a la última página; en el celular el panel de filtros se pliega al elegir una categoría.

**Límites aceptados.** El orden «más vendidos» usa el `total_vendido` indexado: el número que muestra la tarjeta sí se relee de Mongo, pero el orden sale del índice, que se actualiza al crear o editar el producto (§3). Los atributos solo se ofrecen con una subcategoría a la vista, y traen como máximo 20 nombres y 30 valores por nombre. Con Elasticsearch apagado no hay tolerancia a errores de tipeo.

## 16. Sugerencias cuando un texto no encuentra nada (agregado después, 2026-10-21 a 2026-10-23)

**Qué es y qué no es.** No es un endpoint nuevo: es el mismo `GET /api/busqueda` de §15, que ahora acepta una **sesión opcional**. Cuando un texto no encuentra ningún producto, la respuesta sigue diciendo `total: 0` pero suma una lista `sugeridos` con productos que probablemente le interesen a quien pregunta, en vez de una página vacía. Lo implementaron Jose (commits `2eee964` y `4241955`) y se revisó y corrigió el 2026-10-23. **No es similitud semántica ni vectorial** (eso es del ítem de recomendación de la Entrega Final, `PLAN-ENTREGA-FINAL.md` §3): «relacionado» significa «lo último que esa persona hizo», no «parecido por significado».

**Cómo entra la sesión.** `POST /api/auth/login` devuelve un JWT con `id_usuario` y rol; el frontend lo guarda (`tiendaya_token`) y `HomePage` lo manda en `Authorization: Bearer` (`busquedaApi.buscar(filtros, token)`). La ruta usa `optionalAuth`: verifica la firma y que la cuenta no esté suspendida y deja el usuario en `req.usuario`, pero **nunca rechaza**: sin token, con un token inválido o vencido, o con una cuenta suspendida, la búsqueda es la pública de siempre (sin personalizar). La identidad sale siempre del token, nunca de un parámetro de la URL.

**Qué se guarda.** Para una cuenta con sesión, una lista de Redis `actividad:{id_usuario}` (hasta 5 entradas JSON `{tipo, valor}`, la más reciente primero y sin repetidos, 30 días de TTL): una búsqueda de texto que **sí** encontró algo (el texto ya normalizado: recortado y de a lo sumo 200 caracteres) o el detalle de un producto **activo** que abrió (`GET /api/productos/:id`, también con `optionalAuth`). Se escribe en segundo plano: no hace más lenta la respuesta y, si Redis está caído, simplemente no se guarda (se avisa una vez por caída con `registrarFallo`, no una línea por petición).

**Cadena de sugerencias** (`catalogoLecturaService.sugeridosSinResultados`), la primera capa que dé algo gana: (1) la **última actividad** de la lista — una búsqueda que se vuelve a ejecutar (`origenSugerencia: 'busquedaReciente'`, con `terminoBusquedaReciente`) o el último producto visto, si sigue activo y su vendedor no está suspendido (`'productoVisto'`); (2) las recomendaciones por **historial de compras** (`tendenciaService`, las de «Recomendado para vos»: `'historial'`); (3) los **más vendidos** del catálogo (`'tendencia'`, también para quien no inició sesión). Si calcularlas falla, la respuesta es la de cero resultados sin sugerencias: nunca tumba la búsqueda. En la pantalla las dibuja `SugeridosSinResultados` bajo el aviso «No encontramos productos…».

**Correcciones de la revisión del 2026-10-23:**

- `?q=a&q=b` (Express lo entrega como arreglo) con sesión daba **503** (`opciones.q.trim is not a function`): ahora se usa el mismo texto normalizado que se le manda al motor (`normalizarConsulta`).
- Un producto **pausado** (inactivo), que se abre por su URL directa, podía quedar como «Lo último que viste» y sugerirse con botón de compra: ahora no se registra la vista y, aunque se hubiera pausado después, tampoco se sugiere.
- Las sugerencias por búsqueda reciente venían del índice con el **stock viejo** (el índice no se entera de las ventas): ahora se relee de Mongo, igual que en los resultados (`conExistenciasVigentes`).
- `tests/resilienciaCatalogo.test.js` estaba **en rojo** (19 de 57 pruebas de `test:resiliencia`): el servicio pasó a importar `tendenciaService` y `config/redis` y el cargador de pruebas no tenía dobles para ellos. Se agregaron esos dobles, se actualizaron las 3 pruebas que asumían la semántica anterior de «cero resultados» y se escribieron 13 nuevas (cadena de sugerencias, guardado de la actividad, `?q` repetido, producto pausado, Redis apagado): la suite queda en 70 de 70. Cada corrección se verificó deshaciéndola a propósito en una copia y viendo que alguna prueba se pone en rojo.

**Límites y pendientes.** (1) También se ofrecen sugerencias cuando son los **filtros** (precio, categoría, atributos) los que dejan el texto en cero: puede mostrar justo lo que se acaba de filtrar. (2) No hay forma de **borrar el historial** ni se avisa en los Términos de Servicio de que se guardan, por cuenta y durante 30 días, las búsquedas y los productos vistos. (3) Para quien no tiene historial la última capa muestra «Los más vendidos», que incluye cualquier producto de prueba (`[PRUEBA …]`) que siga activo; el catedrático dijo, de quien no tenga historial, que mejor no mostrarle nada (confirmar). (4) Para el control de acceso por cuenta de servicio de Redis, las claves `actividad:*` pertenecen al módulo del catálogo/búsqueda.
