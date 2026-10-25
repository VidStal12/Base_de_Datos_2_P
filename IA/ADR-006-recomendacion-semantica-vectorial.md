# ADR-006 — Recomendación semántica: vectores en Elasticsearch (Entrega Final)

**Fecha:** 2026-10-25
**Estado:** Implementado y verificado contra el catálogo real: modelo local, campo vectorial en el índice, consulta kNN con reglas de negocio, ruta pública, sección en la ficha del producto, respaldo por subcategoría y evaluación repetible (`npm run verificar:similares`).

> Cubre el ítem «Recomendación semántica / búsqueda vectorial» de la Entrega Final (5 pts): embeddings reales de los productos, una consulta de similitud y una decisión de componente defendida con datos. Plan y estimaciones en [PLAN-ENTREGA-FINAL.md](PLAN-ENTREGA-FINAL.md) §3.

---

## 1. Contexto

El PRD pide generar embeddings de las descripciones y responder consultas de similitud, y el catedrático planteó la duda de fondo: *¿extensión de la base relacional o un componente vectorial dedicado?* (audio del 2026-10-21, [PLAN §1](PLAN-ENTREGA-FINAL.md)); de lo semántico dijo que «pueden utilizar Elastic».

Lo que hace difícil el problema aquí:

- **Los textos son títulos.** `descripcion` mide 21 caracteres de mediana («Camiseta polo clásica»). No hay párrafos que comparar.
- **El catálogo de desarrollo es pequeño:** 121 documentos en el índice, 106 del catálogo real activo (sin los productos que dejan los scripts de verificación), 16 subcategorías, dos vendedores reales (Luis, 55 productos; Marta, 52).
- **Restricciones del proyecto:** la demo debe funcionar sin internet ni claves de pago; el host tiene poca memoria libre (~2,6 GB); ya hay seis componentes en marcha; cualquier componente puede apagarse y la aplicación sigue ([ENTREGA-3-CONSISTENCIA.md §7](ENTREGA-3-CONSISTENCIA.md)); trabajan dos o tres personas.

Lo que había antes de los vectores, medido sobre los mismos 106 productos (`npm run verificar:similares`, §4):

| «Productos parecidos» con… | Resultado |
|---|---|
| BM25 (el título como consulta) | **15 de 106 productos sin ningún vecino**; precisión@5 71,1 % entre los que sí tienen |
| `more_like_this` con sus valores por defecto | **0 de 106** devuelven algo (`min_term_freq=2` y `min_doc_freq=5` no sirven con títulos de ~21 caracteres) |
| 14 consultas coloquiales («celular», «bici», «pants»…) en el buscador por texto | **10 de 14 no encuentran nada**; ninguna se resuelve (≥ 4 de 5 correctos) |

## 2. Alternativas consideradas

«Probado» = se ejecutó con las imágenes del proyecto; «documentación» = solo se leyó, no se construyó (las estimaciones de horas son del plan).

| Opción | Cómo encajaría | Por qué no / sí |
|---|---|---|
| **A. Elasticsearch `dense_vector` + kNN** (probado) | Campo `embedding` en el índice que ya existe; reutiliza sincronización, cortacircuitos, salud y respaldo; kNN **con filtros dentro de la búsqueda** | **Elegida.** 0 contenedores nuevos; el catedrático la nombró |
| B. `more_like_this` / BM25 (medido) | Una consulta en `busquedaService` | Es la línea base de §1: deja 15 productos sin vecino y el MLT por defecto no devuelve nada |
| C. pgvector (documentación) | Contenedor `pgvector/pgvector` + copia del catálogo + sincronización Mongo→Postgres | Es lo que nombra el PRD, pero añade el 7.º componente y una segunda copia del catálogo, y obliga a rehacer los filtros de estado y vendedor. Queda como plan B |
| D. MySQL (documentación) | — | 8.4 no tiene el tipo `VECTOR`; en 9.x `DISTANCE()` es de HeatWave, no de Community. No habría consulta de similitud en la base |
| E. Cassandra 5 SAI / Neo4j 5 índice vectorial (Neo4j, probado por el agente) | `ANN OF` / `db.index.vector.queryNodes` | Funcionan, pero cada uno es una copia derivada de *otro* dominio (panel de ventas, grafo de fraude): acoplarían la vitrina a esos componentes. Neo4j queda como mejor candidato para direcciones |
| F. Redis 7 / MongoDB 7 (documentación) | — | `redis:7` es 7.4 sin módulos (`VADD`/`FT.*` no existen); MongoDB 7 no tiene `$vectorSearch` |
| G. Dedicado: Qdrant, Weaviate, Milvus, Chroma, LanceDB (documentación) | Herramienta específica | 7.º componente y 3.ª copia del catálogo para ~100 filas |
| H. Coseno en Node con los vectores en Mongo (medido) | 0,12 ms con 106×384; 4,8 ms con 10 k; 49 ms con 100 k | Sirve a esta escala, pero obliga a guardar los vectores en Mongo y mantener una segunda implementación de la similitud. Descartada también como respaldo |

## 3. Decisión

**A: vectores de `multilingual-e5-small` calculados localmente en Node y guardados solo en Elasticsearch, con el filtrado de visibilidad dentro de la consulta kNN.**

### 3.1 Modelo
`Xenova/multilingual-e5-small` (ONNX cuantizado a 8 bits, base `intfloat/multilingual-e5-small`, licencia MIT; 384 dimensiones, ~100 idiomas), ejecutado con `@huggingface/transformers` 4.3.1 + `onnxruntime-node` 1.30.0 **dentro del proceso del backend**. Ningún texto sale de la máquina y no hace falta una clave ni conexión: el servicio carga el modelo con `env.allowRemoteModels = false` desde `backend/modelos/` (fuera de git).

- El repositorio (`backend/src/config/embeddingsModelo.js`) fija la **revisión** del modelo y el tamaño y SHA-256 de cada archivo; `npm run modelo:descargar` baja lo que falta y no da por buena una descarga cortada o distinta (`.parcial` → comprobar → renombrar); `npm run modelo:verificar` solo comprueba. Son 5 archivos, ≈135 MB (el modelo, 112,8 MiB; el tokenizador, 16,3 MiB).
- E5 exige un prefijo en cada texto. Su tarjeta recomienda `query: ` para las tareas simétricas, como la similitud semántica, y `query: `/`passage: ` para recuperación asimétrica. Para «parecido a» (documento contra documento) se usa `query: ` **en los dos lados**: con `passage: ` en ambos la precisión@5 bajó de 90,0 % a 85,3 % (medido). El prefijo lo agrega `embeddingService`, así que ningún llamador puede olvidarlo.
- Medido en esta máquina (Windows 11): carga ≈ 0,8–0,9 s; ≈ 500 MB de memoria residente con el modelo cargado (+400 MB), hasta ~680 MB tras lotes grandes; 2,5–3,8 ms por título. Liberar el modelo (`dispose()`) devuelve solo ~150 MB porque el runtime nativo sigue residente, así que se carga una vez y se queda. **Leer** los relacionados no lo necesita (el vector ya está en el índice): solo se carga al crear o editar un producto y al reconstruir el índice.

### 3.2 Qué se incrusta
`título. subcategoría. categoría.` (variante **B**). Solo el título (**A**) dio precisión@5 de 64,7 %; con la subcategoría y la categoría, 90,0 %. **Ojo, fuga de etiqueta:** la subcategoría es justo lo que se usa para medir, así que parte de esa diferencia es la pista y no «entendimiento»; por eso §4 incluye consultas coloquiales y una muestra para juzgar a ojo, que no dependen de esa pista.

### 3.3 Dónde viven los vectores y cómo se mantienen
- Campo `embedding`: `dense_vector`, 384 dimensiones, coseno, `int8_hnsw` (el tipo por defecto de 8.15). **Solo en Elasticsearch**: Mongo no guarda copia. El documento de búsqueda ya era una copia derivada del catálogo y se reconstruye con `npm run busqueda:backfill`, que recalcula cada vector (121 productos, 5 s) y **se detiene antes de tocar nada si falta el modelo**.
- Se agrega al índice que ya existe con `putMapping` (válido en 8.15); `dynamic: 'strict'` se conserva y `tests/busquedaMapping.test.js` obliga a que `aDocumento()` y el mapping se muevan juntos.
- **Tres reglas**, cada una con su prueba, porque se comprobó contra el motor real que el riesgo existe:
  1. *Un `index` completo sin vector lo borra.* Por eso `indexarProducto` recalcula el vector en cada alta o edición; si el modelo no está, hace un `update` parcial con `doc_as_upsert` **sin** ese campo: cambia todo menos el vector. Comprobado en vivo: con el modelo ausente, un producto editado conservó sus 384 valores idénticos y los demás campos sí cambiaron.
  2. *Un vector dentro de `_source` pesa 13 veces más* (509 KB contra 37 KB para 60 productos): toda consulta que no lo necesita lo excluye (`_source.excludes`).
  3. *El modelo es parte de la preparación de la demo:* `npm run modelo:verificar` lo comprueba.

### 3.4 La consulta y sus reglas de negocio
`GET /api/productos/:id/relacionados` (pública con sesión opcional, declarada en la lista blanca de [ADR-007](ADR-007-control-de-acceso.md)). Dos consultas baratas: leer el vector del producto por id y buscar sus vecinos (`knn` sobre `embedding`). Los filtros van **dentro** de la búsqueda de vecinos, no sobre los k más cercanos, para que lo oculto no les quite lugar a los que sí se muestran: solo `estado: activo`; sin el propio producto; sin vendedores suspendidos; con sesión, sin los productos del propio vendedor (nadie compra lo que él mismo vende). `similarity` es el coseno mínimo del §3.6.

Con los candidatos (hasta 24) se aplica `reglasRelacionados.elegir()`: sin repetidos (mismo título normalizado, ni el del propio producto), **lo agotado al final** —con el stock de hoy: el índice no se entera de las ventas, así que se relee de Mongo, una consulta para todos—, **un vendedor ocupa a lo sumo la mitad de la lista** (con 6 lugares, 3) y se muestran hasta 6. El tope es relativo y no «2 por vendedor» porque el catálogo de desarrollo tiene dos vendedores reales con tres productos parecidos cada uno por subcategoría.

### 3.5 Degradación (lo ya construido se conserva)
`catalogoLecturaService.relacionados()`:

| Situación | Resultado (medido en vivo, §4) |
|---|---|
| Todo sano | `modo: 'semantico'`, del índice |
| Menos de 2 parecidos, o el producto aún no tiene vector | `modo: 'subcategoria'` (Mongo): «Misma subcategoría: Laptops» |
| Elasticsearch apagado | `modo: 'subcategoria'`; el aviso global del encabezado lo dice |
| Mongo apagado | `modo: 'semantico'` igual: todo sale del índice (el stock queda con el valor del índice) |
| Ambos apagados | 503 claro; la ficha tampoco puede mostrarse, y la sección no deja nada en la página |
| Menos de 2 resultados en todas las capas | `modo: 'ninguno'`: la sección se oculta («mejor nada que algo sin relación») |

### 3.6 El umbral de coseno: 0,90
Los vectores de e5 se agrupan en una franja angosta: con los vectores guardados, los pares de **otra subcategoría** tienen coseno mediano 0,85 (p95 0,90) y los de la **misma** 0,93 (p5 0,90), y las colas se solapan. Un valor de 0,80 «parece alto» y deja pasar casi todo. Se eligió **0,90**, el punto en que un vecino pasa a ser más probablemente de la misma subcategoría que de otra (51 %; con 0,88 es 27 %):

| τ | productos con ≥ 2 vecinos | vecinos de la misma subcategoría |
|---|---|---|
| 0,86 | 100 % | 16,5 % |
| 0,88 | 100 % | 27,0 % |
| **0,90** | **96,2 %** | **51,2 %** |
| 0,92 | 82,1 % | 80,8 % |
| 0,94 | 44,3 % | 94,7 % |

Los 4 productos que quedan por debajo de 2 vecinos (sartén, olla, manguera, sombrilla) se resuelven con la subcategoría. El umbral depende del modelo y del catálogo: si cambian, `npm run verificar:similares` imprime esta tabla y se revisa.

## 4. Evidencia

Todo sale de `npm run verificar:similares` (contra el catálogo real ya indexado), de la suite de pruebas y de pruebas en vivo con los contenedores.

**Calidad** (106 productos; etiqueta automática = subcategoría; sin los productos de prueba):

| Medida | Vectores (camino real) | BM25 | `more_like_this` por defecto |
|---|---|---|---|
| Productos con ≥ 2 parecidos | 102 de 106 (96,2 %); los otros 4, por subcategoría → **0 sin sección** | 91 de 106 con ≥ 1 | 0 de 106 |
| Precisión@5 | **91,2 %** | 71,1 % | — |
| Hit@5 / MRR | 100 % / 0,959 | — | — |
| Latencia de `similares()` | p50 9 ms · p95 13 ms | — | — |
| Solo el título (A) / con subcategoría y categoría (B), coseno exacto | 64,7 % / 90,0 % | | |

**Consultas coloquiales** (≥ 4 de 5 correctos = «resuelta»): el buscador por texto resuelve **0 de 14** (no encuentra nada en 10); los vectores resuelven **6 de 14**:

| Resueltas por vectores | Parciales | No resueltas |
|---|---|---|
| «celular», «bici», «auriculares», «pesas para el gimnasio», «pants» (5/5); «plantas y macetas» (4/5) | «chumpa» 3/5, «tele» 3/5, «cacerola» 2/5, «sillón para la sala» 2/5 | «playera» 1/5, «tenis» 1/5, «compu» 0/5, «pelota» 0/5 |

**Reglas de visibilidad contra el motor real** (1 078 vecinos revisados): ninguno es el propio producto, ninguno es de los 12 inactivos, con la sesión del vendedor 2 no se le ofrece nada suyo y ninguna respuesta devuelve el vector.

**En vivo** (backend y frontend en marcha, contenedores detenidos y vueltos a iniciar): con Elasticsearch apagado, `modo: 'subcategoria'` en 8–19 ms y el banner explica el cambio; con solo Mongo apagado, sigue `modo: 'semantico'`; con ambos apagados, 503; al volver, todo se recupera sin reiniciar el backend. Navegar de un relacionado a otro rehace la lista.

**Pruebas:** 66 pruebas nuevas (`npm run test:similares`: reglas, forma de las consultas, cadena de capas, contrato del modelo, indexado sin pisar el vector) + 2 del mapping; la suite completa del backend (401) pasa. De 52 mutaciones deliberadas sobre las protecciones nuevas, 51 las detecta alguna prueba; la que sobrevive es equivalente (el propio producto se descarta dos veces, por id y por título, y la primera es redundante a propósito).

## 5. Límites y hallazgos honestos

- **La etiqueta mide la pista.** Ver §3.2: 90 % es una medida optimista de «entender»; el 64,7 % de solo-título es la cota de abajo, y la sección 8 de la salida de `verificar:similares` imprime una muestra para juzgar a ojo. El plan pide además que dos personas juzguen 20–30 productos (nDCG@5): **no se hizo**; la muestra está lista para que lo haga el equipo.
- **Vecinos por palabra suelta.** «Laptop económica» → «Televisor económico HD»; «Audífonos plegables de viaje» → «Smartphone plegable». Un modelo pequeño cuantizado se agarra de la palabra cuando el título es corto.
- **Jerga regional.** «playera», «compu», «pelota» y «tenis» no se resuelven: es donde los **sinónimos** de Elasticsearch (`synonym_graph`, extra del plan §3.7) aportan lo que los vectores no.
- **Los productos de prueba** que dejan los scripts de verificación están en el índice como activos y aparecen entre los relacionados en el entorno de desarrollo; la evaluación los excluye por nombre.
- **Memoria.** +400 MB cuando se carga el modelo (al crear o editar un producto). Elasticsearch, además, trabaja casi en su límite (961 MiB de 1 GiB): no se tocó `mem_limit`.
- **El vector queda con el texto anterior** si se edita un producto mientras falta el modelo, hasta el siguiente `busqueda:backfill`.
- El umbral y la etiqueta son del catálogo de hoy (106 productos, 16 subcategorías, tres de cada vendedor).

## 6. Consecuencias

(+) Funciona sin internet; Mongo no cambia; los relacionados siguen aunque Mongo esté apagado; 0 contenedores nuevos; salud, cortacircuitos y banner ya existían. Escala sin cambiar la API de decenas a cientos de miles de productos (HNSW).
(−) El modelo (~135 MB) vive fuera del repositorio y reconstruir el índice exige tenerlo; cambiar de modelo obliga a reindexar; si Elasticsearch cae, los relacionados pasan de «por significado» a «de la misma subcategoría». Se reabre si el catálogo supera ~100 k productos, aparecen filtros relacionales complejos o varios servicios consumen vectores (→ pgvector o Qdrant).

## 7. Fuera de alcance / siguiente

Sinónimos en Elasticsearch (extra, lo sugirió el catedrático); respaldo semántico para búsquedas con 0 resultados; «lo relacionado con lo que buscó antes» usando estos vectores; `descripcion_larga` sintética; señal de fraude por direcciones parecidas (el catedrático la llamó «bastante chilero»; los embeddings son malos con números, la receta es híbrida: [PLAN §3.7](PLAN-ENTREGA-FINAL.md)); reranker, imágenes (CLIP), *fine-tuning*, RRF/ELSER/`semantic_text` (no existen en la licencia Basic).

## 8. Cómo reproducirlo

```bash
cd backend
npm run modelo:descargar    # una vez (~135 MB, necesita internet solo esta vez)
npm run modelo:verificar    # tamaño y SHA-256 de cada archivo
npm run busqueda:backfill   # recalcula el vector de cada producto
npm run verificar:similares # la evaluación de este documento
npm run test:similares      # las pruebas
```

Fuentes consultadas: la tarjeta del modelo [`intfloat/multilingual-e5-small`](https://huggingface.co/intfloat/multilingual-e5-small) (licencia MIT y uso de los prefijos `query:`/`passage:`) y el repositorio [`Xenova/multilingual-e5-small`](https://huggingface.co/Xenova/multilingual-e5-small) (archivos ONNX, tamaños y huellas, vía su API); el resto de las fuentes, en [PLAN-ENTREGA-FINAL.md §12](PLAN-ENTREGA-FINAL.md).
