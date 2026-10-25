# Plan — Entrega Final (Vectorial, Seguridad y Cierre)

> Creado: 2026-10-22. **Estado (2026-10-25): el ítem 2 (control de acceso, con su pantalla de permisos `/admin/permisos`) y el ítem 1 (recomendación semántica) están implementados y verificados —ADR-007 y ADR-006—; falta el diagrama, la retrospectiva y la presentación.** Se armó a partir del PRD, del estado real del repositorio y de la nota de voz del catedrático del 2026-10-21, con dos investigaciones en paralelo (una técnica —vectores y control de acceso— y una de cierre —diagrama, retrospectiva, presentación y calendario—). Lo que el agente técnico **probó** en contenedores desechables con las mismas imágenes del proyecto está marcado como «probado»; las horas son estimaciones, no mediciones. Las fuentes están en §12 y deben abrirse antes de citarlas en el informe.

## 0. Resumen

El PRD llama a esta entrega «Entrega Final — Vectorial, Seguridad y Cierre» (20 pts). Tiene cinco ítems; **11 de los 20 puntos (diagrama, retrospectiva y presentación) no dependen del código nuevo**, así que el cierre empieza hoy en paralelo con lo técnico.

| Ítem | Pts | Decisión recomendada | Esfuerzo (persona-horas, estimado) | Riesgo principal |
|---|---|---|---|---|
| **1. Recomendación semántica** (§3) | 5 | ✅ **Hecho el 2026-10-25** ([ADR-006](ADR-006-recomendacion-semantica-vectorial.md)): Elasticsearch `dense_vector` + kNN con embeddings locales (`multilingual-e5-small`); **los vectores viven solo en Elasticsearch** (se recalculan desde el texto del producto); respaldo: misma subcategoría desde Mongo | 20–24 (+ 2–3 de prueba previa) | Modelo de 118 MB en Windows/ONNX; calidad con títulos de ~21 caracteres → medidos, ver §3.9 |
| **2. Control de acceso NoSQL** (§4) | 4 | Dos capas: **API** (arreglar huecos reales + política por rol probada) y **cuentas de servicio** en Redis y Mongo; ADR-007 | 17–20 piso · 25–30 completo | Mongo con auth + replica set; que un error de credencial se confunda con una caída |
| **3. Diagrama final** (§5) | 3 | Cuatro vistas + una secuencia en Mermaid, con lista de chequeo contra el repo | 10–13 | Que se desfase del código |
| **4. Retrospectiva** (§6) | 4 | Tabla de 15 decisiones citadas, veredicto con número, arquitectura v2 | 8–9 | Que se lea como lista de opiniones |
| **5. Presentación** (§7) | 4 | Pirámide + tres demos con plan B + banco de preguntas | 10–12 | Docker o el equipo fallan en el aula |

**Esfuerzo total:** «piso» ≈ 60–65 h; «completo» ≈ 80–90 h; el *stretch* (historial de búsqueda, direcciones/IP, descripciones largas, seguridad en todas las bases) suma otras 40–55 h. Con tres personas el completo son ~27 h cada una; con dos, ~40 h cada una (ver §8 para los recortes si la fecha es la temprana).

**Lo que el análisis encontró y cambia el plan:**

1. **Hay huecos reales de autorización en la API**, comprobados en el código: el historial de un producto lo lee cualquier vendedor (no se verifica el dueño), las reseñas públicas devuelven el id y el nombre completo del autor, las estadísticas de edición no piden autenticación y el *health* público muestra texto crudo del driver. Es exactamente «un bug que deja ver de más» (audio): arreglarlos es el control de acceso más barato y más defendible (§4.1).
2. **Hoy Redis, Mongo, Cassandra y Elasticsearch no exigen credenciales** (sólo Neo4j, con una única cuenta compartida), y MySQL, Mongo y Redis escuchan en todas las interfaces (§2).
3. **Probado:** Neo4j Community crea usuarios pero **no roles** (sólo autenticación); Elasticsearch Basic sí trae seguridad, pero **no** RRF, ELSER ni `semantic_text`; `redis:7` no trae módulos vectoriales; MySQL 8.4 no tiene tipo `VECTOR`.
4. **Sin vectores, el buscador falla en lo coloquial:** BM25 deja 15 productos sin vecino y 10 de 12 consultas coloquiales («celular», «playera», «bici») dan 0 resultados (§3.1).
5. **Un error de credenciales se confundiría con una caída** o dejaría las suspensiones abiertas en silencio: hay que tratarlo aparte (§4.3).
6. **Documentación que no coincide con el código:** el diagrama de arquitectura actual no pasaría «completo y correcto» (§5); el ADR-003 justifica el replica set de Mongo por transacciones que el código no usa (§6); `.env.example` trae apagado el outbox de ventas (un clon limpio deja sin alimentar el panel de Cassandra).
7. **La memoria está al límite:** Elasticsearch usa 961 MiB de 1 GiB, Cassandra 1,86 de 2 GiB y al host le quedan ~1,4 GB libres de 15,6 → **no se agrega un séptimo contenedor** (§3.2).

**Calendario en una línea:** hoy jueves 22 de octubre; el lunes 26 la clase fija la fecha de la revisión; el examen es el lunes 2 de noviembre. Se planifica el MVP para la fecha temprana (jueves 29 o viernes 30) y lo *stretch* sólo entra si resulta ser la semana del 3 al 5 de noviembre (§8). **Decisiones y preguntas para el lunes:** §10.

## 1. Qué pide el PRD y qué dijo el catedrático

**PRD, «Entrega Final — Vectorial, Seguridad y Cierre» (20 pts).** Entregables: repositorio completo, informe de arquitectura final y presentación.

| Ítem | Pts | Qué pide el PRD |
|---|---|---|
| Recomendación semántica | 5.0 | Embeddings de descripciones de productos + consulta de similitud («pgvector u alternativa»), visible en la página de producto o en la principal |
| Control de acceso en un componente NoSQL | 4.0 | Autenticación y autorización explícitas, con «roles y permisos acotados por servicio» y **evidencia de que quien no tiene permiso no puede operar fuera de su alcance** |
| Diagrama de arquitectura final | 3.0 | Todos los componentes de persistencia y sus relaciones; «completo y correcto» |
| Documento de retrospectiva | 4.0 | Qué decisiones se sostendrían, cuáles se replantearían y la justificación en ambos casos |
| Presentación | 4.0 | Claridad + capacidad de sustentar decisiones |

Reglas que siguen valiendo: cada decisión de incorporar o excluir un componente va como ADR (≥ 2 alternativas, una de ellas «no cambiar»); mantener un componente se evalúa con el mismo rigor que migrarlo; hay que indicar la distribución de responsabilidades.

**Audio del catedrático (nota de voz del 2026-10-21, transcripción automática con errores — confirmar lo dudoso el lunes).**

- **Control de acceso.** No basta «tener un rol»: quiere un mecanismo concreto, tipo ACL y configurable por rol, para información como las reseñas o el fraude, de modo que nadie vea lo que no le corresponde *aunque encuentre un bug*; el intermediario es el API. Alguien dijo que el JWT que ya tienen (o la sesión en Redis) puede manejar eso —la transcripción no distingue las voces— y no hubo objeción («Ah, es cierto. Gracias, ingeniero»).
- **Vectorial.** La parte semántica es «sólo para productos similares» y se puede hacer con Elasticsearch; la duda de fondo es «extensión de la base relacional vs. componente vectorial dedicado». Le parecería «bastante chilero» verlo aplicado a **fraude con direcciones**: en Guatemala una dirección se escribe de mil formas, así que se podría convertir el texto en vector y buscar registros parecidos (misma dirección en cuentas distintas, o comprador con la dirección del vendedor); para ese caso mencionó «otras bases de datos vectoriales o una relacional como Postgres», con módulos vectoriales que «funcionan diferente» a un motor de texto. También sugirió **sinónimos en Elasticsearch** (teléfono → celulares).
- **IP.** Como señal de fraude le parece información pública; no hace falta avisar al usuario (en algún país europeo quizá sí).
- **Concepto de recomendación del equipo.** Mostrar lo relacionado con lo que el usuario buscó antes; sin historial o con comportamiento raro, no mostrar nada. Respuesta: «sí, está bien».
- **Fechas.** Examen: **lunes 2 de noviembre**. La fecha de la revisión del proyecto **no está definida**: se decide el **lunes 26 de octubre** con la clase (antes o después del examen; el catedrático sube notas la semana siguiente).

**Cómo lo leemos.** El control de acceso tiene dos lecturas y el plan cubre las dos: (A) autorización a nivel de API por rol, configurable y probada contra bugs (lo que dijo el catedrático), y (B) cuentas de servicio con permisos mínimos en un componente NoSQL (lo que dice el texto del PRD). El ítem vectorial se cumple con «productos similares»; la dirección y la IP son un extra que lo hace memorable.

## 2. Punto de partida (lo que ya existe y se reutiliza)

- **Elasticsearch 8.15** con mapping estricto, sincronización de mejor esfuerzo al crear/editar un producto (`busquedaSyncService`) y `npm run busqueda:backfill`; facetas disyuntivas, autocompletado y tolerancia a tipeos ([PLAN-ELASTICSEARCH-BUSQUEDA.md §15](PLAN-ELASTICSEARCH-BUSQUEDA.md)). Es el sitio natural para colgar vectores sin añadir un séptimo contenedor.
- **Fraude en Neo4j** (siete señales, incluida la autocompra «misma cuenta o misma persona» y el buzón guardado como hash) y **suspensión/vigilancia de cuentas** con candados en Redis.
- **Control de acceso de la aplicación:** JWT con roles comprador/vendedor/administrador, `requireAuth` (que consulta la suspensión en cada petición) y `requireRole`.
- **Degradación elegante** (la app sigue con bases apagadas: `GET /api/health/componentes`, banner, respaldos cruzados Mongo↔Elasticsearch). Todo lo nuevo debe conservarla.
- **Pruebas:** ≈ 240 unitarias sin conexiones (`npm run test:*`) y 13 scripts `verificar:*` contra las bases reales.
- **Datos:** 109 productos activos en 16 subcategorías (~6 por subcategoría). `descripcion` es en realidad un **título corto** (mediana de 21 caracteres, máximo 53) con ~2 atributos por producto: la calidad de los embeddings depende de qué texto se les dé.

**Control de acceso a datos hoy** (`docker-compose.yml`, `backend/src/config/*.js`):

| Base | Autenticación hoy | Puerto publicado |
|---|---|---|
| MySQL 8.4 | usuario y clave por variables (valores por defecto en el compose) | 3306, todas las interfaces |
| MongoDB 7 | **ninguna** (`--replSet rs0 --bind_ip_all`, sin `--auth` ni keyFile) | 27018, todas las interfaces |
| Redis 7 | **ninguna**, sin ACL | 6379, todas las interfaces |
| Cassandra 5.0 | **ninguna** (autenticador por defecto) | 127.0.0.1 |
| Neo4j 5 | una sola cuenta `neo4j` con clave de desarrollo fija | 127.0.0.1 |
| Elasticsearch 8.15 | **ninguna** (`xpack.security.enabled=false`, deliberado hasta esta entrega) | 127.0.0.1 |

## 3. Ítem 1 — Recomendación semántica / búsqueda vectorial (5 pts)

**Qué se gana:** que haya «productos relacionados» por similitud de significado, visibles en la ficha del producto, con embeddings reales y una consulta de similitud, **y** que la decisión del componente esté defendida (el catedrático planteó la duda «extensión de la base relacional vs. componente vectorial dedicado»). Lectura del audio: los 5 puntos salen de «productos similares» bien hechos y bien justificados; el fraude por direcciones y los sinónimos son extras que lo hacen memorable; el historial de búsqueda («lo relacionado con lo que buscó antes») es una capa sobre la misma primitiva.

### 3.1 Línea base medida (sin vectores)

Medida por el agente de investigación en un Elasticsearch 8.15.0 desechable con los títulos reales del catálogo (≈ 106 títulos activos; hoy hay 109 productos activos, así que **las cifras deben repetirse en la prueba previa**):

| Qué se midió | Resultado |
|---|---|
| «Productos parecidos» con BM25 (texto) | 15 productos quedan **sin ningún vecino**; el top-5 acierta la subcategoría en 77,9 % |
| `more_like_this` con sus valores por defecto | **0 de 106** devuelven algo (`min_term_freq=2`, `min_doc_freq=5` no sirven con títulos de ~21 caracteres); ajustado a 1/1: 91 de 106 y 77,6 % |
| 12 consultas coloquiales («celular», «playera», «bici»…) | **10 de 12 dan 0 resultados** |

Esa es la vara que lo vectorial tiene que superar, y la tabla comparativa de la presentación.

### 3.2 Opciones de almacén vectorial para este stack

Horas = persona-horas, estimación del agente. «Probado» = el agente lo ejecutó con las mismas imágenes del proyecto.

| Opción | Cómo encajaría | Veredicto |
|---|---|---|
| **Elasticsearch 8.15 `dense_vector` + kNN** | Campo `embedding` (384 dim, coseno, `int8_hnsw` por defecto) en el índice que ya existe; reutiliza sincronización, circuito, salud y respaldo. kNN **con filtro dentro de la búsqueda** (estado activo, vendedor suspendido, no propio) e híbrido BM25 + kNN por suma de puntajes: probado. **Sin** RRF, ELSER ni `semantic_text` (la licencia Basic responde «non-compliant»: probado) → los vectores se calculan fuera | **Recomendada.** 14–18 h, 0 contenedores nuevos. El catedrático dijo que para lo semántico «pueden utilizar Elastic» |
| `more_like_this` | Una consulta en `busquedaService` | Sólo línea base (2 h) |
| pgvector (PostgreSQL) | Es lo que nombra el PRD: contenedor `pgvector/pgvector`, `config/postgres.js` + circuito + salud, sincronización Mongo→Postgres, `pg` + `pgvector-node`; HNSW/IVFFlat, `<=>` | 12–16 h; **7.º contenedor** y 2.ª copia del catálogo; hay que rehacer los filtros de estado/vendedor. Queda en el ADR con su costo real y como plan B |
| MySQL | 8.4 no tiene tipo `VECTOR`; en 9.x existe el tipo pero `DISTANCE()` es sólo de HeatWave/MySQL AI (ni en Community 9.7) | Descartada: no habría consulta de similitud en la base |
| Cassandra 5.0 | `vector<float,N>` + índice SAI + `ORDER BY … ANN OF`; el driver 4.9 ya soporta el tipo | 10–12 h; su rol es el panel de ventas y ya usa 1,86 de 2 GiB |
| Neo4j 5.26 Community | `CREATE VECTOR INDEX` + `db.index.vector.queryNodes`: probado, funciona | 8–10 h; es copia derivada del *fraude*: acoplaría la vitrina al panel. **Mejor candidato para las direcciones** (§3.7) |
| Redis | `redis:7` es 7.4.11 **sin módulos** (`VADD`/`FT.*` no existen); Redis 8 trae Query Engine pero cambia las categorías ACL y choca con el ítem 2 | Descartada |
| MongoDB | 7 no tiene `$vectorSearch`; 8.2 Community es vista previa con proceso aparte, sólo desarrollo | Descartada |
| Dedicado (Qdrant, Weaviate, Milvus, Chroma, LanceDB) | Herramienta específica; Qdrant, por ejemplo, es Apache-2.0 y sin autenticación por defecto | 12–16 h; 7.º componente y 3.ª copia para ~100 filas; LanceDB (embebido) evita el contenedor pero no muestra operación multi-servicio |
| **No cambiar: coseno en Node** | Vectores guardados en Mongo y similitud exacta en memoria | 0,12 ms con 106×384; 4,8 ms con 10 k; 49 ms con 100 k; 283 ms con 500 k (medido). Deja de servir hacia ~100 k productos o con varios procesos/filtros. **Descartada también como respaldo** (decisión del 2026-10-23, ver §3.4b): obligaría a guardar los vectores en Mongo y a mantener una segunda implementación de la similitud |

### 3.3 Modelo de embeddings (local, sin claves de pago)

| Modelo | Dimensión · descarga · licencia | Notas |
|---|---|---|
| **`multilingual-e5-small`** (ONNX int8) — por defecto | 384 · 118 MB · MIT | ~100 idiomas; prefijo `query: ` obligatorio (también en el lado del documento para similitud simétrica) |
| `paraphrase-multilingual-MiniLM-L12-v2` | 384 · 118 MB · Apache-2.0 | 50 idiomas; alternativa a comparar |
| `bge-m3` / `embeddinggemma-300m` (Ollama) | 1024 · 1,2 GB / 768 · 622 MB | Excesivos para títulos de 21 caracteres |
| OpenAI, Voyage, etc. | — | Descartados: exigen internet y clave (rompen la demo sin conexión) y las direcciones son datos personales. Anthropic no ofrece embeddings propios |

Con `@huggingface/transformers` (Node ≥ 20; el backend es CommonJS → `await import(...)`); sin internet con `env.allowRemoteModels = false` y `env.localModelPath`. El archivo de 118 MB supera el límite de 100 MB de GitHub → `.gitignore` + script de descarga + copiar la caché antes de la demo, **Como los vectores viven solo en Elasticsearch, reconstruir el índice exige tener el modelo instalado** (`busqueda:backfill` recalcula cada vector): la caché del modelo va en una carpeta fija y se comprueba antes de la demo. Un JSON versionado con los vectores (~400 KB) es solo un plan de contingencia si el modelo resulta frágil en Windows. **No medido todavía:** latencia en CPU (estimación 5–20 ms por título, carga 1–3 s, +300–400 MB de RAM) y calidad con títulos cortos. Regla de decisión para la prueba previa: el modelo más chico con precisión@5 ≥ 90 % sobre los títulos y 0 productos sin vecino. La descarga y la instalación necesitan autorización del equipo.

### 3.4 Decisión recomendada — cuerpo propuesto del ADR-006

> **ADR-006 — Recomendación semántica por vectores** (`IA/ADR-006-recomendacion-semantica-vectorial.md`)
>
> **Contexto.** El PRD pide embeddings de descripciones y consulta de similitud. El catálogo tiene ~109 productos activos en 16 subcategorías; `descripcion` es un título (mediana de 21 caracteres). Medido: BM25 deja 15 productos sin vecino y acierta la subcategoría en 77,9 % del top-5; `more_like_this` por defecto devuelve 0/106; 10 de 12 consultas coloquiales dan 0 resultados. Restricciones: demo sin internet ni claves, 15,6 GB de RAM (1,4 GB libres), seis componentes ya en marcha, degradación elegante obligatoria, 2–3 personas.
>
> **Alternativas.** (1) No cambiar: atributos/BM25/`more_like_this`, o coseno en memoria. (2) Extensión relacional: pgvector (añade PostgreSQL) o MySQL (8.4 sin `VECTOR`; `DISTANCE()` fuera de Community aun en 9.7). (3) Componente dedicado (Qdrant, Weaviate, Milvus, Chroma, LanceDB). (4) Motor de búsqueda existente: Elasticsearch `dense_vector` + kNN. (5) Otros ya presentes: Cassandra 5 (SAI), Neo4j (índice vectorial), Redis (sin módulos en 7), MongoDB (sin `$vectorSearch` en 7).
>
> **Decisión.** (4): campo `embedding` (384 dim, coseno, `int8_hnsw`) con vectores de `multilingual-e5-small` (ONNX int8) calculados localmente en Node. **Los vectores se guardan solo en Elasticsearch**, junto al documento del producto; Mongo no los copia. El documento de búsqueda sigue siendo una copia derivada del catálogo y se reconstruye con `busqueda:backfill`, que recalcula cada vector desde el texto del producto. Respaldo: si Elasticsearch no responde, los relacionados salen de la misma subcategoría (Mongo); si ambos caen, la sección se oculta.
>
> **Justificación.** *Consistencia:* el vector es un dato derivado (texto del producto + modelo) que se recalcula en segundos, así que no necesita una segunda copia en la base fuente: el catálogo de Mongo no cambia y no hay dos implementaciones de la similitud que mantener. Reindexar recalcula el vector o, si el modelo no está, actualiza el documento sin tocarlo (un `index` completo lo borraría: comprobado). *Patrón de consulta:* kNN con filtros de estado y vendedor suspendido dentro de la búsqueda e híbrido BM25 + kNN (verificados). *Escalabilidad:* HNSW; de ~100 a 100 k productos sin cambiar la API. *Costo operativo:* 0 contenedores nuevos frente a +1 con pgvector o un dedicado; salud, circuito y banner ya existen. *Licencia:* en Basic no hay RRF, ELSER ni `semantic_text` (verificado), por eso los vectores se calculan fuera.
>
> **Consecuencias.** (+) Funciona sin conexión; Mongo no cambia; los relacionados siguen aunque Mongo esté apagado (todo sale del índice). (−) El modelo (118 MB) vive fuera del repo y reconstruir el índice exige tenerlo; cambiar de modelo obliga a reindexar; si Elasticsearch cae, los relacionados pasan de «por significado» a «de la misma subcategoría»; hay que excluir el vector de `_source` en las demás consultas (con él pesan 13 veces más: comprobado); `dynamic: 'strict'` exige mantener mapping y prueba alineados; Elasticsearch opera casi en su límite de memoria (961 MiB de 1 GiB). Se reabre si el catálogo supera ~100 k productos, aparecen filtros relacionales complejos o varios servicios consumen vectores (→ pgvector o Qdrant).

### 3.4b Verificación: ¿vectores solo en Elasticsearch? (2026-10-23)

El equipo decidió **no guardar una copia de los vectores en Mongo**. Antes de construirlo se comprobó contra el Elasticsearch 8.15.0 real, con un índice temporal que usa el mapping real de `tiendaya_productos` y sus 121 documentos (vectores sintéticos de 384 dimensiones; se borró al terminar):

| Qué se comprobó | Resultado |
|---|---|
| Agregar `dense_vector` con `putMapping` a un índice que ya existe y es `dynamic: strict` | Funciona. El tipo por defecto es `int8_hnsw` (m 16, ef_construction 100). Los documentos que ya estaban quedan sin vector hasta correr el backfill |
| Leer el vector de un producto por id (`GET` con `_source_includes`) | 384 valores en 9–24 ms: «relacionados» son dos consultas baratas (leer el vector, kNN) |
| kNN con filtro (activo, sin el propio producto, sin vendedores suspendidos), ordenado por similitud | Correcto; `_score` = (1 + coseno) / 2 |
| Umbral mínimo de similitud dentro del propio kNN (`similarity`) | Descarta lo que queda por debajo: «mejor nada que algo sin relación» se resuelve en la consulta, sin filtrar después |
| Un documento sin vector | No rompe nada: no aparece en kNN, y su vector se lee como «ausente» (se cae a la misma subcategoría) |
| **`index` completo de un producto sin recalcular el vector** | **Lo borra.** Es justo lo que hace `indexarProducto` hoy en cada edición. Solución: recalcular siempre y, si el modelo no está, un `update` parcial con `doc_as_upsert` sin ese campo: conserva el vector, reemplaza `atributos` entero y deja bien `sugerencia` y `contexts.estado` |
| **Una búsqueda normal con el vector dentro de `_source`** | 509 KB frente a 37 KB para 60 productos (13 veces): hay que poner `_source.excludes: ['embedding']` en las consultas actuales |
| Tamaño en disco | ~1,3 MB para 122 documentos con vector |

**Un argumento que se descartó:** «los vectores inflarían el historial de eventos». No es cierto: los *snapshots* de `producto_eventos` se arman con campos explícitos (descripción, estado, atributos, imágenes, inventario), así que un campo nuevo en el documento no entra. La decisión se sostiene por otras razones: el vector es un dato derivado que se recalcula, no hace falta una segunda copia ni una segunda implementación de la similitud, y el catálogo de Mongo no cambia.

**Lo que se pierde:** el respaldo de coseno en memoria (con Elasticsearch caído, los relacionados pasan de «por significado» a «de la misma subcategoría», lo que sigue cumpliendo el requisito de que la aplicación funcione con una base apagada, solo que sin esos datos) y reconstruir el índice exige el modelo instalado. Recalcular ~109 títulos se estima en 1–2 s (no medido: se mide en la prueba previa). A cambio, los relacionados **siguen funcionando con Mongo apagado**, porque todo sale del índice.

**Veredicto: buena decisión para este proyecto, con tres reglas.** (1) Nunca reindexar un producto sin recalcular su vector ni con un `index` completo que lo omita. (2) Excluir `embedding` de `_source` en todo lo demás. (3) El modelo y su caché son parte de la preparación de la demo, con una comprobación previa. Se reabre si la prueba previa muestra que el modelo no es confiable en Windows (entonces, el JSON de contingencia) o si el catálogo crece tanto que recalcular todo deje de ser cuestión de segundos.

### 3.5 Diseño

- **Texto a embeber.** A: `query: {título}` · B: `query: {título}. {subcategoría}. {categoría}. {Atributo: valor; …}` · C: B + `descripcion_larga`. Con 21 caracteres de mediana, **B es el mínimo**; C (106–109 textos de 1–2 frases generados una vez con un LLM y **declarados sintéticos**, ~2 h + ~5 h de campo, formulario y mapping) alinea con el PRD, que dice «descripción» y hoy es un título. **Fuga de etiqueta:** si B incluye la subcategoría, «misma subcategoría» sube por construcción: medir la calidad semántica con A y con juicio humano para B y C.
- **Sincronización.** El vector se guarda en el documento de Elasticsearch (`embedding`), no en Mongo. `indexarProducto` lo recalcula del texto (título + subcategoría + categoría + atributos) en cada alta o edición y lo indexa junto al resto; si el modelo no está disponible hace un `update` parcial (`doc_as_upsert`) SIN ese campo, para no borrar el vector anterior —un `index` completo lo borra: comprobado— y lo avisa una vez. `backfillBusqueda` recalcula todo (109 títulos: segundos). Las demás consultas excluyen `embedding` de `_source`. `aDocumento`, `MAPPING` y su prueba cambian juntos (`dynamic: 'strict'`), y el campo se agrega con `putMapping` al índice que ya existe (comprobado). Cambiar de modelo = reindexar.
- **Consulta y reglas de negocio** (`GET /api/productos/:id/relacionados`): sólo `estado: activo`; excluir vendedores suspendidos (`vendedoresSuspendidos()`), lo propio (patrón de `tendenciaService`) y el mismo producto; sin stock al final; máximo 2 por vendedor y deduplicar casi idénticos; umbral τ calibrado con la evaluación y **≥ 2 resultados o se oculta** («mejor nada que algo sin relación», audio 08:30); explicación «Parecido a …» / «Misma subcategoría: Celulares». Referentes: Shopify separa «relacionados» (sustitutos) de «complementarios» y permite ocultar por producto; Airbnb usa embeddings de anuncios para similares; Zalando resuelve el arranque en frío; MMR para diversidad.
- **Degradación** (conserva lo ya construido): Elasticsearch kNN → misma subcategoría (Mongo) → ocultar. La respuesta lleva `modo` (como `busqueda` con `modo: 'basico'`), la página lo carga aparte (como `ofertasApi.consultarStock`) y `AvisoServicios` avisa.

### 3.6 Evaluación (lo que se muestra al jurado)

1. Etiqueta automática = las 16 subcategorías: precisión@5, Hit@5, MRR y cobertura (sin productos huérfanos). 2. 20–30 productos con 5 resultados juzgados por 2 personas (nDCG@5). 3. 12–15 consultas coloquiales. 4. La misma tabla para BM25 y `more_like_this`. 5. Latencia p50/p95. Debe ganar donde el léxico falla: «celular»≈«Smartphone», «tenis»≈«Zapato deportivo»; fallos léxicos reales vistos por el agente: «Tenis urbano»→«Bicicleta urbana», «Short deportivo»→«Sandalia deportiva». **No se prometen cifras de embeddings antes de medir.**

### 3.7 Extras con valor (en orden de costo/beneficio)

| Extra | Qué es | Horas | Nota |
|---|---|---|---|
| **Sinónimos en Elasticsearch** | `PUT _synonyms/…` + filtro `synonym_graph` actualizable (probado: con 9 reglas, 11 de 12 consultas coloquiales resuelven; una regla nueva actúa al instante, sin reindexar); vocabulario local: playera = camiseta, chumpa = chaqueta | ~3 | Lo sugirió el catedrático. La primera vez hay que recrear el índice (`analysis` es estático; es copia derivada: borrar + `busqueda:backfill`) |
| Respaldo semántico para «0 resultados» | Si BM25 no encuentra nada («celualr», que los sinónimos no arreglan), consultar kNN con el vector de la consulta | ~3 | Idea inesperada pero barata |
| **Historial de búsqueda** («lo relacionado con lo que buscó antes») | **Ya hay una versión simple**, hecha por Jose (`2eee964`, `4241955`; [PLAN-ELASTICSEARCH-BUSQUEDA.md §16](PLAN-ELASTICSEARCH-BUSQUEDA.md)): Redis `actividad:{uid}` (5 entradas, 30 días: búsquedas que sí funcionaron y productos activos vistos) y, cuando un texto no encuentra nada, `sugeridos` (última actividad → historial de compras → más vendidos). **Falta respecto al diseño:** usar los vectores ya guardados (hoy repite la búsqueda por texto), una franja «Porque buscaste «camiseta de algodón»» fuera del caso «sin resultados» y «Borrar historial» | 2–3 (lo que falta) | Es el concepto del equipo, aprobado en el audio; el catedrático dijo que a quien no tenga historial no se le muestre nada y hoy la última capa muestra los más vendidos (confirmar) |
| `descripcion_larga` | Ver §3.5 (variante C) | ~7 | Declarar los textos como sintéticos |
| **Señal de fraude por direcciones** | Ver abajo | 10–14 | Idea del catedrático («bastante chilero») |

**Direcciones y fraude (la idea del catedrático).** El equipo ya tuvo una señal por dirección (nodos `Direccion`, comparación exacta tras normalizar) y la quitó el 4/10 (PLAN-NEO4J §16): se reabre con evidencia. Hallazgos del agente: (1) en la base de desarrollo hay 59 direcciones con sólo 10 textos distintos y ~45 cuentas con «Calle de prueba 1-23»: una señal ingenua marcaría un «anillo» de 45 cuentas → **limpiar o excluir cuentas de prueba**; (2) **los embeddings son malos con números** («12-34» vs «12-43», «zona 10» vs «11»): la receta es **híbrida** — normalizador guatemalteco determinista (av/ave/avenida, calle, zona/z/zn, 5a/5ta/quinta, km, residencial, apto…, ~150 líneas) → extraer números (vía, casa, zona) → candidatos por embedding o trigramas → verificación: los números deben coincidir (exacta = fuerte; difusa con números iguales = media; difusa sin números = descartar); libpostal (MIT) es demasiado pesado (~1,8 GB); (3) evaluación sintética: ~30 direcciones base × 4–5 variantes (abreviaturas, ordinales en letra, orden, ruido, tipeos) como positivos y «misma calle, otra casa» / «mismo número, otra zona» como negativos, comparando F1 de coincidencia exacta, Jaccard de tokens, Jaro-Winkler/Levenshtein, trigramas, embedding e híbrido; (4) la señal nueva «H» en `fraudeService` (envío ≈ dirección registrada del vendedor del producto; dos compradores a direcciones parecidas del mismo vendedor) empieza en «posible» y sube a «alta» sólo con corroboración, como el resto de señales; (5) vectores en un índice aparte de Elasticsearch (`tiendaya_direcciones`, protegido por el rol de fraude del ítem 2) o en Neo4j (`(:Direccion)-[:PARECIDA_A]->`, índice vectorial probado); con ≤ 100 k direcciones basta el coseno exacto; (6) **privacidad:** el vector de una dirección es dato personal (la inversión de embeddings recupera ~92 % de textos cortos, Morris et al., EMNLP 2023): sólo accesible por el servicio de fraude y el administrador, y se borra al borrar la dirección.

**La IP (comentario del catedrático).** Enlaza cuentas, contrasta país/zona con el envío y marca VPN/Tor; Stripe Radar la usa junto con contadores por hora y día. Falsos positivos: CGNAT móvil, redes de universidad (la propia demo: todos comparten IP), hogares; en desarrollo todo llega desde `::1` y tras un proxy hace falta `trust proxy`. «Es pública» no exime de minimizar (el TJUE, caso Breyer, trata la IP dinámica como dato personal si se puede combinar con datos del proveedor). **Recomendación: no como señal independiente;** sólo corroborador y campo de auditoría (hash HMAC o /24, 90 días).

### 3.8 Plan de trabajo

**MVP ≈ 20–24 h (más 2–3 h de prueba previa); asegura los 5 pts.**

| # | Paso | Horas | Archivos |
|---|---|---|---|
| 0 | ✅ **Prueba previa** — hecha el 2026-10-25, con autorización del equipo para descargar el modelo (paquete + `onnxruntime-node` ≈ 300 MB; modelo 112,8 MiB + tokenizador 16,3 MiB) | 2–3 | fuera del repo; resultados en el ADR-006 §3.1 y §4 |
| 1 | ✅ `embeddingService`: carga perezosa, solo local, prefijo `query: ` siempre, lotes de 16, un cálculo a la vez, error claro si falta el modelo, sin reintentar en cada edición; manifiesto con revisión fija y SHA-256 y `npm run modelo:descargar` / `modelo:verificar` | 3 | `backend/src/services/embeddingService.js`, `config/embeddingsModelo.js`, `scripts/descargarModelo.js` |
| 2 | ✅ Datos: `MAPPING` + `aDocumento` + prueba de alineación (campo `embedding`), `indexarProducto` con recálculo y `update` parcial si falta el modelo, `_source.excludes` en las consultas, backfill que recalcula y se detiene si falta el modelo (121 productos, 5 s) | 4–5 | `config/elasticsearch.js`, `busquedaSyncService.js`, `busquedaService.js`, `tests/busquedaMapping.test.js`, `scripts/backfillBusqueda.js` |
| 3 | ✅ Consulta: `similares()`, `relacionados()` con sus tres capas en `catalogoLecturaService`, reglas puras (`reglasRelacionados.js`), ruta `GET /:id/relacionados` declarada en la lista blanca, 66 pruebas con dobles | 4–5 | `busquedaService.js`, `catalogoLecturaService.js`, `reglasRelacionados.js`, `routes/productoRoutes.js`, `config/politicaRutas.js`, `tests/similares*.test.js` |
| 4 | ✅ UI: «Productos relacionados» en la ficha (con la leyenda del modo) + aviso global actualizado | 3 | `frontend/src/components/product/ProductosRelacionados.jsx`, `pages/ProductDetailPage.jsx`, `api/productos.js`, `layout/AvisoServicios.jsx` |
| 5 | ✅ Evaluación + ADR-006 (**falta** el flujo en el diagrama, que es del ítem 3) | 4 | `scripts/verificarSimilares.js` (`npm run verificar:similares`), `IA/ADR-006-…md` |

### 3.9 Resultado (2026-10-25)

Medido contra el catálogo real (106 productos, 16 subcategorías); detalle, tablas y límites en el [ADR-006](ADR-006-recomendacion-semantica-vectorial.md):

| Qué | Resultado |
|---|---|
| Windows + ONNX | Funciona. Carga ≈ 0,8–0,9 s; ≈ 500 MB residentes con el modelo cargado; 2,5–3,8 ms por título |
| Precisión@5 / Hit@5 / MRR (etiqueta = subcategoría) | **91,2 %** / 100 % / 0,959 (BM25: 71,1 %; con solo el título: 64,7 %) |
| Productos con ≥ 2 parecidos por significado | 102 de 106; los otros 4, por subcategoría → **0 sin sección** (BM25: 15 sin vecino; `more_like_this` por defecto: 0 de 106 devuelven algo) |
| Consultas coloquiales (≥ 4 de 5 correctos) | texto 0 de 14 · vectores 6 de 14; la jerga regional («playera», «compu», «pelota», «tenis») no se resuelve → sinónimos |
| Latencia de `similares()` | p50 9 ms · p95 13 ms |
| Degradación en vivo | Elasticsearch apagado → «misma subcategoría» (8–19 ms); solo Mongo apagado → sigue por significado; ambos → 503 |

**Cambios respecto al diseño del §3.5:** el tope «2 por vendedor» pasó a «a lo sumo la mitad de la lista» (con dos vendedores reales y tres productos parecidos de cada uno, el tope fijo recortaba aciertos); el umbral quedó en **0,90** y no en el 0,88 que dio la prueba previa (0,90 es el punto en que un vecino pasa a ser más probablemente de la misma subcategoría que de otra: 51 % contra 27 %) y los 4 productos que así quedan sin 2 vecinos usan la subcategoría; el texto incrustado es título + subcategoría + categoría (sin atributos: no se midió que aportaran). **Pendiente del plan:** el juicio de dos personas sobre 20–30 productos (nDCG@5), que el informe deja listo como muestra.

**Ideal (+25–35 h):** sinónimos (3) → historial y franja en la portada (6–8) → `descripcion_larga` (7) → señal por direcciones (10–14) → respaldo semántico para 0 resultados (3).

**Evidencia a mostrar.** Apagar `tiendaya-elasticsearch` en vivo: los relacionados siguen (modo `respaldo`) y el banner avisa; apagar también Mongo: la sección desaparece sin romper la página. La tabla BM25 vs kNN con las 12 consultas coloquiales. La salida de `verificar:similares`. La consulta kNN con sus filtros. El ADR.

**Riesgos.** *onnxruntime pesado o fallos en Windows* → se prueba en la prueba previa; contingencia: un JSON con los vectores si el modelo resulta frágil; productos sin vector → respaldo por subcategoría. *Calidad baja con títulos* → variantes B/C, MiniLM, umbral; resultado honesto en el ADR. *Elasticsearch al límite de memoria y host con 1,4 GB libres* → medir antes de subir `mem_limit`; no sumar contenedores. *Fuga de etiqueta y señal por direcciones con datos de prueba* → excluir cuentas y direcciones de prueba; sólo corroborador.

**Fuera de alcance.** Reranker/cross-encoder, imágenes (CLIP), *fine-tuning*, RRF/ELSER/`semantic_text`, «complementarios», pruebas A/B en línea, embeddings por tecla del autocompletado, Redis 8, pgvector o Qdrant (salvo plan B).

## 4. Ítem 2 — Control de acceso en componentes NoSQL (4 pts)

**Qué se gana:** autenticación y autorización explícitas en al menos un componente NoSQL, con permisos acotados por servicio, y **evidencia de que quien no tiene permiso no puede operar fuera de su alcance**. El audio pide algo más cercano a la aplicación: un mecanismo concreto, tipo ACL por rol, para reseñas y fraude, de modo que «si encuentro un bug no pueda ver más». Por eso el plan tiene **dos capas** que se refuerzan: (1) autorización en la API, probada contra bugs reales, y (2) cuentas de servicio con permisos mínimos en los componentes NoSQL.

### 4.0 Principio de diseño: lista blanca (negar por defecto)

**Una sola regla para todas las capas:** se parte de «nada permitido» y se anota lo que sí; lo que no está en la lista se **niega**. Una lista negra («todo permitido salvo…») falla abierta: lo que se olvida anotar queda permitido. Así nacieron los huecos de §4.1 (una ruta sin ningún chequeo estaba abierta para todos). Las reglas de negar existen, pero solo como red de seguridad o excepción, nunca como base.

| Capa | Lista blanca (lo que se permite) | Red de seguridad o excepción |
|---|---|---|
| **API, por ruta** (mínimo, §4.4 paso 1b) | `config/politicaRutas.js` declara **cada** ruta con su acceso (pública, sesión opcional, sesión, roles, dueño). Una prueba recorre el router real y **falla** si hay una ruta sin declarar (una ruta nueva sin chequeo no pasa), si el acceso declarado no coincide con el middleware que de verdad tiene, o si una ruta «pública» lleva un chequeo que la contradice | Cuentas suspendidas (`bloqueo:*`) y límites suaves (`restriccion:*`): la lista negra por usuario que ya existe |
| **API, política configurable** (ideal, paso 6) | `acl_regla`: pasa solo si coincide una regla `permitir` (rol, recurso, acción, alcance `propios`) | Una regla `negar` explícita gana sobre cualquier `permitir`; sin regla, negado |
| **Cuentas de Redis** | `-@all` + `+comando` + patrón de llaves por cuenta (`%R~` / `%W~` separan lectura y escritura); `resetchannels` (sin Pub/Sub); el usuario `default` apagado | Sin `@dangerous`; sin `SCAN` salvo a quien deba listar |
| **Cuentas de Mongo, Elasticsearch y Cassandra** | Roles con privilegios explícitos por colección, índice o keyspace (en Mongo los roles solo permiten: no existe «negar») | — |
| **Red** (ideal) | Puertos de las bases solo en `127.0.0.1` | — |

**Fuera de este principio:** listas por usuario individual («este vendedor sí puede X»: los permisos son por rol) y listas de IP para clientes (la IP solo sería una señal opcional de fraude).

**La matriz es la lista blanca y se prueba por los dos lados.** `verificar:acceso` (paso 5) no solo comprueba lo permitido: intenta también lo que **no** está en la lista (otro prefijo de llaves, `FLUSHALL`, `KEYS *`, un comando de otra cuenta) y exige `NOPERM`.

### 4.1 Capa 1 — Autorización en la API: huecos reales (verificados en el código)

El agente auditó `routes/*` y `services/*` (OWASP API Top 10 2023); yo comprobé en el código los cuatro primeros:

| # | Hueco | Qué pasa hoy | Arreglo |
|---|---|---|---|
| 1 | **`GET /api/productos/:id/historial`** (API1, BOLA) | Exige rol vendedor/administrador pero **no que el producto sea suyo** (`productoRoutes.js`: sólo `requireRole`; el servicio no comprueba dueño, a diferencia de `actualizar`, que sí llama a `verificarPermiso`). Cualquier vendedor lee el historial de precios y stock de productos ajenos | `verificarPermiso` (dueño o administrador) |
| 2 | **`GET /api/productos/:id/resenas`** (API3) | Público y devuelve `usuario_id` y el **nombre completo** del autor (`resenaService.listarPorProducto`). Las reseñas son justo el ejemplo que dio el catedrático | Alias tipo «Ana G.» sin id; identidad completa sólo para administrador y autor |
| 3 | **`GET /api/productos/estadisticas/ediciones`** (API5) | Sin autenticación (ni `requireAuth` ni `requireRole`) | Política: administrador (o dueño de lo suyo) |
| 4 | **`GET /api/health/componentes`** (API8) | Público; el campo `error` es la primera línea del mensaje del driver (hasta 160 caracteres: puede incluir host, puerto o usuario) | Público sólo el estado `ok`; el detalle, sólo administrador |
| 5 | `POST /api/categorias*` abierto a todo vendedor | Es una decisión de diseño documentada (un vendedor crea categorías al publicar), pero la taxonomía no se puede editar ni borrar | Revisar con el equipo: ¿sólo administrador? |
| 6 | Sin límite de intentos en login/registro (API4) | Según el agente (no verificado por mí) | Reutilizar `reservarCupo` de Redis |

**Corregidos 1–4 el 2026-10-23** (primer paso del plan). Historial: `verificarPermiso` (dueño o administrador; MySQL es la autoridad del dueño, como al editar) y un id inválido ya no llega a MySQL; la pantalla solo ofrece el historial al dueño y al administrador. Reseñas: la lista pública devuelve el autor como alias («Ana G.») y sin id de cuenta, para cualquier rol. Estadísticas de ediciones: solo administrador (el panel administrativo ahora manda su token). Salud: `routes/saludRoutes.js`; público solo `ok` por base, y con token de administrador también los milisegundos y el texto del error. 14 pruebas HTTP con el middleware real (`npm run test:acceso`, la matriz rol × endpoint), cada una verificada deshaciendo su arreglo, y comprobación en vivo con cuentas reales de comprador, vendedor dueño, otro vendedor y administrador. Quedan el 5 (¿categorías solo del administrador?) y el 6 (límite de intentos de login), que son decisiones aparte.

**Lista blanca de la API hecha el 2026-10-23 (paso 1b, §4.0).** `src/config/politicaRutas.js` declara las **53 rutas** del backend con su acceso (8 públicas, 4 con sesión opcional, 24 con sesión, 17 por roles; 8 comprueban además el dueño del recurso). `tests/accesoRutas.test.js` carga el `app.js` real, recorre su router (en el orden en que Express lo ejecuta, con los `router.use(requireAuth)` heredados) y falla si una ruta no está declarada, si la declarada ya no existe, o si el acceso real —leído de las etiquetas de `requireAuth`, `requireRole` y `optionalAuth`— no es el declarado. Después prueba por HTTP, con los manejadores reales reemplazados por un centinela para no tocar ninguna base: todas las rutas con sesión responden 401 sin token y con un token inválido, y **cada rol que no figura en la lista de una ruta recibe 403** (la matriz rol × endpoint completa, 17 rutas × los roles excluidos). 6 pruebas; 15 mutaciones (quitar un filtro, abrir un rol, una ruta nueva sin declarar, una entrada fantasma, un filtro falso que copia la etiqueta pero no hace nada, un `requireRole` o `requireAuth` roto) detectadas, y 274 de 274 pruebas del backend en verde. Una ruta nueva sin declarar ya no pasa la suite.

Bien hecho hoy: pedidos, direcciones, métodos de pago e intentos de checkout filtran por dueño; `/api/admin/*` siempre con `requireRole('administrador')`; `?vendedorId` nunca se confía. **Arreglar 1–4 es el control de acceso más barato y más defendible**: es exactamente «encontré un bug y veo de más», y la demo es directa (vendedor A lee el historial de B: hoy 200, después 403).

**Mecanismo configurable (lo que describió el catedrático).** Tabla MySQL `acl_regla(rol, recurso, accion, efecto, alcance)` sembrada con lo que hoy hace `requireRole`; `politicaAccesoService` con caché de 5 s y clave `acl:version` en Redis para invalidar (si Redis cae: última copia en memoria o política compilada; negar por defecto); middleware `autorizar(recurso, accion, {propios})` en lugar de `requireRole`; 403 uniforme `{codigo: 'ACL_DENEGADO'}`; cada negación se registra en una colección de Mongo `auditoria_acceso` cuyo usuario sólo puede insertar; pantalla `/admin/permisos` (el administrador no puede quitarse `permisos:editar`). Demo: se crea un rol `auditor` y el administrador le concede `fraude:ver`: funciona en segundos. **Bibliotecas reales comparadas** — Casbin (Apache, RBAC/ABAC, `node-casbin`), CASL (reglas JSON, integra con Mongoose), OPA (CNCF, servidor Rego), OpenFGA (Zanzibar, servidor + base), Keycloak Authorization Services (exige Keycloak): para tres roles son proporcionadas **la tabla propia (~150 líneas, editable en la UI)** o, si se quieren condiciones por campo, CASL; OPA, OpenFGA y Keycloak son otro servicio para tres roles y se descartan. *Nota de alcance:* el catedrático aceptó que el JWT/los roles que ya existen pueden manejar esto, así que **arreglar los huecos + una política declarada y probada es el mínimo**; la pantalla de permisos es el «ideal» (se pregunta el lunes, §10).

### 4.2 Capa 2 — Cuentas de servicio en los componentes NoSQL

**Estado de partida** (verificado en `docker-compose.yml`): Redis, Mongo, Cassandra y Elasticsearch sin autenticación; Neo4j con una sola cuenta; MySQL, Mongo y Redis publicados en todas las interfaces. Probado por el agente con las mismas imágenes (contenedores desechables, ya eliminados):

| Componente | Cómo se activa | Prueba negativa · horas · riesgo |
|---|---|---|
| **Redis 7.4.11** | `aclfile` generado al arrancar desde `.env` + `user default off`; `ioredis` acepta usuario y clave; conexión por módulo en `config/redis.js`. **Trampas probadas:** `redis.call('TIME')` dentro de los Lua exige `+time`; `SCAN` ignora los patrones de llaves (darlo sólo a quien deba listar) | `NOPERM`, `NOAUTH`/`WRONGPASS`, `ACL LOG` (razón, contexto, objeto, usuario) y `ACL DRYRUN` · 4–6 h · bajo-medio |
| **MongoDB 7.0.40** | `--keyFile` activa la autenticación; rol propio por servicio. **Trampa probada:** el keyFile desde un *bind mount* de Windows falla («permissions too open») → receta con copia + `chmod 400` + `chown`, validada con volumen nuevo **y con el volumen ya inicializado** (la *localhost exception* permite crear el primer usuario; los datos quedan intactos). Healthcheck con credenciales del entorno; `MONGO_URI` con usuario y `authSource` | `producto_eventos` sólo `find` + `insert`: el *append-only* de ADR-003 pasa de convención a **garantía de la base**; actualizar o borrar un evento → «not authorized» · 6–8 h · medio |
| Elasticsearch 8.15 Basic | `xpack.security.enabled=true` + `ELASTIC_PASSWORD`; en desarrollo `xpack.security.http.ssl.enabled=false`. Usuarios, roles y API keys funcionan en Basic; seguridad por documento/campo (DLS/FLS) es de pago | 403 `security_exception` con el privilegio faltante · 5–6 h · medio |
| Cassandra 5.0.9 | `PasswordAuthenticator` + `CassandraAuthorizer` en `cassandra.yaml` (la imagen **no** lo permite por variable: `sed` en el `command` o un yaml montado); `PlainTextAuthProvider` en el driver | `Unauthorized` con un rol de sólo SELECT (no probado) · 5–6 h · medio-alto (ya usa 1,86 de 2 GiB) |
| Neo4j 5.26 Community | `CREATE USER` sí; **`CREATE ROLE`/`GRANT` → «Unsupported administration command»** y un usuario sin roles pudo escribir (probado): sólo autenticación | Autorización fina = Enterprise: se documenta como límite honesto (retrospectiva) · 1 h |
| MySQL 8.4 (no NoSQL, barato) | `GRANT` mínimos por rol; `docker/mysql-init` sólo corre con volumen vacío | 2 h |

**Hecho el 2026-10-23: Redis y MongoDB (pasos 2 a 5).** Diseño, hallazgos y evidencia en [ADR-007](ADR-007-control-de-acceso.md); cómo usarlo, en el README («Control de acceso»). Lo que cambió respecto de lo planeado:

- **Redis: nueve cuentas, no cuatro.** Leyendo el código servicio por servicio, la cuenta `rd_ofertas` se partió: `rd_cupos` (`limite:pedidos:*`, `reauth:intentos:*`), `rd_recomendaciones` (`recomendaciones:*` y `oferta-recomendada:*`, una familia que la matriz derivada antes no tenía) y `rd_salud` (solo `PING`). Los candados se separan en lectura (`rd_candados_r`) y escritura (`rd_candados_w`): la revisión de sesión no puede levantar una suspensión. Cada familia de llaves se escribe desde una sola cuenta, y una prueba estática exige que cada servicio que usa Redis figure en la cuenta con la que entra.
- **El archivo de ACL no admite comentarios** y las contraseñas van como hash SHA-256; ioredis 6 pregunta `INFO` y `CLIENT SETINFO` al conectar y hubo que desactivarlos para una cuenta mínima; `SCAN` lista las llaves de todas las familias (solo `rd_candados_r` lo tiene).
- **El `healthcheck` de Redis no lleva contraseña:** con `default` apagado, un `PING` sin credenciales responde `NOAUTH`, y eso basta para saber que está vivo.
- **Mongo: dos cuentas** (`mg_app` con el rol `app_tiendaya`, y `mg_admin`), no tres: `tiendaya_lectura` no tenía quién la usara. El servidor web no puede borrar nada en Mongo, y `producto_eventos` solo admite `find` e `insert` (más las acciones de esquema de Mongoose). Los scripts que necesitan borrar piden `conectar('admin')`.
- **El `healthcheck` de Mongo** ya no usa `rs.status()` (pide credenciales): mira `hello`, que no las pide, e inicia el replica set solo si el volumen es nuevo. La salud de la API hace además una lectura con la cuenta de la aplicación, porque `ping` no pide autenticación y decía «ok» con el catálogo respondiendo 500.
- **Errores de credencial (§4.3):** implementados para Redis y Mongo (`CredencialRechazada`, `esErrorDeAcceso`, cerrojo con reintento a los 30 s, 500 `CREDENCIAL_RECHAZADA` sin detalle, fallo cerrado de la suspensión, los límites suaves, el tope por hora y los intentos de contraseña). Comprobados con fallas provocadas en vivo.
- **Evidencia:** `npm run verificar:acceso` (88 comprobaciones contra los contenedores reales), `npm run test:acceso`, 62 mutaciones de las protecciones detectadas, `ACL LOG` vacío tras los flujos reales.
- **Puertos:** Redis y Mongo ahora solo en `127.0.0.1`. Quedan MySQL (`3306`) y las demás bases del «ideal».

**Recomendación.** *Mínimo viable:* **Redis + MongoDB** con cuentas por servicio, la capa 1 con los huecos 1–4 arreglados y la política probada, pruebas negativas automatizadas y la demo en vivo. *Piso si falta tiempo (≈ 17–20 h):* Redis ACL + huecos de API + lista blanca de rutas + pruebas + `verificar:acceso` (Mongo pasa a *stretch*: sigue cumpliendo «al menos un componente NoSQL»). *Ideal:* + Elasticsearch, Cassandra, Neo4j autenticado, MySQL mínimo, puertos a `127.0.0.1` y secretos fuera del repo.

**Matriz servicio × recurso × acción** (derivada de `src/**` y `scripts/**`; es la **lista blanca** de §4.0 —cada fila dice qué se permite y todo lo demás se niega— y también la lista de pruebas negativas):

| Servicio (módulo) | Cuenta | Recurso y acciones | Prueba negativa |
|---|---|---|---|
| Revisión de sesión, control de pedidos y paneles (`candadoRedis`: `estado`, `restantes`, `usuarios`) | `rd_candados_r` | `%R~bloqueo:*`, `%R~restriccion:*`: `PTTL`, `SCAN` (solo lectura) | `DEL bloqueo:7`, `SET bloqueo:7`, `PTTL carrito:7` → NOPERM |
| Suspensión (`candadoRedis`: `bloquear`, `levantar`) | `rd_candados_w` | `~bloqueo:*`, `~restriccion:*`: `PTTL`, `SET`, `DEL`, `EVAL`, `EVALSHA` | `GET carrito:1`, `SCAN 0`, un `EVAL` que lee `carrito:1` → NOPERM / «ACL failure in script» |
| Carrito (`cartService`) | `rd_carrito` | `~carrito:*` con los comandos de sus tres scripts Lua | `GET bloqueo:7`, `FLUSHALL`, `KEYS *`, `INFO`, `CONFIG GET *`, `SCAN`, un `EVAL` que lee `bloqueo:7` → NOPERM |
| Ofertas flash y reservas del checkout (`ofertaDatosService`, `ofertaFlashService`, `checkoutIntentoService`) | `rd_ofertas` | `~oferta:*`, `~checkout:reserva:*` + Lua (incluye `TIME`) | `SET bloqueo:7`, `GET oferta-recomendada:1:7:stock` → NOPERM |
| Topes de pedidos y de intentos de contraseña (`limitePedidosService`, `reautenticacionService`) | `rd_cupos` | `~limite:pedidos:*`, `~reauth:intentos:*` | `GET bloqueo:7`, `SET limite:pedidos:7 0` → NOPERM |
| Recomendaciones por tendencia (`tendenciaService`) | `rd_recomendaciones` | `~recomendaciones:*`, `~oferta-recomendada:*` | `GET oferta:1:stock`, `DEL recomendaciones:7` → NOPERM |
| Actividad reciente de la búsqueda (`catalogoLecturaService`) | `rd_actividad` | `~actividad:*`: `LRANGE`, `LPUSH`, `LREM`, `LTRIM`, `EXPIRE` | `GET carrito:1`, `DEL actividad:7` → NOPERM |
| Salud (`estadoServiciosService`) | `rd_salud` | `PING`, ninguna llave | `GET carrito:7`, `KEYS *`, `INFO` → NOPERM |
| Scripts `verificar*`/`backfill*` | `rd_admin` (el usuario `default` queda apagado) | todo | — |
| API de catálogo, reseñas y checkout | Mongo `mg_app` (rol `app_tiendaya`) | `productos`, `categorias`, `subcategorias`, `resenas`: `find`, `insert`, `update`; `producto_eventos`: `find` e `insert`; más `createIndex`/`createCollection`/`listIndexes`, que Mongoose usa al cargar un modelo | update/delete de un evento, borrar la colección o una base, `createUser`, leer `admin.system.users` → «not authorized» |
| Mantenimiento (`npm run seguridad:mongo`, scripts que borran) | Mongo `mg_admin` (`root`) | todo | — (el servidor web nunca la usa; lo comprueba una prueba) |
| `busquedaService` / `busquedaSyncService` (ideal) | ES `tiendaya_buscador` (`read`) / `tiendaya_sincronizador` (`write`) | índice `tiendaya_productos` | `PUT _doc` con el de lectura → 403; `_search` con el de escritura → 403 |
| `ventasService` / `ventasSyncService` (ideal) | Cassandra: lectura (SELECT) / escritura (MODIFY) / admin (DDL) | `tiendaya_analytics` | INSERT con la de lectura → Unauthorized |
| `fraudeService` / `fraudeSyncService` | Neo4j: usuario propio | lectura/escritura sólo por convención (`executeRead`/`executeWrite`) | documentar el límite |

### 4.3 Lo más delicado: un error de credencial **no** es una caída

La degradación elegante (§2) asume que «error de base = caída». Con autenticación eso deja de ser cierto, y el agente encontró cinco consecuencias concretas (leídas del código y probadas con credenciales malas):

1. **Mongo:** `AuthenticationFailed`/`Unauthorized` no se clasifican como caída (`componenteCaido()` devuelve `null`), pero `responderError` los devuelve con el estado por defecto de la ruta (p. ej. 404 «producto no encontrado») y `cuerpoDeError` filtra al cliente «not authorized on tiendaya to execute command {…}».
2. **Redis:** `ioredis` 6 ante `WRONGPASS` reconecta en bucle; el manejador lo imprime como «redis no responde (se sigue sin él)» y el cliente tolerante responde 503 mientras tanto.
3. **Falla abierta en silencio:** `estaBloqueada()` captura **todo** y falla abierto: un `NOPERM` desactivaría las suspensiones sin que nadie lo note.
4. **Elasticsearch:** `conectar()` hace `exists` + `putMapping` en el primer uso: con una clave de sólo lectura da 403 (y `ping` sin privilegio `monitor` también).
5. **Cassandra y Neo4j:** las credenciales malas llegan como `NoHostAvailableError` (que `componenteCaido` clasifica como caída) o `AuthenticationRateLimit`; y el *health* público las muestra.

**Mitigación:** una clase `CredencialRechazada` (500, `CREDENCIAL_RECHAZADA`) y `esErrorDeAcceso(err)` por driver (Redis `WRONGPASS`/`NOAUTH`/`NOPERM`; Mongo códigos 13/18; Elasticsearch 401/403; Cassandra `AuthenticationError`; Neo4j `Neo.ClientError.Security.*`; MySQL 1045/1044/1142/`P1000`), **fuera** de `componenteCaido`; un «cerrojo» que al primer rechazo detiene los reintentos y escribe **una** línea («credencial rechazada de <servicio>: revisá .env/ACL»); `estaBloqueada` y `controlPedidos` relanzan estos errores en vez de fallar abiertos; el *health* devuelve `credencial_rechazada`, distinto de `caido`, con detalle sólo para el administrador; `cuerpoDeError` sanea el texto; y se separa el arranque de esquema (cuenta admin) del uso en tiempo de ejecución en Elasticsearch y Cassandra.

### 4.4 Plan de trabajo

**MVP ≈ 25–30 h (piso ≈ 17–20 h).** Orden pensado para que lo barato y seguro vaya primero:

| # | Paso | Horas | Archivos |
|---|---|---|---|
| 1 | ✅ **Huecos de API 1–4** + matriz de pruebas rol × endpoint (estilo `checkoutHttp.test.js`, con dobles) — **hecho el 2026-10-23**, resultado en §4.1 | 4–6 | `routes/productoRoutes.js`, `routes/saludRoutes.js` (nuevo), `services/resenaService.js`, `services/estadoServiciosService.js`, `tests/accesoApi.test.js` |
| 1b | ✅ **Lista blanca de la API** (§4.0): `config/politicaRutas.js` (cada ruta declarada con su acceso) + prueba que recorre el router real y falla si falta una ruta o el acceso no coincide — **hecho el 2026-10-23**, resultado en §4.1 | 3–4 | `config/politicaRutas.js`, `middleware/auth.js`, `tests/accesoRutas.test.js` |
| 2 | ✅ **Redis ACL como lista blanca** (§4.0): `aclfile` desde `.env`, cuentas por módulo (`-@all` + comandos + llaves), `config/redis.js` por módulo, errores de credencial (§4.3) — **hecho el 2026-10-23** | 6–8 | `docker-compose.yml`, `docker/`, `config/redis.js`, `utils/resiliencia.js`, `utils/http.js`, `suspensionService.js`, `middleware/controlPedidos.js`, `.env.example` |
| 3 | ✅ **Script de arranque idempotente** (`npm run seguridad:inicializar`) + **ADR-007** — **hecho el 2026-10-23** | 3–4 | `scripts/seguridad/inicializar.js`, `IA/ADR-007-control-de-acceso.md` |
| 4 | ✅ **Mongo RBAC:** keyFile, roles y usuarios (`npm run seguridad:mongo`), healthcheck sin credenciales, credenciales aparte de `MONGO_URI`; `producto_eventos` solo `find` e `insert` — **hecho el 2026-10-23** | 6–8 | `docker-compose.yml`, `docker/mongo/init/01-roles.js`, `config/mongo.js` |
| 5 | ✅ **`verificar:acceso`:** abre cada cuenta, ejecuta la tabla permitido/negado (incluye lo que **no** está en la lista blanca) e imprime la matriz (~10 s) — **hecho el 2026-10-23** (Redis y Mongo) | 2–3 | `scripts/verificarControlAcceso.js` |
| 6 | ✅ *Ideal de la capa 1:* política `acl_regla` + `requireRole` que la consulta + `/admin/permisos` (matriz, simulador, cuentas y roles, auditoría) + auditoría en Mongo — **hecho el 2026-10-25**, ver [ADR-007 §9](ADR-007-control-de-acceso.md) y §4.5 | 8–10 | `prisma/schema.prisma` + migración `acl_politica_permisos`, `middleware/auth.js`, `services/politicaAccesoService.js`, `usuarioAdminService.js`, `auditoriaAccesoService.js`, `routes/adminAccesoRoutes.js`, `models/mongo/AuditoriaAcceso.js`, `frontend/src/pages/admin/AdminPermisosPage.jsx` |

**Ideal (+16–20 h):** Elasticsearch (5–6), Cassandra (5–6), Neo4j autenticado (1), MySQL mínimo (2), secretos y puertos (2), matriz generada con `ACL DRYRUN` (2).

**Evidencia a mostrar.** Negativas por nivel — Redis `NOPERM`/`NOAUTH`/`WRONGPASS` + `ACL LOG`; Mongo «not authorized»/«requires authentication»; Elasticsearch 403; Cassandra `Unauthorized`; API 403 (comprador → `/api/admin/fraude`; vendedor A → historial de B, hoy 200). IDOR de pedidos: `GET /api/compras/{id ajeno}` → «Pedido no encontrado» (ya correcto). Automatizado: `npm run verificar:acceso` + pruebas `acceso*.test.js`. **En vivo:** `redis-cli --user rd_candados_r DEL bloqueo:7` y luego `ACL LOG`; `mongosh -u tiendaya_app` intentando modificar un evento; en la app, el token de un vendedor llamando `/api/admin/fraude` y, si se hace el ideal, la concesión al `auditor`.

**Riesgos y mitigaciones.**
- **Mongo con auth y replica set:** keyFile en Windows (receta con `chmod`); con volumen nuevo, `MONGO_INITDB_ROOT_*` + `docker-entrypoint-initdb.d/*.js` y healthcheck que hace `rs.initiate` con credenciales (healthy en ~10 s); con el volumen existente, crear el primer usuario por la *localhost exception* (después `rs.status()` sin credenciales falla —el healthcheck actual se rompe— pero `ping` responde); Mongoose pide `createIndex` (+ `createCollection`) sobre `producto_eventos` o `init()` falla. **Alternativa si no alcanza el tiempo:** retirar `--replSet` (el código no usa transacciones, ver §6).
- **Volúmenes ya inicializados:** MySQL → script idempotente; Cassandra conserva datos al reiniciar con el yaml nuevo; Redis no tiene volumen.
- **≈ 240 pruebas:** no cambian (inyectan dobles, no abren conexiones); sí cambian `.env` y los `verificar*`.
- **Secretos:** `.env` ya está en `.gitignore`; `.env.example` + generador de contraseñas; el aclfile se genera desde variables; rotar el `JWT_SECRET` de desarrollo; Vault con credenciales dinámicas es la ruta de producción, no del proyecto.
- **Puertos:** MySQL 3306, Mongo 27018 y Redis escuchan en `0.0.0.0` (comprobado en el compose) → publicar en `127.0.0.1` como ya hacen Elasticsearch, Neo4j y Cassandra (con wifi compartida en la presentación es un riesgo real).
- **Coordinación:** `config/redis.js` y el compose los tocaron compañeros: diff contra su último commit y reportar de quién es qué; **no subir a Redis 8 a la vez** que las ACL.

**Casos reales para la presentación** (fuentes en §12): MongoDB sin contraseña (Victor Gevers, dic-2016, rescate; ola de sep-2017 con decenas de miles de servidores); «Meow» (jul-2020) borró más de 1.000 bases Elasticsearch/MongoDB abiertas — Elastic dijo que esos clústeres no tenían activada ninguna de sus funciones de seguridad.

**Fuera de alcance.** mTLS/x509 entre servicios, Vault, cifrado en reposo o de campo, DLS/FLS de Elasticsearch (de pago), SSO/Keycloak/OPA/OpenFGA, WAF y límites globales de tasa, roles en Neo4j (Enterprise).

### 4.5 La pantalla de permisos (hecho el 2026-10-25)

Se pidió «una interfaz visual». Se estudiaron las consolas reales (Kubernetes RBAC y `kubectl auth can-i`, el simulador de AWS IAM, los roles y el registro de auditoría de GitHub, Auth0, la hoja de OWASP: las páginas abiertas están citadas en [ADR-007 §9.1](ADR-007-control-de-acceso.md)) y se tomó de cada una lo que encaja con este tamaño. Resultado: `/admin/permisos` con cuatro pestañas —**matriz** rol × acción con cambios sin guardar y resumen, **simulador**, **cuentas y roles**, **auditoría** con filtros y CSV—, y un panel que ofrece a cada cuenta solo lo que su rol puede usar.

**Desvíos respecto del diseño de §4.1** (todos por proporción, comprobados): (1) la tabla guarda **diferencias** respecto del código, no una copia de la política: `acl_regla(rol_id, ruta, permitido, actualizado_por, actualizado_en)`, así una ruta nueva funciona de inmediato y «restaurar» es borrar filas; (2) no se agregó `autorizar()`: `requireRole` conserva su firma y consulta la política (cero cambios en las rutas); (3) la invalidación es una copia de 5 s y la invalidación inmediata del proceso que escribe, **sin** la clave `acl:version` en Redis (un solo proceso; evita otra cuenta de Redis y otra falla posible); (4) el rol de la cuenta se lee de MySQL (≤ 5 s) y no del token de 2 h; (5) lo editable se declara ruta por ruta (13 editables, 14 fijas con su motivo) en vez de «todo es editable»; (6) la columna del administrador es fija —es la forma de que `permisos:editar` no se pueda quitar—; (7) un rol creado nunca recibe rutas que dependen del dueño o del compromiso de no reventa. **La decisión «¿categorías solo del administrador?» (§4.1, fila 5) quedó como una casilla de la matriz** (*Crea una categoría*, columna vendedor), que se cambia sin tocar el código.

**Evidencia:** 103 pruebas `test:permisos`, 68 mutaciones detectadas, `verificar:permisos` contra las bases reales (32 comprobaciones), el rol de MongoDB comprobado contra el servidor (la auditoría no se modifica ni se borra) y el recorrido en el navegador (cuenta con un rol propio que ve solo lo concedido).

## 5. Ítem 3 — Diagrama de arquitectura final (3 pts)

**Qué se gana:** «completo y correcto». **Hallazgo:** el diagrama actual ([ERD-ARQUITECTURA-POLIGLOTA.md §1.1](ERD-ARQUITECTURA-POLIGLOTA.md)) no pasaría esa vara. Omite `checkout_intento` y `checkout_sesion`, la colección `resenas`, los respaldos Mongo↔Elasticsearch, el endpoint de salud y tres de los cuatro procesos de fondo del backend; cuatro nodos de Redis (`bloqueo`, `restriccion`, `limite`, `recomendaciones`) están declarados y no tienen ninguna flecha; su título dice «actualizado 2026-10-04» pese a los cambios del 17 al 20 de octubre. Una sola página con ~45 flechas es la causa: por eso omite.

**Propuesta: cuatro vistas y una secuencia, en Mermaid** (ya está en el repo y GitHub lo renderiza), exportadas a PNG/SVG con `mmdc` (mermaid-cli) para el informe y las diapositivas; fuente y exportes versionados en `IA/ARQUITECTURA-FINAL.md` e `IA/img/`. Ese documento puede hacer de **informe de arquitectura final** del PRD (con enlaces a ADR-006, ADR-007 y la retrospectiva); el formato exacto se confirma con el catedrático (§10, pregunta 1).

| Vista | Qué muestra | Tope |
|---|---|---|
| **V1 Contenedores** (C4 nivel 2) | Seis bases + vector + el backend único + frontend; cada almacén marcado como **verdad** o **copia derivada** y con su reparación (`backfill`, outbox, cola de reconciliación) | — |
| **V2a Escrituras y sincronización** | Quién escribe qué y con qué garantía (A, B, C) | ≤ 25 flechas |
| **V2b Lecturas, caché y respaldo** | Caché (T), respaldo de lectura Mongo↔ES (F) y controles que fallan abiertos (O) | ≤ 25 flechas |
| **V3 Despliegue y seguridad** | `docker-compose` (puertos, volúmenes, límites de memoria, 0.0.0.0 vs 127.0.0.1) y cuentas de servicio → permisos → bases | — |
| **V4 Secuencia del checkout** | Dónde cae cada fallo y qué hace el sistema | — |

**Leyenda** (legible en blanco y negro: la garantía va como letra en la etiqueta): verde = verdad; gris con borde discontinuo = copia derivada; naranja = control volátil; borde azul grueso = **nuevo en esta entrega**; `==>` **A** transacción ACID, `-->` **B** outbox durable e idempotente, `-.->` **C** mejor esfuerzo con reparación idempotente, **T** caché con TTL, **F** respaldo de lectura, **O** control que falla abierto, **R** referencia por id sin clave foránea.

**Lista de chequeo «completo y correcto»** (un revisor la aplica contra el repo):

1. Cada servicio de `docker-compose.yml` con puerto, volumen, `mem_limit` y si se publica en 0.0.0.0 o 127.0.0.1.
2. Cada `backend/src/config/*.js` (6) como cliente, con sus tiempos de espera y cortacircuito.
3. Cada modelo Prisma (14) y Mongoose (5), cada prefijo de llave de Redis, las 2 tablas CQL, las 5 etiquetas de Neo4j, el índice de Elasticsearch y el artefacto vectorial.
4. Cada proceso periódico de `server.js` y la cola de reconciliación, con intervalo y bandera.
5. Cada flecha entre almacenes con mecanismo, disparador, garantía (A–R) y archivo.
6. Toda copia apunta a su fuente y a su reparación; ninguna flecha copia→verdad salvo la «decisión» marcada (Neo4j→`bloqueo_cuenta`).
7. Respaldos (F) y controles que fallan abiertos (O) marcados; excepciones de autoridad declaradas (cupo flash en Redis; el estado de publicación vía Elasticsearch cuando Mongo cae).
8. Lo nuevo resaltado y con su comportamiento ante una caída.
9. Banderas y cifras iguales a `.env.example` y al compose.
10. Leyenda legible en blanco y negro; fuente Mermaid + PNG/SVG versionados.
11. Opcional: una prueba de «deriva» con `node --test` que compare las bases de `docker-compose.yml` y los `config/*.js` con los nodos del diagrama (una *fitness function*).

**Trabajo:** ≈ 10–13 h — adyacencia servicio→almacén con `grep` (1 h), V1 y V2 (3 h), V4 (1 h), V3 cuando se fijen las cuentas de servicio (2 h), exportes (1 h), prueba de deriva (2–3 h, opcional), pasada final antes de congelar. **Evidencia:** el documento con las vistas, la lista con ✔ y el archivo de cada punto, una flecha nueva (vector) trazada hasta su código. **Fuera de alcance:** C4 nivel 4, servidor Structurizr, diagramas de clases, rehacer el ERD relacional.

## 6. Ítem 4 — Documento de retrospectiva (4 pts)

**Qué se gana:** que se lea *sustentado*, no como un listado de opiniones. Regla: cada celda cita archivo, sección o commit; cada veredicto lleva un número; cada «replantear» incluye el mejor argumento *en contra*; y alguien que no escribió la fila audita sus citas.

**Métricas del proyecto** (verificadas): 65 commits (2026-08-19 → 2026-10-20), 12 migraciones, 14 modelos Prisma + 5 Mongoose, 6 contenedores, 5 ADR, 13 scripts `verificar:*`, ≈ 240 pruebas unitarias (31 archivos), spike de pagos con 128 verificaciones.

**Hallazgo que la retrospectiva debe admitir:** el ADR-003 justifica el replica set de Mongo por transacciones («actualizar el documento vigente» y «grabar el evento» atómicos), pero el código no las usa — no hay `startSession` ni `withTransaction`, y `productoService` hace `Producto.create` y luego `ProductoEvento.create` en secuencia. El historial puede mentir ante un fallo a medias. Se cierra implementando la transacción o retirando `--replSet` (y eso, además, simplifica el control de acceso de Mongo, ver §4).

**Borrador de la tabla «se sostendría / se replantearía»** (el equipo la completa y vota «¿la volveríamos a tomar? 1–5» por fila; el costo de cambio es estimación propia, no medida):

| # | Decisión | Evidencia (archivo/§) | Veredicto |
|---|---|---|---|
| 1 | MySQL como verdad transaccional | ADR-002 §3.2 evitó romper el checkout antes de codificar; ADR-005: 128 verificaciones; dolor: «pool timeout» por `allowPublicKeyRetrieval` y la shadow DB (ESTADO §4, ADR-001) | **Sostener.** Postgres + pgvector ahorraba un almacén: se reconsideraría |
| 2 | Mongo para catálogo + historial por eventos | EAV de 7 tablas → 1 documento (ADR-002 §1.1); la transacción de ADR-003 §3.2 no existe; documento fantasma (ENTREGA-3 §4) | **Sostener Mongo; replantear la garantía** |
| 3 | Copiar precio y stock a Mongo (ADR-002 §3.3) | deriva que no se autorepara (ENTREGA-3 §5.3); cola en memoria (ENTREGA-3 §7.6); `conExistenciasVigentes` relee el stock | **Replantear:** copiar sólo lo lento (precio, por el índice compuesto), no el stock |
| 4 | Redis para oferta flash, candados y TTL | Lua atómico: 5 de 15 admitidos (ESTADO §3.8); sin fail-fast, Redis caído = 73–108 s por petición (ENTREGA-3 §7.1) | **Sostener flash + TTL;** replantear su peso en la ruta de suspensión |
| 5 | Controles que fallan abiertos (topes, candados) | ENTREGA-3 §7.6: con Redis caído una cuenta suspendida actúa | **Sostener,** documentado; fail-closed sólo en la compra |
| 6 | Cassandra + outbox para ventas | el outbox sobrevive a la caída sin duplicar (ENTREGA-3 §5); ADR-004 §2 no afirma que el volumen lo exija; 261 pagos | **Sostener el patrón; replantear Cassandra** por volumen |
| 7 | Neo4j para fraude | modelo rediseñado cuatro veces el 4/10 (PLAN-NEO4J §16–§19); el primer barrido limitó cuentas reales del seed (PLAN-NEO4J §21) | **Sostener Neo4j; replantear el proceso** (identidad antes que señales; ventana de recencia) |
| 8 | Elasticsearch + facetas | `dynamic: strict` tras un campo mal escrito (0cff9d9); facetas que colapsaban: rehechas (daf22bd); stock volátil en el índice | **Sostener;** sacar campos volátiles |
| 9 | Mejor esfuerzo vs outbox (ENTREGA-3 §3) | criterio sólido, pero tres mecanismos de reparación distintos | **Sostener el criterio;** un outbox genérico (como `pago_outbox`, ADR-005 §9.3) |
| 10 | Referencias entre bases sin FK | dos puntos de ENTREGA-3 §4 sin mitigar | **Sostener;** cerrar con un barrido de huérfanos |
| 11 | No migrar los pagos a NoSQL (ADR-005) | saga 2,1× de latencia, JOIN 2,5×, 4447 reintentos de Mongo; matriz 4,20 vs 2,70 | **Sostener** (la decisión mejor sustentada); pasarla de «propuesta» a «aceptada» |
| 12 | JWT + roles + suspensión por petición | un token de cuenta suspendida muere al instante, pero cada petición toca Redis (causa de los 108 s) | **Sostener;** añadir una matriz de autorización probada (§4) |
| 13 | Checkout idempotente (17/10) | UUID durable; `test:checkout` | **Sostener;** debió estar desde el día 1 |
| 14 | Degradación elegante (19–20/10) | se descubrió que *no* se cumplía; arreglo en 66 archivos (1b65b32) | **Sostener;** probar con contenedores apagados desde la primera integración |
| 15 | «Seis bases para ~109 productos» | ADR-004 §2; ADR-005 §3 (261 pagos, 0,67 MB) | **Sostener por el objetivo del curso (PRD §1–2), no por volumen;** criterio de salida por almacén |

**Estructura del documento** (`IA/RETROSPECTIVA.md`): 1 resumen; 2 métricas; 3 línea de tiempo; 4 la tabla anterior con costo de cambio y **disparador de revisión** por fila; 5 incidentes sin culpa (ESTADO §4 y ENTREGA-3 §7.1); 6 deuda técnica con el cuadrante de Fowler; 7 **arquitectura v2 «si empezáramos hoy»**; 8 lo que no sabemos (cifras de un portátil); 9 responsabilidades (PRD §7). **v2:** *de negocio* — MySQL o Postgres + pgvector, Redis (flash, candados), búsqueda en el mismo motor o Elasticsearch, sin Cassandra, identidad de fraude en SQL; *de curso* — las seis bases, pero con un outbox único, clientes con fail-fast desde el día 1, sólo atributos lentos en Mongo y el vector dentro de un almacén existente. Convertir tres filas en ADR «propuesta» (copiar sólo lo lento, outbox genérico, replica set).

**Prácticas y casos reales para ilustrar** (el agente abrió la mayoría de las fuentes —listadas en §12—; ábranlas antes de citarlas): ADR «superseded» (Nygard; guía de Microsoft), Radar de ThoughtWorks, *fitness functions*, pre-mortem, cuadrante de deuda de Fowler, posmortem sin culpa (SRE de Google). Casos que cambiaron de rumbo *por una métrica propia*: Segment (microservicios → un servicio, 2018), Shopify (monolito modular), Discord (Cassandra → ScyllaDB), Uber (Postgres → MySQL), Instacart (Elasticsearch → Postgres + pgvector, 2025).

**Trabajo:** ≈ 8–9 h — volcar la tabla (30 min), auditar cada cita (1,5 h), métricas (30 min), sesión de equipo con pre-mortem + votos (90 min), v2 + incidentes + deuda (2 h), tres ADR (1 h), revisión cruzada. **Fuera de alcance:** ATAM completo; editar ADR aceptados (se *supersede*).

## 7. Ítem 5 — Presentación (4 pts)

**Qué se gana:** claridad y poder **sustentar** decisiones. Estructura recomendada: **pirámide** (tesis → tres decisiones sustentadas + tres replanteadas → demos → v2), con diapositivas *assertion-evidence* (el título es la afirmación; el cuerpo, la evidencia). Tesis: «la garantía de cada copia depende de cuánto cuesta que llegue tarde» (ENTREGA-3 §3).

**20 min + 7 de preguntas; 14 diapositivas + 8 de respaldo:**

| Min | Contenido | Quién (3 personas) |
|---|---|---|
| 0:00–4:30 | Tesis + diagramas V1 y V2 | A |
| 4:30–7:30 | **Demo 1 — degradación** | B |
| 7:30–10:00 | **Demo 2 — búsqueda y productos similares** | C |
| 10:00–12:30 | **Demo 3 — acceso denegado** + modelo de amenazas | B |
| 12:30–15:30 | Tres decisiones con número: pagos en MySQL, outbox, mejor esfuerzo vs garantía | A |
| 15:30–20:00 | Tres replanteadas + v2 + mapa a la rúbrica | C |

Con dos integrantes: A = arquitectura, decisiones y retrospectiva; B = demos, vector y acceso. **Todos responden todo**: el historial de git concentra 55 de 65 commits en una cuenta, y el jurado puede preguntarle a cualquiera.

| Demo | Pasos | Plan B |
|---|---|---|
| 1 Degradación | `/api/health/componentes` completo → `docker stop tiendaya-redis tiendaya-elasticsearch tiendaya-neo4j tiendaya-cassandra` → franja amarilla en ≤ 10 s → buscar, carrito y **confirmar el pedido (`201`, ~1,1 s)** → `docker start` → la venta llega sola al panel (≤ 30 s) | video de 90 s; sin Docker, `npm run test:resiliencia` |
| 2 Búsqueda y similares | «camiceta» → resultados y sugerencias; Talla M y L sigue visible; un producto con similares; con el almacén vectorial apagado la sección desaparece sin error | capturas + `verificar:busqueda` |
| 3 Acceso denegado | comprador → `/api/admin/fraude` = 403; cuenta de servicio sin permiso → `NOPERM`/«not authorized»; anónimo → `NOAUTH`; la lista de permisos | video + matriz de pruebas |

**Preparación de la sala:** `docker compose up -d` 15 min antes (Cassandra tarda hasta 60 s); cuentas de demo propias (Ana y Luis están bajo vigilancia y piden contraseña; el barrido de 60 s puede suspender cuentas sintéticas; `verificar:ofertaFlash` vacía el stock del producto #1); datos precargados (seed, `busqueda:backfill`, vectores); `prisma generate` y reiniciar el backend tras traer migraciones; una segunda laptop con el stack arriba; todo local, sin internet.

**Banco de preguntas difíciles** (la hoja completa, con la evidencia de cada respuesta, se prepara en el trabajo; estas son las 12 que más duelen):

| Pregunta | Respuesta corta y su evidencia |
|---|---|
| ¿Por qué MySQL y no PostgreSQL + pgvector? | El PRD lo admite y el checkout se midió en MySQL (ADR-005); Postgres uniría relacional y vector y se reconsideraría, pero cambiarlo hoy excede el plazo. Instacart consolidó en Postgres + pgvector |
| ¿Cassandra para ~109 productos? | No por volumen (ADR-004 §2): es la familia columnar del PRD y sostiene el outbox (ENTREGA-3 §5); hoy viviría en MySQL |
| ¿Y si cae Redis en plena oferta flash? | Las ofertas se ocultan con `503` y mensaje; el stock real lo protege MySQL; topes y bloqueos fallan abiertos para no cerrar el sitio (ENTREGA-3 §7.6) |
| ¿Cómo evitan la sobreventa? | `UPDATE … WHERE cantidad >= n` dentro de la transacción (`checkoutService.js`), no la copia de Mongo; ADR-005: 100–400 compradores sobre 30 unidades → exactamente 30 |
| ¿Cómo saben que las recomendaciones son buenas? | Se mide con la subcategoría como etiqueta (precisión@5) y casos a mano; límite declarado: títulos cortos y 109 productos (§3) |
| ¿Por qué es seguro el control de acceso? | Dos capas: API (JWT + `requireRole` + suspensión por petición) y datos (cuentas por servicio con mínimo privilegio); límites dichos (§4) |
| ¿Qué cambiarían? | Copiar sólo lo lento, un outbox genérico, fail-fast desde el día 1, el vector dentro de un almacén existente (§6) |
| ¿Seis bases para 109 productos? | Por volumen no; por patrón de acceso y objetivo del curso (PRD §1–2); la v2 trae criterio de salida por almacén |
| ¿Por qué no migraron los pagos a NoSQL? | ADR-005: saga 2,1× de latencia, JOIN 2,5× más rápido, 4447 reintentos de Mongo, se pierde la FK |
| ¿Y si se pierde la respuesta del COMMIT? | `checkout_intento` con UUID + bloqueo de usuario + respuesta guardada: reenviar da `200` (`test:checkout`, `verificar:idempotencia`) |
| ¿Se pierden ventas si cae Cassandra? | No: el outbox va en la misma transacción, con backoff e inserciones idempotentes. Ojo: `.env.example` trae el outbox apagado (ver §9) |
| ¿Para qué un replica set de un nodo? | ADR-003 previó transacciones y el código no las usa: se reconoce y se cierra (§6) |

**Trabajo:** títulos-afirmación de las 14 diapositivas (hoy), diapositivas del diagrama con la V1, tres videos de 90 s tras el MVP, ensayo 1 cronometrado, pre-mortem + preguntas cruzadas, ensayo 2 ≤ 18 min, prueba técnica en el aula si es posible (HDMI, resolución, `docker ps`). **Evidencia:** PDF, 3 videos, guion con tiempos, hoja de preguntas, registro de ensayos. **Fuera de alcance:** programar en vivo, herramientas externas de caos, demo con internet.

## 8. Calendario, reparto y definición de hecho

**Fechas conocidas.** Hoy es jueves 22 de octubre de 2026; el lunes 26 la clase fija la fecha de la revisión; el examen del curso es el lunes 2 de noviembre. Como la fecha de la revisión es incierta, el plan tiene dos escenarios: **A** (revisión el jueves 29 o viernes 30, antes del examen — el caso exigente) y **B** (martes 3 a jueves 5 de noviembre — el caso holgado). **El MVP se planifica para A**; lo *stretch* sólo entra si la fecha resulta ser B.

**Niveles de entrega** (horas = estimación de los agentes, persona-horas):

| Nivel | Qué incluye | Horas |
|---|---|---|
| **Piso** | V: MVP de §3.8 · S: huecos de API 1–4 + Redis ACL + pruebas + `verificar:acceso` (§4.4, pasos 1, 2 y 5) · C: diagrama (V1, V2a/b, V3 simple), retrospectiva de 15 filas, 14 diapositivas + 2 demos + 1 video | ≈ 60–65 |
| **Completo** | Piso + Mongo RBAC y ADR-007 (§4.4, pasos 3–4) + sinónimos (3 h) + prueba de deriva del diagrama + 3 videos + 3 ADR «propuesta» | ≈ 80–90 |
| *Stretch* | Historial de búsqueda con vectores y «borrar historial» (la versión simple ya existe), señal por direcciones (+ IP como corroborador), `descripcion_larga`, política `acl_regla` + `/admin/permisos`, seguridad en Elasticsearch/Cassandra/Neo4j/MySQL | +40–55 |

**Si faltan manos (escenario A con dos personas), recortar en este orden:** (1) Mongo RBAC pasa a *stretch* (Redis ACL ya cumple «al menos un componente NoSQL»); (2) sinónimos fuera; (3) sin prueba de deriva; (4) 12 diapositivas y un solo video; (5) del diagrama, sólo V1 y V2 + una V3 mínima. Lo que **no** se recorta: línea base vs kNN medida, huecos de API arreglados con su prueba, la demo de acceso denegado y la tabla de la retrospectiva.

| Día | Escenario A — revisión jue 29 / vie 30 | Escenario B — revisión mar 3 a jue 5 |
|---|---|---|
| **Jue 22** | Decidir con el equipo lo del §10 que se pueda sin el catedrático (autorización del modelo, pistas, dueños); **S:** huecos de API 1–4 con su prueba · **V:** prueba previa del modelo (si se autoriza) · **C:** esqueleto de diagrama y de retrospectiva, 14 títulos-afirmación de las diapositivas | igual |
| **Vie 23** | **V:** `embeddingService` + datos (Mongo, mapping, sincronización, backfill) · **S:** Redis ACL (cuentas por módulo, errores de credencial) · **C:** V1 y V2 + tabla de retrospectiva | igual |
| **Sáb 24** | **V:** consulta, respaldo, ruta y widget · **S:** script de arranque idempotente + ADR-007 · **C:** retrospectiva completa, diapositivas S3–S5 | igual |
| **Dom 25** | **V:** evaluación + ADR-006 · **S:** Mongo RBAC (o *stretch*) + `verificar:acceso` · integración, `npm run test:*`, los `verificar:*` críticos y la etiqueta `mvp-1` | igual |
| **Lun 26** | La clase fija la fecha; hacerle al catedrático las preguntas del §10; V3 y V2 definitivas con lo implementado | igual |
| **Mar 27 – mié 28** | **Congelación el martes a las 12:00**; documentos finales y videos; el miércoles, ensayo 1 y pre-mortem | Endurecimiento (ADR-005, huérfanos) y *stretch*; pulido |
| **Jue 29 – vie 30** | Ensayo 2 y **presentación** | Congelación el viernes; diapositivas finales |
| **Sáb 31 – lun 2** | — | Videos; **lunes 2, examen: sin trabajo de proyecto** |
| **Mar 3 – jue 5** | — | Ensayos 1 y 2, comprobación técnica a las 9:00, **presentación** |

**Reparto.** Tres pistas, con dueños que el equipo asigna (el historial de git muestra tres autores con 55, 6 y 4 commits: conviene que todos conozcan todo, porque en la defensa cualquiera puede ser interrogado). Con **tres** personas, una por pista; con **dos**: una persona lleva V y el diagrama, la otra S y la retrospectiva, y la presentación es de ambos.

| Pista | Qué incluye | Archivos propios (para no pisarse) |
|---|---|---|
| **V · Vector** | §3: embeddings, índice, endpoint, widget, respaldo, evaluación, ADR-006 | `services/embeddingService.js`, `config/elasticsearch.js`, `busquedaSyncService.js`, `busquedaService.js`, `catalogoLecturaService.js`, `ProductosRelacionados.jsx`, `verificarSimilares.js` |
| **S · Acceso** | §4: huecos de API, cuentas de servicio, arranque con auth, matriz y pruebas negativas | `docker-compose.yml`, `docker/*`, `config/redis.js`, `config/mongo.js`, `utils/resiliencia.js`, `utils/http.js`, `.env.example`, `tests/acceso*.test.js`, `verificarControlAcceso.js` |
| **C · Cierre** | §5, §6, §7 | `IA/ARQUITECTURA-FINAL.md`, `IA/RETROSPECTIVA.md`, `IA/img/`, diapositivas, README y `ESTADO-PROYECTO.md` |

Archivos «calientes» por historial: `ESTADO-PROYECTO.md` (37 cambios), `README.md` (33), `app.js` (29), `package.json` (18). Regla: un solo dueño (C) para README y ESTADO; V no toca `app.js`; S y V añaden scripts en líneas separadas de `package.json` y rebasan antes de fusionar; `productoRoutes.js` lo tocan V (ruta de relacionados) y S (historial y estadísticas): coordinar ese archivo. Ramas `feat/acceso`, `feat/vectores`, `docs/cierre`; orden de fusión S → V → C.

**Definición de hecho** — la evidencia que se debe poder mostrar:

| Ítem | Evidencia concreta |
|---|---|
| Recomendación semántica (5) | un `GET` de relacionados con puntaje; captura del widget en la ficha del producto; apagar el almacén vectorial y la página sigue funcionando; tabla de precisión@5 y de consultas coloquiales (kNN vs BM25 vs `more_like_this`); ADR-006 |
| Acceso NoSQL (4) | compose con autenticación activa; ≥ 2 cuentas de servicio por componente; lista de usuarios/permisos; una operación denegada con su código de error; la matriz rol × endpoint de la API pasando como pruebas automáticas; los huecos 1–4 cerrados con su prueba |
| Diagrama (3) | `ARQUITECTURA-FINAL.md` con las vistas + PNG/SVG + lista de chequeo con ✔ y archivo por punto (+ prueba de deriva si se hace) |
| Retrospectiva (4) | `RETROSPECTIVA.md` con 15 filas citadas, v2 y firmas del equipo; tres ADR «propuesta» |
| Presentación (4) | PDF, videos de respaldo, guion con tiempos, hoja de preguntas, registro de dos ensayos ≤ 18 min |

## 9. Riesgos de toda la entrega

P = probabilidad, I = impacto (A alta, M media).

| # | Riesgo | P | I | Mitigación |
|---|---|---|---|---|
| 1 | ✅ *(resuelto el 2026-10-23: keyFile con copia y `chmod`, healthcheck sin credenciales, probado con datos reales y con volumen nuevo)* **Mongo con autenticación + replica set** rompe el healthcheck (`rs.status()` sin credenciales, `docker-compose.yml:49-52`), la URI y los scripts | A | A | Empezar el acceso por Redis ACL; en Mongo, o retirar `--replSet` (el código no usa transacciones, ver §6) o usar keyFile (válido en desarrollo); ensayar con una copia del volumen |
| 2 | **Embeddings sin internet** (descarga del modelo, ONNX en Windows) | M | A | Modelo local con descargas remotas desactivadas y su caché en una carpeta fija (se comprueba antes de la demo); contingencia: un JSON versionado con los vectores; respaldo léxico con `more_like_this` de Elasticsearch |
| 3 | **Regresión** en ≈ 240 pruebas y 13 scripts por las credenciales nuevas | M | A | `npm run test:*` (sin conexiones) en cada fusión; los `verificar:*` conectan a bases reales y necesitan cuenta propia: lista de los críticos |
| 4 | **La pista técnica se come el cierre** (11 de 20 pts no dependen del código nuevo) | A | A | MVP/*stretch*, congelación fija, pista C intocable |
| 5 | **Docker falla en el aula** (WSL2, puerto 6379 reservado por Hyper-V, RAM) | M | A | Videos de respaldo, segunda laptop, `REDIS_HOST_PORT`, `npm run test:resiliencia` |
| 6 | **Demo contaminada** (cuentas bajo vigilancia, barrido de 60 s, stock del producto #1, cliente Prisma viejo) | A | M | Cuentas de demo propias, reponer stock, lista de reinicio previa |
| 7 | **Documentos desfasados:** el ERD de arquitectura (§5), el README (sigue encabezando «Estado actual: Entrega 2») y `.env.example` con el outbox de ventas apagado (`VENTAS_OUTBOX_ENABLED=false`, `VENTAS_SYNC_ENABLED=false`: un clon limpio deja sin alimentar el panel de Cassandra) | A | M | Lista de chequeo del diagrama, prueba de deriva, un solo dueño de README/ESTADO; poner ambas banderas en `true` para la demo |
| 8 | **Sobre-afirmar la seguridad** (MySQL y Redis/Mongo publicados en todas las interfaces, Neo4j Community sin roles por servicio, secretos de desarrollo) | M | A | Modelo de amenazas con alcance declarado; publicar los puertos en `127.0.0.1`; decir los límites en voz alta |
| 9 | **Séptimo contenedor** (15,6 GB de RAM; Elasticsearch 1 GB + Cassandra 2 GB) | M | M | Vector dentro de un almacén que ya corre |
| 10 | **Alcance** (dirección semántica, IP) antes del MVP; fecha de revisión desconocida; otros exámenes | M | A | *Stretch* sólo después de `mvp-1`; plan para la fecha más temprana |

## 10. Decisiones abiertas y primeros pasos

**Para preguntarle al catedrático (lunes 26):**

1. ¿Cuándo es la revisión del proyecto, cuánto dura la presentación y se espera un informe de arquitectura aparte del repositorio? ¿En qué formato?
2. **Control de acceso:** ¿basta con la autorización a nivel de API (JWT + roles, que ya existe, endurecida y probada) o esperan además **cuentas de servicio en una base NoSQL** y/o una **ACL configurable desde la página**? (El plan cubre las dos capas —API y cuentas de servicio— y deja la ACL configurable como «ideal»; la respuesta define qué se prioriza si falta tiempo.)
3. **Vectorial:** ¿aceptan Elasticsearch con `dense_vector` + kNN como «alternativa con soporte vectorial» (el PRD dice «pgvector u alternativa»), o esperan pgvector/un componente dedicado? Plan B: índice vectorial de Neo4j (ya corre y se probó) o pgvector (12–16 h y un séptimo contenedor).

**Para decidir en el equipo:**

4. ¿Son 2 o 3 integrantes y quién lleva cada pista (V · S · C)? El PRD pide indicar la distribución.
5. ¿Se autoriza **bajar ~118 MB del modelo (una vez) e instalar `@huggingface/transformers`** en el backend? Es lo único del plan que necesita descarga. **Ojo con el tamaño real:** el paquete son ~10 MB, pero arrastra `onnxruntime-node` (~300 MB en disco, trae binarios de todas las plataformas), así que son ~430 MB en total; en la prueba previa se mira si basta una variante más liviana.
6. ¿Quién toca `config/redis.js` y `docker-compose.yml`? Hay trabajo de compañeros ahí: diff contra su último commit y reportar de quién es qué.
7. ¿Se agrega el campo `descripcion_larga` con textos sintéticos declarados (variante C de §3.5)?
8. ¿Neo4j queda sólo autenticado (sin roles) y se documenta como límite?
9. ¿Elasticsearch con seguridad y Cassandra con autenticación entran en el alcance o quedan como «ideal»?
10. **IP y direcciones:** ¿se registra la IP (hash HMAC o /24, 90 días) o se omite? ¿Se limpian las ~45 cuentas con «Calle de prueba 1-23» antes de cualquier señal por dirección?
11. **Replica set de Mongo:** ¿se implementa la transacción que prometió el ADR-003 o se retira `--replSet`? (Afecta a Mongo con auth y a la retrospectiva.)
12. `mem_limit` de Elasticsearch: medir en la prueba previa antes de subirlo (hoy 961/1024 MiB; el host tiene ~1,4 GB libres).
13. ¿Qué laptop lleva la demo y quién prepara la segunda?

**Primeros pasos propuestos (si aprueban el plan), en este orden:**

1. ✅ **Hecho el 2026-10-23:** los huecos de API 1–4 con su prueba de rol × endpoint (§4.4, paso 1; resultado en §4.1).
2. **Prueba previa del modelo de embeddings** (§3.8, paso 0): necesita la autorización de la decisión 5.
3. **Esqueleto del diagrama y de la retrospectiva** (la pista C arranca hoy; no depende de nada).
4. **Redis ACL** (§4.4, paso 2), con el manejo de errores de credencial de §4.3.
5. Backend y UI de «productos relacionados» (§3.8, pasos 1–4).

## 11. Fuera de alcance

- Reescribir o migrar bases existentes (los pagos siguen en MySQL: ADR-005); un séptimo contenedor sólo si el ADR-006 lo justifica con números.
- Modelos de recomendación colaborativos o entrenados (el mínimo es similitud por contenido + historial de búsqueda opcional); GPU; embeddings por API de pago.
- C4 nivel 4, servidor Structurizr, ATAM completo, automatizar la demo, herramientas externas de caos.
- Editar ADR aceptados (se *supersede* con uno nuevo).
- Control de acceso en **todas** las bases (se cubren las que el MVP define; el resto queda declarado como límite en el modelo de amenazas).
- Listas de permisos por usuario individual y listas de IP para clientes (los permisos son por rol y por cuenta de servicio; §4.0).

## 12. Fuentes

Citadas por los agentes de investigación. La mayoría las abrió el agente; las marcadas con † sólo se vieron en resultados de búsqueda. **Ábranlas todas antes de citarlas en el informe.**

**Elasticsearch 8.15 y vectores:** [kNN](https://www.elastic.co/guide/en/elasticsearch/reference/8.15/knn-search.html) · [dense_vector](https://www.elastic.co/guide/en/elasticsearch/reference/8.15/dense-vector.html) · [API de sinónimos](https://www.elastic.co/guide/en/elasticsearch/reference/8.15/put-synonyms-set.html) · [synonym_graph](https://www.elastic.co/guide/en/elasticsearch/reference/8.15/analysis-synonym-graph-tokenfilter.html) · [more_like_this](https://www.elastic.co/guide/en/elasticsearch/reference/8.15/query-dsl-mlt-query.html) · [RRF (licencia)](https://www.elastic.co/guide/en/elasticsearch/reference/8.15/rrf.html) · [privilegios](https://www.elastic.co/guide/en/elasticsearch/reference/8.15/security-privileges.html) · [API keys](https://www.elastic.co/guide/en/elasticsearch/reference/8.15/security-api-create-api-key.html) · [seguridad gratuita](https://www.elastic.co/blog/security-for-elasticsearch-is-now-free).

**Otros almacenes:** [pgvector](https://github.com/pgvector/pgvector) · [MySQL 9.7: funciones vectoriales](https://dev.mysql.com/doc/refman/9.7/en/vector-functions.html) · [Cassandra 5.0: vector search](https://cassandra.apache.org/doc/5.0/cassandra/vector-search/vector-search-working-with.html) · [Cassandra: seguridad](https://cassandra.apache.org/doc/5.0/cassandra/managing/operating/security.html) · [Redis 8](https://redis.io/blog/redis-8-ga/) · [Redis ACL](https://redis.io/docs/latest/operate/oss_and_stack/management/security/acl/) · [Qdrant](https://github.com/qdrant/qdrant) · [LanceDB](https://github.com/lancedb/lancedb) · [Milvus](https://github.com/milvus-io/milvus) · [Weaviate](https://github.com/weaviate/weaviate) · [Chroma](https://docs.trychroma.com/docs/overview/getting-started).

**Modelos de embeddings:** [multilingual-e5-small](https://huggingface.co/intfloat/multilingual-e5-small) · [versión ONNX](https://huggingface.co/Xenova/multilingual-e5-small/tree/main/onnx) · [paraphrase-multilingual-MiniLM-L12-v2](https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2) · [bge-m3](https://huggingface.co/BAAI/bge-m3) · [embeddinggemma](https://huggingface.co/google/embeddinggemma-300m) · [Transformers.js en Node](https://huggingface.co/docs/transformers.js/en/tutorials/node) · [Transformers.js `env`](https://huggingface.co/docs/transformers.js/en/api/env) · [Claude: embeddings](https://platform.claude.com/docs/en/build-with-claude/embeddings).

**Recomendaciones y fraude:** [Shopify: recomendaciones](https://shopify.dev/docs/api/ajax/reference/product-recommendations) · [Airbnb: embeddings de anuncios†](https://airbnb.tech/wp-content/uploads/sites/19/2024/12/Learning-and-Applying-Airbnb-Listing-Embeddings-.pdf) · [Etsy†](https://arxiv.org/abs/2306.04833) · [Pinterest Related Pins†](https://arxiv.org/abs/1702.07969) · [Zalando†](https://arxiv.org/abs/1609.02489) · [libpostal](https://github.com/openvenues/libpostal) · [Stripe Radar: reglas](https://docs.stripe.com/radar/rules/reference) · [inversión de embeddings (Morris et al.)†](https://arxiv.org/abs/2310.06816).

**Control de acceso:** [Neo4j: autenticación y autorización](https://neo4j.com/docs/operations-manual/5/authentication-authorization/) · [MongoDB: keyFile](https://www.mongodb.com/docs/manual/core/security-internal-authentication/) · [MongoDB: localhost exception](https://www.mongodb.com/docs/manual/core/localhost-exception/) · [OWASP API Top 10 2023](https://api-security.owasp.org/editions/2023/en/0x11-t10) · [Casbin](https://casbin.apache.org/docs/overview/) · [OPA](https://www.openpolicyagent.org/docs) · [OpenFGA](https://openfga.dev/docs/fga) · [Keycloak Authorization Services](https://www.keycloak.org/docs/latest/authorization_services/index.html) · [Docker: publicación de puertos](https://docs.docker.com/engine/network/port-publishing/) · [Docker Compose: secretos](https://docs.docker.com/compose/how-tos/use-secrets/) · [Vault: bases de datos](https://developer.hashicorp.com/vault/docs/secrets/databases) · [MongoDB sin contraseña, 2017†](https://securityaffairs.com/62717/cyber-crime/mongodb-ransom-attacks.html) · [«Meow», 2020†](https://www.bleepingcomputer.com/news/security/new-meow-attack-has-wiped-dozens-of-unsecured-databases/).

**Diagrama, retrospectiva y presentación:** [C4 model](https://c4model.com/) · [Mermaid: flowchart](https://mermaid.js.org/syntax/flowchart.html) · [mermaid-cli](https://github.com/mermaid-js/mermaid-cli) · [Structurizr](https://docs.structurizr.com/) · [Fowler: persistencia políglota](https://martinfowler.com/bliki/PolyglotPersistence.html) · [Discord: índices de mensajes](https://discord.com/blog/how-discord-indexes-billions-of-messages) · [Shopify: pods](https://shopify.engineering/a-pods-architecture-to-allow-shopify-to-scale) · [Stripe: idempotencia](https://stripe.com/blog/idempotency) · [Stripe: migraciones en línea](https://stripe.com/blog/online-migrations) · [transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html) · [ADR (Nygard)](https://www.cognitect.com/blog/2011/11/15/documenting-architecture-decisions) · [ADR (Microsoft)](https://learn.microsoft.com/en-us/azure/well-architected/architect-role/architecture-decision-record) · [Radar de ThoughtWorks](https://www.thoughtworks.com/radar) · [fitness functions](https://www.thoughtworks.com/insights/articles/fitness-function-driven-development) · [cuadrante de deuda técnica](https://martinfowler.com/bliki/TechnicalDebtQuadrant.html) · [posmortem sin culpa (SRE)](https://sre.google/sre-book/postmortem-culture/) · [Segment: «Goodbye microservices»](https://www.twilio.com/en-us/blog/developers/best-practices/goodbye-microservices/) · [Shopify: monolito modular](https://shopify.engineering/deconstructing-monolith-designing-software-maximizes-developer-productivity) · [Discord: Cassandra → ScyllaDB](https://discord.com/blog/how-discord-stores-trillions-of-messages) · [Uber: Postgres → MySQL](https://www.uber.com/blog/postgres-to-mysql-migration/) · [Instacart: Elasticsearch → Postgres + pgvector](https://www.infoq.com/news/2025/08/instacart-elasticsearch-postgres) · [assertion-evidence](https://www.assertion-evidence.com/) · [principios del caos](https://principlesofchaos.org/).
