# Plan — Neo4j para detección de fraude (Entrega 2)

> Creado: 2026-09-08. **Actualizado 2026-09-08: implementado y verificado.** Infraestructura, sincronización en vivo (checkout + reseñas), backfill histórico, las dos consultas y el panel en `/admin/fraude` — todo corriendo contra datos reales, no solo diseñado. Detalle de la verificación al final de este documento (§12) y en ESTADO-PROYECTO.md.

> **Rediseños 2026-10-04 (ver §16 a §19):** el grafo ya no guarda dirección de envío ni método de pago. Hoy son **siete señales** — reseñas coordinadas, gasto anómalo, categoría inusual, cuentas de una misma persona, ráfaga de gasto, autocompra y **reventa de lo comprado** — y la identidad entre cuentas son **dos vínculos**: el **nombre completo normalizado** y el **buzón de correo normalizado** (hash). Además, desde §18 el sistema **impide** que un vendedor compre sus propios productos y, desde §19, una cuenta que puede vender **acepta un compromiso de no reventa** cada vez que compra. Las secciones §4 (Señal B por dirección), §5/§6 (nodos `Direccion`/`MetodoPago`, `ENVIÓ_A`/`PAGÓ_CON`), §12, §14 y §15 describen el modelo original, §16 la etapa intermedia solo por correo y §17 la etapa solo por nombre; se conservan como historial de cómo se llegó acá — **el modelo vigente es el de §19** (que suma `Articulo`/`ES_ARTICULO` al de §18).

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

**Límite honesto encontrado el mismo día, antes de que nadie lo reportara como bug:** "mismo método de pago" no distingue fraude de una familia real que comparte una sola tarjeta entre varias cuentas (padres/hijos) — a nivel de datos, las dos cosas se ven idénticas (cada cuenta necesita su propia fila de `metodo_pago`, `checkoutService.checkout()` exige `metodo_pago.id_usuario === usuarioId`, así que "compartir tarjeta" en el grafo siempre es "dos filas distintas, cargadas por separado, que resuelven al mismo token de la pasarela" — no hay forma de que el dato diga "esto es una familia"). Dos corroboradores más, agregados a pedido explícito, con una regla fija: **pueden subir el nivel a 'alta', nunca bajarlo** — la postura por defecto ante evidencia real sigue siendo tratarla como sospechosa hasta que una persona revisando confirme lo contrario:

- **Cruce con la Señal A** (`apareceEnSenalA()`, `fraudeService.js`): si la MISMA pareja de cuentas de una fila de Señal B también aparece coordinando reseñas en la Señal A, sube a 'alta' aunque no compartan método de pago — dos señales independientes, cada una con su propio criterio, apuntando al mismo par es mucho más difícil de explicar como familia que cualquiera de las dos sola. `desviacionPatron()` pide su propia copia de `resenasCoordinadas()` (best-effort, con su propio `.catch(() => [])`) en vez de depender de que `consultarFraude()` se la pase — una consulta barata duplicada a cambio de que Señal B siga siendo llamable y correcta por sí sola, sin acoplarse a la otra señal.
- **Contexto de actividad propia** (siempre visible, nunca sube ni baja `nivelConfianza`): el motivo ahora cita, por cada cuenta involucrada, cuántas compras/reseñas propias tiene y desde hace cuánto existe — dato que ya se pedía (`enriquecerUsuarios`), solo no se usaba en el texto. Deliberadamente informativo, no decisorio: una cuenta con actividad propia larga y repartida en el tiempo es más compatible con una persona (o familia) real que con una cuenta armada solo para esto, pero decidir eso es trabajo de quien revisa, no de este texto — el nivel de confianza no se recalcula con este dato, a propósito, para no darle al sistema una forma de autoconvencerse de que algo es inocente.
- Verificado con un tercer caso construido a propósito: `fraude.test1`/`fraude.test2` (que YA coordinaban en Señal A desde antes) compraron cada uno una bicicleta — categoría nueva para los dos — enviada a una dirección nueva compartida, con sus tokens de pago de siempre (distintos entre sí, sin tocar). Salió "alta" únicamente por el cruce con Señal A, insignia "También en Señal A" en la ficha correcta — confirma que el segundo camino de escalamiento funciona de forma aislada, no solo en combinación con el primero.

## 16. Rediseño de señales: gasto, categoría y correo en lugar de dirección y método de pago (2026-10-04)

> **Superado en parte por §17 y recuperado en §18 (mismo día):** el nodo `Correo`/`USA_CORREO` y la señal "anillo por correo" de esta sección se reemplazaron primero por el nombre completo normalizado (§17) y **§18 los devolvió** — ya no como la única identidad, sino como un segundo vínculo entre cuentas junto al nombre. Todo lo demás de §16 — el modelo de `COMPRÓ` con `compra_id`/`monto`/`categoria`, las señales de gasto anómalo y categoría inusual, la regla de confianza que solo sube, la migración y la corrección de la Señal A — sigue vigente.

**Qué cambió y por qué.** A pedido explícito del equipo, el grafo deja de registrar dónde recibe y con qué paga cada cuenta, y pasa a modelar tres cosas más cercanas a cómo un banco vigila a un cliente: cuánto gasta una cuenta frente a su propio pasado, en qué categorías compra, y qué buzón de correo usa. Las secciones §4, §5, §6, §12, §14 y §15 quedan como historial del modelo anterior.

### Modelo vigente

```
(:Usuario {id_usuario, nombre, rol})
(:Producto {producto_id, descripcion, subcategoria, categoria})
(:Correo {hash})

(:Usuario)-[:COMPRÓ {detalle_id, compra_id, fecha, monto, categoria, subcategoria}]->(:Producto)
(:Usuario)-[:RESEÑÓ {calificacion, fecha}]->(:Producto)
(:Usuario)-[:USA_CORREO]->(:Correo)
```

Eliminados: `Direccion`, `MetodoPago`, `ENVIÓ_A`, `PAGÓ_CON` y las propiedades `direccion_texto`/`metodo_pago_token` de `COMPRÓ`. También salieron las direcciones y métodos de pago de la ficha de usuario del panel: ya no son señal, y mostrar ese dato sin un propósito es exposición gratuita.

- **`compra_id` en cada línea.** El gasto se mide por *pedido* (suma de sus líneas), que es el movimiento que un banco compara contra los anteriores del cliente — no por línea.
- **`categoria` en la arista.** Es el id de Mongo de la categoría de primer nivel (Ropa, Electrónica…), "en qué categoría compró ESA vez", mismo criterio con que `COMPRÓ` guardaba la dirección de esa compra puntual. `fraudeSyncService` resuelve subcategoría → categoría internamente (con caché en memoria: el catálogo no permite editar ni borrar categorías, ESTADO-PROYECTO.md §5), así los puntos de llamada solo envían la subcategoría que ya tenían.

### El correo: el mismo error que tuvo la dirección, evitado de entrada

`usuarios.correo` es `@unique` en MySQL — dos cuentas **nunca** pueden compartir el correo exacto, igual que dos filas de `direcciones` nunca podían compartir un `id` (§12). Comparar el texto crudo no encontraría nada. Lo que sí comparten dos cuentas de una misma persona es el **buzón**: `ana+2@x.com` y `ana@x.com` llegan al mismo lugar, Gmail ignora los puntos (`a.na@gmail.com` == `ana@gmail.com`) y trata `googlemail.com` como `gmail.com`. `normalizarCorreo()` colapsa solo eso — mayúsculas, alias `+etiqueta` y, **solo en Gmail**, los puntos — y nunca variaciones de contenido (fuera de Gmail, `ana.gomez` y `anagomez` SON buzones distintos).

Neo4j guarda únicamente el **SHA-256 del buzón normalizado** (`:Correo {hash}`), no el correo: sirve para saber si dos cuentas comparten buzón sin copiar un dato personal a una base que todavía no tiene control de acceso real (§5; Entrega Final). El correo legible se resuelve en vivo desde MySQL al armar la ficha del administrador.

### Las cuatro señales

Parámetros ajustables en `PARAMETROS_POR_DEFECTO` (`fraudeService.js`) — nunca interpolados en la consulta.

| Señal | Qué detecta | Regla por defecto |
|---|---|---|
| **A. Reseñas coordinadas** | Cuentas distintas reseñando lo mismo, en bloque | Sin cambios de criterio (§3): ≥3 productos en común, calificación ≥4, ventana de 1 h |
| **B. Gasto anómalo** | Un pedido muy por encima de lo que *esa misma cuenta* gastó antes | ≥5 pedidos previos; total ≥ 3× el promedio previo **y** mayor que su máximo previo; total ≥ Q500 |
| **C. Categoría inusual** | Primera compra de una cuenta en una categoría, después de un historial establecido | Antes de esa compra: ≥5 pedidos repartidos en ≥30 días |
| **D. Anillo por correo** | Varias cuentas con el mismo buzón, todas comprando | ≥2 cuentas con el mismo buzón, ≥2 de ellas con compras |

- **B** compara cada pedido solo contra los que lo *precedieron* (la lista previa excluye al propio pedido) y exige un baseline mínimo — sin historial no hay "lo normal para esta cuenta". El piso de Q500 evita señalar saltos relativos pero triviales (de Q40 a Q150) en un catálogo donde un celular cuesta Q2,600. Se señala el *primer* salto de una racha: después de él, el máximo previo ya lo incluye, así que un segundo pedido parecido no vuelve a marcarse.
- **C** es una fila por (cuenta, categoría) con la primera compra en esa categoría; el motivo cita contra qué se compara ("6 compras en 60 días, siempre en Ropa, 100%"). Ser cliente nuevo y explorar categorías no dispara nada: la regla exige el historial.
- **D** interpreta "cuentas que hacen compras distintas" como *cada cuenta compra por su lado* (≥2 cuentas con pedidos propios). Una cuenta duplicada que nunca compró no es señal. Una cuenta solo entra al grafo cuando compra o reseña (que exige comprar), así que el filtro es consistente con lo que el grafo puede ver.

### Nivel de confianza: solo sube, nunca baja

Se mantiene la regla de §15, ahora uniforme: una señal corroborada por otra independiente sube a `alta`; nada de lo que se calcula puede bajarla.

- **D (anillo)** siempre `alta` — con el correo único, cualquier buzón compartido es aliasing deliberado, no un homónimo.
- **B y C** parten en `posible`. Suben a `alta` si **la misma compra** aparece en las dos (un salto de monto *y* una categoría ajena en un mismo pedido es el patrón clásico de cuenta tomada; dos eventos sueltos de meses distintos no se refuerzan entre sí), o si la cuenta pertenece a un anillo (D) o a un par de reseñas coordinadas (A).

### Migración

`npm run fraude:backfill` ahora empieza con `limpiarModeloAnterior()` (borra `Direccion`/`MetodoPago` y las propiedades viejas de `COMPRÓ`) y después reenvía todo con el modelo nuevo. Seguro por ser Neo4j una copia derivada y por ser idempotente (sobre un grafo ya limpio no borra nada). Resultado real: 149 compras y 8 reseñas reenviadas, 0 omitidas; el grafo quedó con solo `Usuario`/`Correo`/`Producto`.

### Corrección colateral en la Señal A

Al diseñar las ventanas de tiempo apareció un error latente: `duration.between(a, b).seconds` solo devuelve el resto de segundos *después* de los días completos — dos reseñas con 2 días y 5 minutos de diferencia daban `300`, así que la "ventana corta" aceptaba reseñas separadas por días. Reproducido contra el Neo4j real y corregido con `duration.inSeconds(a, b).seconds` (total real, 173,100 en ese ejemplo).

### Verificación

`npm run verificar:fraude` (reescrito): corre `checkout()` y `resenaService.crear()` **reales**; como B y C dependen del tiempo, tras cada checkout de "historial" corrige `compra.fecha` en MySQL y reenvía esa compra al grafo con la fecha vieja. Es idempotente (la segunda corrida no siembra nada, 4 s) y cubre: la normalización del buzón, Señal A, D (alias `+` entre `fraude.anillo@` y `fraude.anillo+segunda@`), B+C juntas (historial barato en Ropa y de golpe un televisor de Q13,059: 161.6× su promedio → `alta` por corroboración mutua), C sola (compra barata en Hogar → `posible`, sin corroboradores) y controles negativos (buzones distintos no forman anillo; una compra barata no es gasto anómalo; el grafo ya no contiene `Direccion`/`MetodoPago`). Probado también con navegador real como administrador en `/admin/fraude`.

Con los datos orgánicos actuales ninguna de B/C/D se dispara por sí sola — esperable: casi todas las cuentas tienen pocos pedidos, y la única con historial largo (Ana, 88 pedidos en 31 días) compró en Hogar a los 2 días de su primera compra, cuando la regla de 5 pedidos / 30 días todavía no se cumplía (el control correcto funcionando sobre datos reales).

### Límites honestos

- El hash es seudonimización, no cifrado: un SHA-256 sin sal de un correo se puede revertir con un diccionario de correos probables. Reduce la exposición en el grafo; no la elimina.
- B mide el *primer* salto de una racha, no cada pedido posterior parecido (ver arriba).
- La "velocidad" (mucho gasto en poco tiempo, aunque cada pedido sea normal) no estaba cubierta cuando se escribió esto; se agregó como la señal E en §17.

## 17. Identidad por nombre, ráfaga de gasto y autocompra (2026-10-04)

> **Modificado por §18 (mismo día):** el buzón de correo volvió al grafo (`Correo`/`USA_CORREO`) como segundo vínculo entre cuentas, así que "Eliminados respecto a §16: `Correo` y `USA_CORREO`" y la señal D "mismo nombre" de abajo describen el estado intermedio. Las señales E y F, el modelo de `VENDE` y la regla de que la confianza solo sube siguen vigentes.

Tres cambios pedidos por el equipo sobre §16, el mismo día:

1. **El correo deja de ser la identidad entre cuentas; pasa a serlo el nombre completo.** El equipo notó que `usuarios.correo` es único y por tanto nunca se repite; el buzón normalizado de §16 sí detectaba alias (`+etiqueta`, puntos de Gmail), pero se prefirió una clave que atrapa el caso más simple y frecuente de una persona con varias cuentas: registrarse otra vez con el mismo nombre y apellido.
2. **Señal E — ráfaga de gasto** (la "velocidad" anotada al final de §16).
3. **Señal F — autocompra** (cuentas que se compran entre sí), que exige saber quién vende cada producto.

### Modelo vigente

```
(:Usuario {id_usuario, nombre, rol})
(:Producto {producto_id, descripcion, subcategoria, categoria})
(:Nombre {clave})                                  -- nombre completo normalizado

(:Usuario)-[:COMPRÓ {detalle_id, compra_id, fecha, monto, categoria, subcategoria}]->(:Producto)
(:Usuario)-[:RESEÑÓ {calificacion, fecha}]->(:Producto)
(:Usuario)-[:SE_LLAMA]->(:Nombre)
(:Usuario)-[:VENDE]->(:Producto)
```

Eliminados respecto a §16: `Correo` y `USA_CORREO`. Agregados: `Nombre`/`SE_LLAMA` y `VENDE`.

- **`Nombre.clave`** es `normalizarNombre("nombres apellidos")` (`fraudeSyncService.js`): minúsculas, tildes de las vocales, puntuación y espacios repetidos colapsados — comparación **exacta** después de normalizar, nunca aproximada (mismo criterio que tenía el normalizador de direcciones: una coincidencia aproximada cambia falsos negativos de hoy por falsos positivos nuevos). La **"ñ" se deja intacta** a propósito ("Peña" y "Pena" son apellidos distintos). Límite honesto: "Ana Gómez" y "Ana María Gómez" **no** coinciden. A diferencia del hash de correo de §16, la clave es el nombre en claro: el grafo ya guardaba `Usuario.nombre`, así que no agrega ningún dato personal nuevo.
- **`VENDE`** sale del documento del producto en Mongo (`vendedor_id`/`vendedor_nombre`, cacheados al crearlo): los puntos de llamada solo agregan esos dos campos a un `select` que ya hacían. El vendedor se crea como `Usuario` aunque nunca haya comprado — un vendedor que solo vende también puede ser parte de una autocompra; su `rol` queda sin setear hasta que esa cuenta compre o reseñe.

### Las seis señales

Parámetros ajustables en `PARAMETROS_POR_DEFECTO` (`fraudeService.js`).

| Señal | Qué detecta | Regla por defecto |
|---|---|---|
| **A. Reseñas coordinadas** | Cuentas distintas reseñando lo mismo, en bloque | ≥3 productos en común, calificación ≥4, ventana de 1 h |
| **B. Gasto anómalo** | Un pedido muy por encima de lo que *esa cuenta* gastó antes | ≥5 pedidos previos; ≥3× el promedio previo y mayor que su máximo; ≥Q500 |
| **C. Categoría inusual** | Primera compra en una categoría, con historial establecido | Antes: ≥5 pedidos en ≥30 días |
| **D. Cuentas con el mismo nombre** | Varias cuentas que se llaman igual, todas comprando | ≥2 cuentas con el mismo nombre normalizado, ≥2 con compras |
| **E. Ráfaga de gasto** | Mucho gasto o muchos pedidos en un solo día | Ver abajo |
| **F. Autocompra** | Una cuenta que le compra a sí misma o a otra con su mismo nombre | `(comprador)-[:COMPRÓ]->(producto)<-[:VENDE]-(vendedor)` con misma cuenta o mismo nombre |

**E — ráfaga de gasto.** Agrupa los pedidos de cada cuenta por **día de Guatemala** (UTC−6, el mismo día del panel de ventas) y compara cada día solo contra los días *con compras* anteriores. Dos reglas, ambas relativas al pasado de esa cuenta:
- *Muchos pedidos*: ≥5 pedidos **y** ≥2× el día más activo previo de la cuenta (con historial vacío basta con llegar a 5 — una cuenta nueva con 6 pedidos el primer día es el patrón de prueba de tarjetas). "Cualquier récord" no alcanza: una cuenta que sube su propio récord de a poco (5, 12, 13, 18) quedaba señalada en cada escalón con los datos reales de Ana.
- *Mucho gasto*: total del día ≥3× el gasto diario promedio previo, mayor que el máximo diario previo y ≥Q500, con ≥3 días previos con compras **y ≥2 pedidos ese día**. El mínimo de 2 pedidos es deliberado: un solo pedido grande ya es la señal B, y contarlo también como ráfaga lo haría "corroborarse" a sí mismo con la misma evidencia. Es justo lo que B no ve: varios pedidos que, uno por uno, parecen normales.
- Limitación aceptada: una ráfaga que cruza la medianoche se reparte en dos días.

**F — autocompra.** Dos variantes: **cuentas distintas con el mismo nombre** (el "comprador" paga, el "vendedor" cobra menos la comisión de la plataforma y el dinero queda con apariencia de venta legítima — el patrón de lavado que motivó la señal; parte en confianza **alta**), y **la misma cuenta** (un vendedor que se compra sus propios productos; parte en **posible**, porque puede ser un vendedor probando su propio flujo de compra). Con datos reales ya apareció una autocompra "misma cuenta" orgánica: 5 compras de Luis Ramírez de sus propios productos, salidas de pruebas de desarrollo.

### Nivel de confianza (mismo principio de §16: solo sube)

- **F entre cuentas con el mismo nombre**: `alta` desde el principio. **F misma cuenta**: `posible`, sube con corroboración.
- **D (mismo nombre)**: `posible` por sí solo — **a diferencia del correo de §16**, un nombre sí puede repetirse entre dos personas distintas, así que el nombre solo es una coincidencia débil. Sube a `alta` si: al menos dos de las cuentas declararon la **misma fecha de nacimiento**, hay una **autocompra** entre ellas, **coordinan reseñas**, o alguna tiene conducta anómala (B/C/E).
- **B, C, E**: parten en `posible`. Suben a `alta` por la misma compra (B↔C), el mismo día (E↔B, E↔C) o si la cuenta aparece en D, F o A.
- **La fecha de nacimiento nunca viaja al navegador**: se lee de MySQL para corroborar y se descarta; la ficha del panel no la muestra. Tampoco se guarda en el grafo.

### Migración

`limpiarModeloAnterior()` (en `backfillNeo4j.js`) ahora también borra los nodos `Correo`. Resultado real tras `npm run fraude:backfill`: 170 compras y 8 reseñas reenviadas, 0 omitidas; el grafo quedó con 14 `Usuario`, 14 `Nombre` y 9 `Producto`, y relaciones `COMPRÓ`, `RESEÑÓ`, `SE_LLAMA` y `VENDE`.

### Verificación

`npm run verificar:fraude` (reescrito, idempotente — la segunda corrida tarda 4 s y no siembra nada) cubre las seis señales con compras **reales** y fechas pasadas corregidas después, más controles negativos: el normalizador (tildes, mayúsculas, la "ñ" y los segundos nombres distinguen); D (dos parejas con el mismo nombre — una con la misma fecha de nacimiento → `alta`, otra con fechas distintas → `posible` sin corroboradores; un grupo con una autocompra entre sus miembros → `alta`; nombres distintos no se mezclan); F (comprador y vendedor con el mismo nombre → `alta`; vendedor que se compra a sí mismo → `posible`; comprarle a un vendedor ajeno no cuenta); E (una cuenta nueva con 6 pedidos en un día; otra con 4 días de compras chicas que un día hace 3 pedidos de ~Q200 = Q597 contra Q71.67 habitual — y ninguno de esos pedidos es un gasto anómalo por separado; un solo pedido grande no es ráfaga); y B/C como antes. Los vendedores de prueba y sus productos son sintéticos (`[PRUEBA fraude] …`) y se crean **inactivos**: `checkout()` rechaza productos no activos, así que el script activa cada uno solo durante el instante de su compra y lo vuelve a ocultar siempre.

Con los datos orgánicos aparecen, además de lo sembrado: la autocompra de Luis Ramírez (`posible`) y dos ráfagas de volumen de Ana (el primer día de su cuenta, 5 pedidos; y 12 pedidos el 23/08, más del doble de su día más activo previo), todas producto de pruebas de desarrollo y todas `posible`. Probado también en `/admin/fraude` con navegador real como administrador.

### Límites honestos

- Dos personas distintas **pueden** llamarse igual: por eso D parte en `posible` y la fecha de nacimiento corrobora. Una persona que cambie un solo carácter de su nombre (o use un segundo nombre) no se detecta — el alias de correo de §16 sí lo habría atrapado; **§18 devolvió el buzón normalizado** precisamente para ese caso.
- La fecha de nacimiento es un dato que el usuario declara: sirve para corroborar, no para probar.
- `VENDE` solo existe para productos que alguien compró o reseñó (el grafo se alimenta de compras y reseñas, no del catálogo entero).
- La ventana de E es el día calendario de Guatemala, no una ventana móvil de 24 h.

## 18. El buzón vuelve como segundo vínculo, y nadie compra lo que vende (2026-10-04)

Dos cambios pedidos por el equipo sobre §17, el mismo día:

1. **Vuelve el correo — como vínculo y como corroborador.** §17 dejó solo el nombre porque `usuarios.correo` es único y nunca se repite. Pero el buzón *normalizado* sí detecta lo que el nombre no: quien se registra otra vez con otro nombre pero la misma bandeja (`ana+2@x.com`, o los puntos de Gmail). Se reintroduce **junto** al nombre, no en su lugar: cualquiera de los dos puede unir cuentas, y cuando coinciden, el correo respalda al nombre.
2. **Un vendedor no puede comprar sus propios productos.** Hasta ahora la autocompra (Señal F) solo se *detectaba* a posteriori; ahora la forma más directa — la misma cuenta comprando lo que ella misma vende — se *impide* en la compra.

### Modelo vigente

```
(:Usuario {id_usuario, nombre, rol})
(:Producto {producto_id, descripcion, subcategoria, categoria})
(:Nombre {clave})                                  -- nombre completo normalizado
(:Correo {hash})                                   -- SHA-256 del buzón normalizado

(:Usuario)-[:COMPRÓ {detalle_id, compra_id, fecha, monto, categoria, subcategoria}]->(:Producto)
(:Usuario)-[:RESEÑÓ {calificacion, fecha}]->(:Producto)
(:Usuario)-[:SE_LLAMA]->(:Nombre)
(:Usuario)-[:USA_CORREO]->(:Correo)
(:Usuario)-[:VENDE]->(:Producto)
```

Respecto a §17 vuelven `Correo` y `USA_CORREO`, con el mismo `normalizarCorreo()` y el mismo hash de §16 (mayúsculas, alias `+etiqueta` y, solo en Gmail, los puntos y `googlemail.com`; **nunca** variaciones de contenido: fuera de Gmail, `ana.gomez` y `anagomez` son buzones distintos). El grafo guarda solo el SHA-256, no el correo.

- **El correo lo resuelve el servicio de sincronización, no el llamador** (`hashCorreoDe(usuarioId)`, una consulta a MySQL con caché por proceso). Hace falta para el comprador *y* para el vendedor del producto — que puede no haber comprado nunca y solo llega con su id —, y así los puntos de llamada de `checkout()`/reseñas **no cambiaron**.
- El vendedor entra al grafo con su nombre, su buzón y `VENDE`, igual que el comprador.

### Señal D: cuentas de una misma persona

Antes "mismo nombre" (§17); ahora hay **dos vínculos** y un grupo puede tener los dos:

- Dos consultas, una por nodo compartido (`Nombre`/`SE_LLAMA` y `Correo`/`USA_CORREO`), y después una **unión transitiva** en JavaScript (`unirGrupos`, *union-find* sobre el id de cuenta): si A y B se llaman igual y B y C comparten buzón, las tres son **una sola persona**. Cada grupo conserva sus `vinculos` (`{tipo: 'nombre' | 'correo', ids, nombre?}`) para explicar y dibujar qué cuentas comparten qué.
- El mínimo "≥2 cuentas con compras" se exige **sobre la persona ya unida**, no sobre cada vínculo suelto: A y C (que compraron) quedan juntas aunque el puente B solo venda.
- La respuesta cambió de nombre: `cuentasMismoNombre` → `cuentasRelacionadas`. **El hash del buzón nunca sale del servidor**: al panel le llegan los ids de las cuentas que lo comparten, y los correos legibles salen de la ficha (MySQL), como siempre.

**Nivel de confianza (mismo principio: solo sube):**

| Grupo | Nivel |
|---|---|
| Comparte **buzón** (con o sin el mismo nombre) | `alta` por sí solo — como en §16: con el correo único, compartir bandeja es aliasing deliberado, no un homónimo |
| Comparte **solo el nombre** | `posible`; sube a `alta` con los corroboradores de §17 (misma fecha de nacimiento, autocompra entre ellas, reseñas coordinadas, conducta anómala B/C/E) |

Los corroboradores también se citan cuando el grupo ya es `alta` por buzón: no cambian el nivel, pero sí el motivo ("Además, al menos dos de estas cuentas declararon la misma fecha de nacimiento"). Y en el sentido contrario, *estar en un grupo D* es una corroboración de identidad para las señales B, C y E de cada cuenta — ahora con una entrada por vínculo ("usa el mismo buzón de correo que la cuenta #19", "comparte nombre completo con la cuenta #3").

### Señal F: autocompra, ahora también por buzón

La consulta devuelve dos banderas, `mismoNombre` y `mismoBuzon`, calculadas solo para cuentas **distintas** (sobre la misma cuenta un patrón no reutiliza la misma relación, y no aporta). F entre cuentas distintas — por nombre, por buzón o por ambos — parte en `alta`; F de una cuenta consigo misma, en `posible`.

### La regla: nadie compra lo que vende

`productoService.verificarNoEsPropio(usuarioId, productoIds)` rechaza con **403** ("No podés comprar tus propios productos") si algún producto del pedido tiene `id_vendedor = usuarioId`. Consulta MySQL, la fuente transaccional (`producto.id_vendedor`), no el `vendedor_id` cacheado en Mongo — un dato derivado no debe ser la única barrera de una regla de negocio.

Se aplica en **todos** los caminos de compra, no solo en uno:

| Camino | Dónde | Detalle |
|---|---|---|
| Checkout normal | `checkout()` | Autoridad final, **antes** de tocar stock: un pedido con un solo producto propio entre otros se rechaza completo (atómico) |
| Compra directa de oferta | `checkoutOferta()` | Mismo control |
| Carrito | `cartService.guardar()` | `agregar` y `actualizarCantidad` — el carrito nunca llega a contener algo que el checkout va a rechazar |
| Oferta flash | `ofertaFlashService.comprar()` | Antes de Redis: el rechazo no gasta (ni hay que devolver) una unidad del pool |
| Recomendación | `tendenciaService.comprar()` | Antes del cupo personal; además `buscarCoincidencias` excluye los productos del propio vendedor (`vendedor_id: { $ne }`), así que nunca se le recomienda |
| Interfaz | `ProductCard`, `ProductDetailPage`, `OfertasPage` | Se ocultan los controles de compra y se avisa "Es tu producto" — la UI es comodidad, el 403 es la garantía |

Para que la tarjeta del buscador sepa si un resultado es propio, se agregó `vendedor_id` al mapping y al documento de Elasticsearch (reindexado: 108 productos).

**Qué cubre y qué no.** La regla cierra el caso de **la misma cuenta**. No cierra el de una persona con **dos** cuentas (una compra, la otra vende): ese es justo el patrón que la Señal F entre cuentas distintas — y el vínculo por nombre o buzón de la Señal D — existen para atrapar. Y los pedidos hechos *antes* de la regla siguen en MySQL y en el grafo (p. ej. 5 pedidos de Luis Ramírez de sus propios productos), así que la F "misma cuenta" **no se elimina**: queda para el histórico y como segunda barrera.

### Panel `/admin/fraude`

La sección "Cuentas con el mismo nombre" pasó a **"Cuentas de una misma persona"**. El diagrama dibuja cada vínculo como un nodo compartido (un `Nombre` o un `Correo`) al que convergen las cuentas, así una pareja que comparte nombre *y* buzón muestra dos nodos, y una cadena A-B-C muestra a B conectada a los dos. Las fichas llevan insignias por cuenta ("Mismo nombre", "Mismo buzón") y la tarjeta explica por qué es `alta` cuando no hay una segunda señal ("Alta por sí sola: comparten buzón de correo"). La autocompra entre cuentas distintas dibuja el mismo nodo compartido (nombre, buzón o los dos).

### Migración

`limpiarModeloAnterior()` (en `backfillNeo4j.js`) **ya no borra** `Correo`; `npm run fraude:backfill` reconstruye el grafo con buzones para compradores y vendedores. Resultado real tras la reconstrucción: ningún `Usuario` sin buzón y un buzón compartido entre las cuentas del anillo de prueba. Con las cuentas sembradas por `verificar:fraude` el grafo hoy tiene 30 `Usuario`, 26 `Correo`, 25 `Nombre` y 15 `Producto`, con 206 `COMPRÓ`, 8 `RESEÑÓ`, 30 `SE_LLAMA`, 30 `USA_CORREO` y 15 `VENDE`.

### Verificación

`npm run verificar:fraude` (ampliado, idempotente — la segunda corrida no siembra nada):

- **Normalizador de buzones**: `Ana+Compras@Example.com` → `ana@example.com`, puntos de Gmail, `googlemail.com`; los puntos fuera de Gmail y el dominio sí distinguen; el hash es de lo normalizado.
- **D por buzón** (`fraude.anillo` / `fraude.anillo+segunda`, **nombres distintos**): único vínculo `correo`, `alta`; la ficha trae el correo legible y la respuesta nunca contiene el hash.
- **D nombre + buzón** (`fraude.dual`, fechas de nacimiento distintas, sin otra señal): los dos vínculos y `alta` sin corroboradores — el buzón sostiene solo.
- **D en cadena** (`fraude.cadena.a/b/b+c`: A y B se llaman igual, B y C comparten buzón): **un solo grupo de tres cuentas**, con sus dos vínculos.
- Gemelos y homónimos siguen como en §17 (`alta` por fecha de nacimiento / `posible`), y ahora se afirma que su único vínculo es el nombre; controles negativos: parejas con nombres y buzones distintos no se funden.
- **F por nombre** (`mismoNombre`, no `mismoBuzon`) y **F por buzón** (`fraude.autobuzon` / `fraude.autobuzon+tienda`, nombres distintos: `mismoBuzon`, no `mismoNombre`, `alta`); el vendedor de ese par nunca compró, así que D no se dispara y F sí.
- **F misma cuenta histórica**: el script comprueba que `checkout()` ya la rechaza (403) y siembra el pedido "de antes de la regla" insertándolo directo en MySQL (pedido, línea y pago aprobado, sin tocar stock ni el outbox de ventas) y reenviándolo al grafo — así un `fraude:backfill` posterior lo reconstruye igual.
- **Forma del grafo**: sin `Direccion`/`MetodoPago`; todo `Usuario` tiene su `USA_CORREO`; todo `Correo` tiene únicamente un SHA-256 de 64 hex; ningún nodo guarda un correo en claro.

`npm run verificar:compraPropia` (nuevo): con el vendedor de prueba `luis.ramirez` prueba que **cada camino rechaza** la compra de su propio producto con 403 y que el rechazo **no deja rastro** — ni pedido, ni stock descontado, ni cupo gastado en Redis; un pedido mixto (un producto ajeno y uno propio) se rechaza completo sin descontar el ajeno; el carrito no llega a contener el producto propio; las recomendaciones no lo incluyen. Controles: otra cuenta sí puede comprar ese producto y el dueño sí puede comprar los de otros. Además, con HTTP real: `POST /api/carrito/items` del producto propio → 403 y de uno ajeno → 201, y `npm run verificar:ofertaFlash` sigue pasando (15 intentos simultáneos: 5 admitidos, 10 rechazados, contador en 0, 5 unidades descontadas en MySQL). Probado también en el navegador: el vendedor ve su producto sin botones de compra, y `/admin/fraude` muestra los grupos por nombre, por buzón, la pareja con ambos y la cadena.

### Límites honestos

- El hash es seudonimización, no cifrado (§16): un SHA-256 sin sal de un correo se puede revertir con un diccionario de correos probables.
- Solo se normaliza lo que sabemos que es el mismo buzón. Alias de un dominio propio con puntos distintos (`ana.gomez@` / `anagomez@`) o direcciones de reenvío no se detectan, y una persona con otro nombre **y** otra bandeja es invisible para D — eso solo lo atrapan las señales de conducta (B, C, E) y de coordinación (A).
- Compartir buzón puede tener una explicación inocente (una familia que usa alias `+papa` / `+mama` de una misma bandeja). Por eso el panel lo marca como candidato para revisión humana, con el motivo explicado, no como acusación.
- La regla de compra propia depende de `producto.id_vendedor`: no impide que una persona abra otra cuenta compradora — para eso están D y F.
- Los pedidos anteriores a la regla no se alteran: las autocompras históricas siguen apareciendo en el panel (como `posible`) hasta que alguien las revise.

## 19. Compromiso de no reventa y señal de reventa (2026-10-04)

Pedido del equipo, sobre §18: las cuentas que pueden vender **sí** pueden comprar productos de otros vendedores (no los propios, §18), pero **no revenderlos**. Eso exige dos cosas: (1) que la cuenta **se comprometa de forma explícita** cada vez que compra y quede constancia, y (2) detectar en el grafo al vendedor que compró un producto de otro y hoy **vende uno equivalente** — que incumple los Términos de Servicio.

### El compromiso, al comprar

- **Quién acepta:** las cuentas que pueden publicar productos — rol `vendedor` o `administrador`, las mismas que pasan `requireRole('vendedor', 'administrador')` en las rutas de productos. El rol se lee de **MySQL** (`compromisoService.exigirCompromiso`), nunca de lo que mande el cliente. Un comprador no ve ni acepta nada.
- **Pop-up** (`CompromisoNoReventaModal`) en las **tres** pantallas de compra — carrito, oferta flash y recomendación —, justo al confirmar: *"Tu cuenta puede vender en TiendaYa. Al comprar, te comprometés a no revender los productos de este pedido. Si los revendés, estarás incumpliendo los Términos de Servicio de TiendaYa"*, con una casilla obligatoria ("Entiendo y me comprometo…") que habilita "Aceptar y comprar". Escape, un clic en el fondo y "Cancelar" cierran sin comprar; nada de eso acepta. Es un diálogo accesible (`role="dialog"`, `aria-modal`, foco atrapado y devuelto al botón, desplazable en ventanas bajas) que se desmonta al cerrar, así que la aceptación es **siempre de esa compra** y nunca arrastra la anterior. Los «Términos de Servicio» del texto son un enlace a la página pública `/terminos` (ver más abajo), directo a la sección de no reventa (`/terminos#no-reventa`) y en una **pestaña nueva** — salir de la pantalla perdería la dirección y el método de pago ya elegidos —; el enlace entra en el recorrido de Tab del diálogo (el foco atrapado lo incluye) y no cierra ni acepta nada.
- **El servidor lo exige**, no solo la interfaz: `aceptaNoReventa` tiene que ser el booleano `true` (un `"true"` como texto, un `1` o la ausencia del campo no cuentan) o responde **400** con `codigo: COMPROMISO_NO_REVENTA`. Se evalúa después de la regla de producto propio y **antes de tocar stock o Redis**: en la oferta flash y la recomendación, antes de gastar cupo. Si la interfaz tenía el rol desactualizado y no mostró el aviso, el código reabre el pop-up en vez de enseñar un error suelto.
- **Constancia:** `compra.no_reventa_aceptada_en` (migración `20261004000000_compromiso_no_reventa`), guardada **en la misma transacción del pedido** — no es un reenvío, no puede fallar por separado. Es nullable a propósito: los pedidos anteriores, y los de compradores, no tienen compromiso, y **no se rellena con la fecha del pedido** (fabricaría una aceptación que nadie dio). El detalle del pedido le muestra al vendedor lo que aceptó.

### El modelo

```
(:Articulo {clave})                                  -- clave canónica de la descripción
(:Producto)-[:ES_ARTICULO]->(:Articulo)
```

Se suma a lo de §18; `Producto` ahora entra al grafo **al publicarse** (`productoService.crear()`/`actualizar()` → `fraudeSyncService.registrarProducto`, y `fraude:backfill` para los ya existentes), no solo cuando alguien lo compra o lo reseña: la reventa se ve justamente en la publicación que un vendedor hace *después* de comprar, y esa casi nunca tiene una compra. `MERGE_PRODUCTO_Y_VENDEDOR` (compartido por compras, reseñas y productos) enlaza al artículo y **desenlaza del anterior** si la descripción cambió (subconsulta unitaria; el artículo que se queda sin productos se borra), así que el enlace queda al día sin importar por qué camino se tocó el producto.

**La clave del artículo** (`claveArticulo`) son las palabras significativas de la descripción, normalizadas, sin repetir y ordenadas: no distingue mayúsculas, tildes, puntuación, **orden** ni artículos/preposiciones ("Camiseta de algodón orgánico" = "Algodón orgánico, camiseta"), y sí el modelo y las medidas ("Smartphone X100" ≠ "X200"; "Sartén antiadherente" ≠ "Sarten antiadherente 26cm"). Se compara **exacto después de normalizar**, nunca aproximado (mismo criterio que el nombre de una persona). Es una coincidencia de **título**, no una prueba de que sea la misma pieza: el catálogo no tiene un código de producto compartido entre vendedores.

### La señal G — reventa de lo comprado

```
(vendedor)-[:COMPRÓ]->(original)<-[:VENDE]-(otro vendedor)
(original)-[:ES_ARTICULO]->(artículo)<-[:ES_ARTICULO]-(publicación)<-[:VENDE]-(vendedor)
```

Seis saltos que ninguna tabla relacional contesta con un solo JOIN. Una fila por (vendedor, publicación), con **todos** los originales equivalentes que compró. La consulta **no** mira si la publicación está activa ni cuándo se publicó — el grafo no guarda el estado de los productos, y una copia atrasada afirmaría que algo "se vende hoy" cuando ya se pausó. Eso se resuelve **en vivo** (`enriquecerReventa`, Mongo + MySQL):

- **"Hoy lo vende"**: solo cuenta una publicación **activa** (estado actual en Mongo). Pausarla hace desaparecer el hallazgo, que es exactamente lo que debe pasar.
- **Cuándo se publicó**: el evento de creación del historial (`ProductoEvento`). Publicar **después** de comprar es la secuencia de una reventa.
- **Atributos** de ambos productos: que coincidan (Talla, Color…) dice que no es solo un título parecido.
- **Unidades y precio pagado** de cada compra (MySQL), con la variación contra el precio al que lo publica, y si ese pedido lleva la **constancia del compromiso** — con ella, el hallazgo deja de ser solo una sospecha: es un compromiso que el vendedor dejó asentado y rompió.

**Nivel de confianza (solo sube):** parte en `posible` — un competidor legítimo puede comprar algo parecido a lo que vende para compararlo. Sube a `alta` si publicó **después** de comprar, si los atributos **coinciden exactamente**, si la misma cuenta aparece **revendiendo otro producto** más, o si la cuenta aparece en D/F/A o con conducta anómala (B/C/E). A la inversa, que una cuenta revenda corrobora esas señales de la misma cuenta (comprar mucho de golpe para revender es justo una ráfaga de gasto).

### Panel

Sección **"Reventa de lo comprado"**: resumen de una línea, motivo en prosa (cita el pedido, el compromiso y el precio), razones, un diagrama con las relaciones reales (el vendedor, lo que compró, su vendedor original, lo que hoy vende y el nodo compartido "Mismo artículo"; la arista punteada roja es la sospechosa) y las fichas de las cuentas ("Revende", "Vendedor original").

### Los Términos de Servicio (`/terminos`)

El aviso cita unos Términos de Servicio, así que existe la página pública donde están (`frontend/src/pages/TerminosPage.jsx`, sin sesión):

- **Contenido:** ocho secciones — el servicio y la cuenta, comprar, vender, **no reventa**, reseñas, conductas que no se permiten, cómo se revisa la actividad sospechosa y cambios —, con versión y fecha de actualización arriba, un resumen, un índice y un ancla por sección (`#no-reventa`, `#resenas`…). La enlazan el aviso de compra (pestaña nueva), el detalle del pedido y el pie de página.
- **Solo enuncia lo que el sistema hace de verdad:** la compra propia que se rechaza, el compromiso que se pide y se guarda, las reseñas solo de compradores y la revisión de fraude con una persona en el circuito ("una señal no es una acusación ni una sanción automática"). También dice lo que el sitio es: un proyecto de curso sin pasarela de pago real, donde los pagos se registran como aprobados de forma simulada.
- **No publica umbrales** de las señales (cuánto gasto o cuántos pedidos en un día disparan una revisión): enseñarlos sería enseñar a esquivarlos. Sí nombra qué datos usa la herramienta (relaciones entre cuentas y productos, nombre normalizado, huella irreversible del correo; nunca pagos ni direcciones) y qué ve el administrador al revisar un caso.
- **Qué promete y qué no:** una reventa confirmada se describe como un derecho que TiendaYa se reserva (retirar las publicaciones, restringir o suspender la cuenta), no como una sanción automática.
- **Mantenimiento:** si cambia una regla en el backend, se actualiza el texto y se sube `VERSION`. Mejora posible: el pedido guarda *cuándo* aceptó el vendedor pero no *qué versión* de los términos; guardar la versión junto a `no_reventa_aceptada_en` haría la constancia más precisa si el texto cambia.

### Verificación

- **`/terminos`:** `lint` sin avisos nuevos y `build` aprobado. En el navegador: las ocho secciones y su índice; el ancla funciona en una carga en frío (`/terminos#no-reventa`) y por navegación interna desde el detalle del pedido — la sección queda justo debajo del encabezado fijo —; a 375 px no hay desbordes y el índice pasa a una columna; y el enlace del aviso (`href="/terminos#no-reventa"`, `target="_blank"`, `rel="noopener noreferrer"`) entra en el recorrido de Tab del diálogo y no lo cierra ni acepta nada.
- `npm run verificar:fraude` (ampliado, idempotente): la clave de artículo (orden, tildes, mayúsculas, "de/la"; el modelo y las medidas distinguen); un vendedor **sin** aceptar recibe 400 `COMPROMISO_NO_REVENTA` y no deja pedido; con aceptación compra y el **pedido guarda la constancia**; publica por el alta real de producto y se comprueba que llegó al grafo enlazado a un solo artículo; el hallazgo sale `alta` (publicó después + mismos atributos, +38% sobre lo que pagó, compromiso citado); un **competidor** cuya publicación ya existía antes de la compra y con atributos distintos sale `posible` sin corroboradores; **pausar** la publicación hace desaparecer el hallazgo, **cambiar el título** (el enlace viejo se borra) también, y al volver reaparece; controles negativos (el vendedor original, un vendedor que compró algo y vende otra cosa y una cuenta que no vende no son reventa); y todo `Producto` del grafo tiene exactamente un `ES_ARTICULO`.
- `npm run verificar:compromisoReventa`: la matriz de roles contra MySQL (comprador no; vendedor y administrador sí; solo `true` cuenta) y que **cada camino de compra** rechaza sin aceptación **sin dejar rastro** — ni pedido, ni cupo gastado en Redis. Pruebas aisladas: `npm run test:compromiso` y `npm run test:redis`.
- **Probado de punta a punta**: en el navegador, un vendedor compra por las **tres** pantallas (carrito, oferta flash y recomendación): ve el aviso, Escape/Cancelar no compran, y al aceptar el pedido queda con la constancia (y se muestra en su detalle); un comprador no ve el aviso en ninguna. Por HTTP real: el vendedor publica un producto equivalente a uno que compró y el panel lo marca citando su pedido y su compromiso; al pausarlo, el hallazgo desaparece.

### Límites honestos

- **Es una coincidencia de título.** Quien cambie una palabra o agregue un adjetivo ("Camiseta premium (nueva)") deja de coincidir; sin un código de producto compartido, la señal se queda corta con quien disimula y puede equivocarse con quien vende algo genuinamente parecido — por eso parte en `posible` y es un candidato para revisión humana, no una acusación.
- No ve la reventa **fuera** de TiendaYa, ni distingue si el stock publicado salió de lo comprado.
- El compromiso solo existe para compras **desde este cambio**: lo anterior no tiene constancia (y el motivo lo dice).
- Las consecuencias de una reventa confirmada (retirar las publicaciones, restringir o suspender la cuenta) están en los Términos como un **derecho que TiendaYa se reserva**: no existe un mecanismo automático de sanción ni de suspensión de cuentas; el panel solo señala candidatos para revisión humana.
- Una persona con **dos cuentas** (una compra, la otra revende) la atrapan las señales D y F, no esta.
