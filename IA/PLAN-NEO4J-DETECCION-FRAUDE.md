# Plan — Neo4j para detección de fraude (Entrega 2)

> Creado: 2026-09-08. **Actualizado 2026-09-08: implementado y verificado.** Infraestructura, sincronización en vivo (checkout + reseñas), backfill histórico, las dos consultas y el panel en `/admin/fraude` — todo corriendo contra datos reales, no solo diseñado. Detalle de la verificación al final de este documento (§12) y en ESTADO-PROYECTO.md.

## 1. Por qué esto y por qué ahora

El PRD exige implementar **al menos una** familia entre grafos y columnar (§5, Entrega 2) — eso ya está satisfecho con Cassandra ([ADR-004](ADR-004-analitica-ventas-cassandra.md)). Neo4j acá no es para cumplir un mínimo del PRD: es una decisión del equipo de sumar la segunda familia, con un propósito propio (detección de fraude) distinto del panel de ventas.

ADR-004 §8 ya dejaba las condiciones escritas para cuándo tendría sentido retomar grafos: reseñas persistidas, una consulta real de varios saltos, datos de demostración identificados como sintéticos, y una estrategia de sincronización recuperable. Las reseñas ya existen (`Resena.js`/`resenaService.js`, 2026-09-08) — la primera condición ya no es hipotética.

Este documento reemplaza la parte de diseño de grafos que quedó en [ENTREGA-2-PLAN.md](ENTREGA-2-PLAN.md), secciones 4.3 y 4.4 (marcadas ahí como propuesta histórica aplazada), y la de [ADR-004](ADR-004-analitica-ventas-cassandra.md), sección 8 "Cuándo incorporar grafos". Cassandra sigue exactamente como está — esto no la toca ni la reemplaza, se suman las dos familias.

## 2. Qué cambió desde el diseño original, y por qué importa

El diseño de agosto (`ENTREGA-2-PLAN.md §4.4` original) tenía una inconsistencia real que ADR-004 encontró: la reseña exigía compra previa (§4.3), pero la consulta de ejemplo buscaba reseñas **sin** compra (`NOT (u)-[:COMPRÓ]->(p)`) como señal de fraude — un caso que el propio flujo nunca podía producir.

Esa inconsistencia ya no existe, pero no porque se haya resuelto en el diseño — se resolvió en el código, sin querer, como efecto de otro trabajo: `resenaService.crear()` ahora exige una compra con pago aprobado antes de dejar reseñar ([ver el fix de hoy](ESTADO-PROYECTO.md), motivado por combatir cuentas bot que inflan una calificación, no por este documento). Consecuencia directa: **"reseñó sin comprar" ya no es una señal que este sistema pueda producir bajo uso normal** — la aplicación la previene antes de que llegue a la base, con más fuerza de la que daría una consulta periódica en Neo4j. Mantener esa cláusula en la consulta de grafos sería preguntar algo que ya sabemos que da vacío siempre.

Esto no mata la idea original — el patrón de fondo (cuentas que reseñan en bloque, de forma coordinada) sigue siendo una señal real de fraude, incluso entre reseñas de compras legítimas (un vendedor puede comprar sus propios productos con varias cuentas y dejarse reseñas cruzadas). §3 adapta la consulta original quitando la cláusula que ya no aplica, no la descarta.

Además, el 2026-09-08 se planteó una segunda señal, complementaria y de alcance más amplio — no depende de reseñas en absoluto, solo de compras (que ya existen como dato real, sin nada nuevo que construir primero): ver §4.

## 3. Señal A — reseñas coordinadas (adaptada del diseño original)

**Qué detecta:** cuentas distintas que reseñan el mismo conjunto de productos, en una ventana de tiempo corta, con calificaciones altas — el patrón de "granja de reseñas" o de un vendedor reseñándose a sí mismo con cuentas alternativas. Como una reseña ya exige una compra real, esto detecta coordinación entre compradores verificados, no cuentas falsas sin compra (esas ya las bloquea la aplicación).

```cypher
MATCH (u1:Usuario)-[r1:RESEÑÓ]->(p:Producto)<-[r2:RESEÑÓ]-(u2:Usuario)
WHERE u1.id_usuario < u2.id_usuario          // evita contar el mismo par dos veces (u1,u2) y (u2,u1)
  AND abs(duration.between(r1.fecha, r2.fecha).seconds) < 3600
  AND r1.calificacion >= 4 AND r2.calificacion >= 4
WITH u1, u2, count(DISTINCT p) AS productosCompartidos
WHERE productosCompartidos >= 3
RETURN u1.nombre, u2.nombre, productosCompartidos
ORDER BY productosCompartidos DESC
```

Diferencia con la versión de agosto: se quitaron las dos cláusulas `NOT (u)-[:COMPRÓ]->(p)` (ya no pueden ser verdaderas nunca, ver §2) y se cambió `u1 <> u2` por `u1.id_usuario < u2.id_usuario` — la versión original contaba cada par dos veces (una vez como (u1,u2) y otra como (u2,u1)), un error de conteo que no se había notado porque la consulta nunca llegó a correr contra datos reales.

## 4. Señal B — desviación del patrón de compra propio (nueva, no depende de reseñas)

**Qué detecta:** una compra que no se parece en nada al historial de la propia cuenta — categoría nueva, vendedor nuevo, Y una dirección de envío o método de pago que **ya está asociado a otra cuenta distinta**. Cualquiera de esas señales sola es débil (un cliente real prueba categorías nuevas todo el tiempo); la combinación — sobre todo compartir dirección/método de pago con una cuenta ajena — es la que se acerca a "esta cuenta puede estar tomada o ser parte de una red de cuentas relacionadas".

Esto exige extender el modelo con dos nodos que hoy no estaban en el diseño de grafos: `Direccion` y `MetodoPago`. Sin ellos, "dos cuentas comparten una dirección" no es una pregunta que se pueda hacer — y es exactamente el tipo de traversal multi-salto que el PRD pide, más genuino que una comparación de un solo campo.

```cypher
// Direcciones o métodos de pago usados por más de una cuenta — de por sí ya
// es una señal (cuentas "independientes" que en realidad comparten datos de
// envío/pago), sin necesitar ninguna otra condición.
MATCH (u1:Usuario)-[:ENVIÓ_A]->(d:Direccion)<-[:ENVIÓ_A]-(u2:Usuario)
WHERE u1.id_usuario <> u2.id_usuario
RETURN d.id_direccion AS direccion, collect(DISTINCT u1.nombre) AS cuenta1, collect(DISTINCT u2.nombre) AS cuenta2
```

```cypher
// Señal compuesta: una compra en una categoría que esta cuenta nunca tocó
// antes, Y una dirección de envío que otra cuenta distinta también usó.
MATCH (u:Usuario)-[c:COMPRÓ]->(p:Producto)
WHERE NOT EXISTS {
  MATCH (u)-[:COMPRÓ]->(otro:Producto)
  WHERE otro.subcategoria = p.subcategoria AND otro <> p AND c.fecha > otro.fecha
}
MATCH (u)-[:ENVIÓ_A]->(d:Direccion)<-[:ENVIÓ_A]-(otraCuenta:Usuario)
WHERE otraCuenta.id_usuario <> u.id_usuario
RETURN u.nombre, p.descripcion, d.id_direccion, otraCuenta.nombre, c.fecha
ORDER BY c.fecha DESC
```

## 5. Modelo de nodos y relaciones

```
(:Usuario {id_usuario, nombre, rol})
(:Producto {producto_id, descripcion, subcategoria})
(:Direccion {id_direccion})
(:MetodoPago {id_metodo_pago})

(:Usuario)-[:COMPRÓ {fecha, monto}]->(:Producto)
(:Usuario)-[:RESEÑÓ {calificacion, fecha}]->(:Producto)
(:Usuario)-[:ENVIÓ_A]->(:Direccion)
(:Usuario)-[:PAGÓ_CON]->(:MetodoPago)
```

Un solo label `:Usuario` con `rol` como propiedad, no `:Comprador`/`:Vendedor` separados — un vendedor sigue siendo un usuario, y separar labels no agrega nada que `rol` no resuelva ya (mismo criterio que `usuarios.rol_id` en MySQL, no dos tablas paralelas).

`Direccion`/`MetodoPago` llevan solo el id — no se copian datos personales (dirección real, últimos 4 dígitos, etc.) al grafo; lo único que importa acá es la identidad del nodo para poder preguntar "¿cuántas cuentas distintas apuntan a este mismo id?", no mostrar el dato en sí. Igual criterio que ya usa Cassandra con las ventas (ADR-004 §3: "no se copian usuarios, direcciones ni instrumentos de pago").

## 6. Sincronización

Mismo criterio ya establecido en el proyecto (ADR-002 §3.3, reenvío de mejor esfuerzo) — no la versión de outbox durable que sí se justificó para ventas (ADR-004 §5). La diferencia: si una compra tarda unos segundos de más en aparecer en el grafo de fraude, no pasa nada grave (es una revisión periódica, no una consulta que alguien espera en el momento, a diferencia de un pago). Si más adelante se decide que las señales de fraude necesitan la misma garantía dura que las ventas, migrar al mismo patrón de outbox es directo — ya existe el ejemplo funcionando.

- `checkoutService.checkout()` y `checkoutService.checkoutOferta()`: después de confirmar la compra (mismo punto donde ya se reenvía a Mongo/Redis/outbox de ventas), reenviar de mejor esfuerzo, por cada línea:
  ```cypher
  MERGE (u:Usuario {id_usuario:$usuarioId}) SET u.nombre=$nombre, u.rol=$rol
  MERGE (p:Producto {producto_id:$productoId}) SET p.descripcion=$descripcion, p.subcategoria=$subcategoriaId
  MERGE (d:Direccion {id_direccion:$direccionId})
  MERGE (m:MetodoPago {id_metodo_pago:$metodoPagoId})
  MERGE (u)-[c:COMPRÓ {detalle_id:$detalleId}]->(p)
    SET c.fecha=$fecha, c.monto=$monto, c.direccion_id=$direccionId, c.metodo_pago_id=$metodoPagoId
  MERGE (u)-[:ENVIÓ_A]->(d)
  MERGE (u)-[:PAGÓ_CON]->(m)
  ```
  El `MERGE` de `COMPRÓ` va con `detalle_id` (= `compra_detalle.id`, mismo identificador natural que ya usa el outbox de ventas) como parte de la clave — no solo los extremos de la relación. Sin eso, dos compras distintas del mismo producto por el mismo usuario (algo que pasa todo el tiempo, ver el historial real de Ana) colapsarían en una sola arista, y la Señal B necesita poder mirar cada compra por separado.
- `resenaService.crear()`: después de guardar la reseña, reenviar de mejor esfuerzo `MERGE (u)-[r:RESEÑÓ]->(p) SET r.calificacion=$calificacion, r.fecha=$fecha` — acá sí alcanza con los extremos, sin clave extra: el índice único de `Resena.js` ya garantiza una sola reseña por (producto, usuario), así que una sola arista por par es lo correcto, no una pérdida de datos.
- `MERGE`, no `CREATE`, en todos los casos — reintentar un reenvío que ya se aplicó no debe duplicar nodos ni relaciones (mismo principio de idempotencia que ya rige en Cassandra, ADR-004 §4).
- **Datos históricos:** el checkout/reseña en vivo solo cubre lo que pase de acá en adelante — lo ya existente en MySQL/Mongo necesita un backfill (`backend/scripts/backfillNeo4j.js`, mismo patrón de paginación que `ventasSyncService.backfillHistorico()`) que recorre `compra_detalle` (con pago aprobado) y `Resena`, llamando a las mismas funciones de `fraudeSyncService.js` que usa el camino en vivo — no una segunda implementación que se pueda desalinear de la primera.

## 7. Panel administrativo

Pantalla nueva en `/admin/fraude` (o una sección dentro de `/admin/ventas`), mismo estilo que el widget "Productos más editados" (`AdminDashboardPage.jsx`) y el panel de ventas (`AdminVentasPage.jsx`): corre las dos consultas de §3/§4 y lista los pares/patrones señalados, con link a cada producto y cuenta involucrada. Solo `administrador` — mismo criterio de rol que `/admin/ventas`.

Explícitamente **una señal no es una acusación** — el panel muestra candidatos para revisión humana, no suspende cuentas automáticamente. Vale dejarlo dicho en la UI misma, no solo en este documento.

## 8. Datos sembrados a propósito

Con el catálogo y las cuentas de prueba actuales, ninguna de las dos consultas va a encontrar nada — hace falta sembrar el patrón, documentado como sintético (mismo criterio ya aplicado para el competidor de Marta en recomendaciones, ENTREGA-2-PLAN.md §4.5):

- **Señal A:** 2-3 cuentas de prueba nuevas, cada una con una compra real (para poder reseñar) de los mismos 3+ productos, con reseñas de calificación alta dentro de la misma hora.
- **Señal B:** una cuenta de prueba con una compra en una categoría/vendedor que nunca tocó antes, usando una dirección ya asociada a otra cuenta de prueba existente.

Va en un script de verificación (`backend/scripts/verificarFraudeNeo4j.js`, mismo espíritu que `verificarRecomendaciones.js`), no en `seed.js` — a diferencia del competidor de Marta (que sirve al catálogo en general), estos datos existen solo para que esta consulta puntual tenga algo que encontrar, y decir eso explícitamente en el informe importa tanto como el resultado de la consulta.

## 9. Infraestructura

- `docker-compose.yml`: servicio `neo4j` nuevo (imagen `neo4j:5`, puertos `7474` HTTP/`7687` Bolt, `NEO4J_AUTH=neo4j/<password>`, volumen para no perder el grafo entre reinicios — a diferencia de Redis, acá sí interesa que sobreviva un restart mientras se prueba).
- `backend/package.json`: dependencia `neo4j-driver`.
- `backend/src/config/neo4j.js`: conexión perezosa, mismo patrón que `config/redis.js`/`config/cassandra.js`.
- `backend/src/services/fraudeSyncService.js`: las funciones `MERGE` de §6.
- `backend/src/services/fraudeService.js`: corre las consultas de §3/§4, formatea el resultado para el panel.
- `backend/src/routes/adminRoutes.js`: `GET /api/admin/fraude`.
- `.env`/`.env.example`: `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`.

## 10. Parámetros ajustables (no bloquean el diseño, solo hay que fijar un valor)

| Parámetro | Default propuesto | Dónde |
|---|---|---|
| Ventana de tiempo para reseñas coordinadas | 3600s (1h) | Señal A |
| Mínimo de productos compartidos | 3 | Señal A |
| Mínimo de calificación para contar como "sospechosa" | 4 | Señal A |

## 11. Orden de trabajo sugerido

1. Confirmar este diseño (este documento).
2. `docker-compose.yml` + `config/neo4j.js` — infraestructura, sin lógica de negocio todavía.
3. `fraudeSyncService.js` + engancharlo en `checkoutService.js`/`resenaService.js`.
4. Datos sembrados (§8) + `verificarFraudeNeo4j.js` corriendo las dos consultas contra ellos.
5. `fraudeService.js` + endpoint + panel en `/admin`.
6. Actualizar ADR-004 §8 (nota fechada, no reescribir su análisis) y el mapeo de rúbrica en ENTREGA-2-PLAN.md.

---

## 12. Corrección real al diseño, encontrada al implementar

`Direccion`/`MetodoPago` (§5) **no** se clavaron por `id_direccion`/`id_metodo_pago` como decía el diseño original — cada fila de esas tablas pertenece a un solo usuario (`id_usuario`), así que dos cuentas nunca podrían compartir el mismo id por construcción, y la Señal B jamás habría encontrado nada, sin importar qué datos existieran. La clave real terminó siendo el **contenido**: `Direccion` por `pais|dirección|código_postal` normalizado, `MetodoPago` por `token_pasarela` (el identificador estable de la pasarela de pago, nunca el número de tarjeta) — dos cuentas "independientes" que en realidad cargaron el mismo domicilio físico o la misma tarjeta sí es la señal. `COMPRÓ` guarda `direccion_texto`/`metodo_pago_token` (no los ids) por la misma razón, y la consulta de la Señal B ata la desviación a la dirección de ESA compra puntual, no a "esta cuenta tiene alguna dirección compartida en algún momento" (dos condiciones ciertas por separado, de compras distintas, no dicen nada). Ver `fraudeSyncService.js`/`fraudeService.js` para el código real.

## 13. Verificación — evidencia real

- **Backfill** (`npm run fraude:backfill`): 52 compras y 1 reseña históricas reenviadas, 0 omitidas, contra los datos reales acumulados en el resto de esta sesión.
- **`npm run verificar:fraude`** (`backend/scripts/verificarFraudeNeo4j.js`) — siembra el patrón sintético (documentado como tal, ver §8) corriendo `checkout()`/`resenaService.crear()` REALES, no `MERGE` directo a Neo4j, para probar el camino en vivo de punta a punta:
  - Señal A: dos cuentas nuevas compran y reseñan los mismos 3 productos con 5 estrellas — encontrado correctamente, 3 productos compartidos.
  - Señal B: una cuenta nueva, sin ningún historial, compra por primera vez enviando a una dirección cuyo texto coincide con el de otra cuenta — encontrado correctamente.
- **Panel `/admin/fraude`**, verificado con navegador real, logueado como administrador: las dos tablas renderizan correctamente. Encontró, además del patrón sembrado, un patrón **orgánico** no planeado — dos cuentas de prueba de sesiones anteriores ("Luis Ramírez", "vid asas") comparten dirección en varias compras reales — buena señal de que la consulta generaliza más allá de los datos sembrados a propósito.
- Bug real encontrado y corregido en el camino: los campos enteros que devuelve el driver de Neo4j necesitaban conversión antes de mandarlos al frontend en versiones anteriores del driver (`Integer` en vez de `number`) — con `neo4j-driver@6.2.0` ya vienen como `number` nativo, pero se dejó `aNumero()` en `fraudeService.js` como conversión defensiva, sin costo si ya es un número.

## 14. Mini-reporte por hallazgo y ficha de usuario (2026-09-18)

El panel original (§7, §13) listaba los pares/patrones en tablas planas — suficiente para confirmar que las consultas encontraban lo esperado, pero no algo que un administrador pudiera revisar sin volver a este documento para recordar qué significa cada columna. Se agregó, sin tocar qué cuenta como señal (los `WHERE` de §3/§4 no cambiaron):

- **Motivo en prosa**: cada fila de `resenasCoordinadas()`/`desviacionPatron()` (`fraudeService.js`) arma un párrafo en español explicando, con los datos reales del hallazgo, por qué se marcó — construido junto a la consulta que produce esos datos, no en un archivo aparte que se pueda desalinear si la consulta cambia. Señal A ahora también agrega `avg(calificacion)` por usuario y la fecha de la reseña más reciente del grupo, citadas en el motivo. Señal B se reestructuró para agrupar TODAS las cuentas que comparten la dirección de esa compra en una sola fila (`collect(DISTINCT {id, nombre})`) en vez de una fila repetida por cada cuenta compartida.
- **Ficha de usuario** (`enriquecerUsuarios()`): dado un lote de `id_usuario` de una respuesta, un solo round-trip a MySQL (`usuarios` + `rol` + `direcciones` + `metodos_pago`, más `compra.groupBy` para conteo/total gastado) y uno a Mongo (`Resena.aggregate` para conteo de reseñas) arma nombre/correo/rol/fecha de creación/direcciones/métodos de pago (solo marca + últimos 4 dígitos — nunca `token_pasarela`, mismo criterio que el resto del proyecto) por usuario. Neo4j sigue guardando solo `{id_usuario, nombre, rol}` (§5) — todo lo demás se resuelve en vivo contra la fuente real, nunca cacheado en el grafo.
- **Antigüedad de cuenta como señal de refuerzo**: requirió agregar `usuarios.creado_en` (`DateTime @default(now())`, migración `20260918043300_add_usuario_creado_en`) — no existía ningún campo de alta hasta ahora. Limitación honesta y documentada en el propio schema: las filas anteriores a la migración quedan con la fecha de la migración, no su alta real, porque ese dato nunca se guardó y no hay forma de recuperarlo. Confiable solo para cuentas creadas de acá en adelante. Una cuenta con `diasDesdeCreacion <= 30` se marca `cuentaReciente` y el motivo lo menciona como refuerzo, no como señal por sí sola.
- **Categoría legible**: `Producto.subcategoria` en Neo4j solo guarda el ObjectId de Mongo (string) — `resolverSubcategorias()` lo resuelve contra `Subcategoria` (Mongo) en el mismo lote, para que el motivo diga "Cocina" y no un ObjectId.
- **Dos limpiezas de ruido encontradas probando contra datos reales** (no cambian qué cuenta como señal, solo qué tan legible es el resultado):
  - `deduplicarPorContenido()`: si una cuenta tiene dos filas de dirección/método de pago con el mismo contenido (arrastradas de pruebas manuales anteriores), la ficha las mostraba dos veces — se dedupe por contenido antes de mostrar, mismo criterio que ya usa la clave de `Direccion`/`MetodoPago` en Neo4j.
  - `colapsarRepetidos()`: `verificarFraudeNeo4j.js` corrido muchas veces durante el desarrollo dejó compras repetidas del mismo producto — la Señal B las marcaba como filas separadas (24 en vez de 8) porque cada repetición de un producto YA comprado sigue cumpliendo "sin otro producto distinto comprado antes en esa subcategoría". Se colapsa a la ocurrencia más reciente por `(usuario, producto, conjunto de cuentas con las que comparte dirección)` — si ese conjunto cambia entre compras, sí queda como fila separada, porque eso es información nueva.
- Verificado con navegador real, logueado como administrador (`admin.fraude.check@example.com`, creada solo para esta verificación — mismo patrón que las cuentas `fraude.testN@example.com`): las dos secciones renderizan motivo + fichas correctamente contra datos reales, sin errores de consola atribuibles al panel.

## 15. Normalizador más estricto y nivel de confianza en la Señal B (2026-09-22)

Dos mejoras a `fraudeSyncService.js`/`fraudeService.js`, motivadas por preguntas directas sobre falsos positivos/negativos, no por un bug reportado:

- **`normalizarDireccion()` sigue siendo comparación EXACTA después de normalizar — nunca aproximada.** Se evaluó explícitamente usar Elasticsearch/fuzzy matching acá y se descartó: una dirección con estructura (calle/número/apartamento) puede diferir en un solo carácter y ser un lugar completamente distinto, así que tolerancia a variaciones cambiaría qué tan seguro hay que estar de que es la MISMA dirección — cambiaría falsos negativos de hoy por falsos positivos nuevos, peor para un detector de fraude. En su lugar se amplió la normalización DETERMINISTA: quita tildes de vocales (no toca la "ñ", que es una letra distinta, no una variante de escritura), colapsa espacios repetidos, convierte puntuación de formato a espacio, y expande un puñado de abreviaturas comunes en Guatemala (Av./Calz./Col./Zn.). Motivado por un caso real de esta sesión: una dirección sembrada quedó como `"...El Salvador , "` (coma y espacio colgando) que antes de esto nunca iba a calzar con la misma dirección sin esa coma.
- **Señal B ahora distingue "posible" de "alta" confianza**, porque compartir dirección sola tiene explicaciones inocentes reales (familiares, compañeros de casa, una oficina) y marcar una cuenta genuina como sospechosa tiene un costo — la consulta ahora también chequea, por cada cuenta que comparte la dirección, si ADEMÁS pagó alguna vez con el mismo `token_pasarela` que la compra señalada (`EXISTS { (otraCuenta)-[:PAGÓ_CON]->(:MetodoPago {token_pasarela: ...}) }`, reutilizando la relación `PAGÓ_CON` que ya existía en el grafo desde §5/§6, no un dato nuevo). Dos personas de verdad distintas casi nunca comparten una tarjeta aunque sí compartan techo — coincidir en dirección Y método de pago a la vez es mucho más difícil de explicar sin fraude. `nivelConfianza` ('alta' si algún `otraCuenta.mismoMetodoPago`, si no 'posible') viaja en la respuesta; el motivo en prosa y el panel (`AdminFraudePage.jsx`) usan un tono y una insignia distintos para cada caso — 'posible' nombra explícitamente la explicación inocente en el propio texto en vez de callarla.
- Verificado con dos casos reales simultáneos en el panel: el par orgánico "vid asas"/"Luis Ramírez" (dirección compartida, tarjetas distintas — `4563` vs `4567`) salió correctamente como "posible"; un par nuevo creado a propósito para la prueba (`confianza.test.a/b@example.com`, misma dirección Y mismo `token_pasarela`) salió correctamente como "alta", con la insignia "Mismo método de pago" en la ficha correcta. `npm run fraude:backfill` re-sincronizó 102 compras/7 reseñas históricas bajo el normalizador nuevo sin errores.
