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

> **Superado en parte por §22 (2026-11-05):** el **nombre dejó de vincular cuentas** (dos personas pueden llamarse igual) y lo reemplaza el dispositivo desde el que se entra. Lo que sigue en esta sección sobre `Nombre`/`SE_LLAMA`, el «nombre normalizado» como vínculo y los grupos «gemelos»/«homónimos» es historia; la ráfaga de gasto y la autocompra siguen vigentes, con el vínculo de §22.

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

> **Actualizado por §22 (2026-11-05):** el «primer vínculo» de esta sección, el nombre, lo reemplaza el **dispositivo** (con el perfil de equipo como pista más débil en la autocompra). El buzón y la regla «nadie compra lo que vende» no cambian.

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
| Interfaz | `ProductCard`, `ProductDetailPage`, `OfertaCard` (la portada y `OfertasPage`) | Se ocultan los controles de compra y se avisa "Es tu producto" — la UI es comodidad, el 403 es la garantía |

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
- Las consecuencias de una reventa confirmada (retirar las publicaciones, restringir o suspender la cuenta) están en los Términos como un **derecho que TiendaYa se reserva**. Lo único automático es la **suspensión temporal** de §20 (una reventa de confianza alta suspende la cuenta hasta que un administrador la revise o venza el plazo); retirar publicaciones o una suspensión duradera siguen siendo decisión humana, y no existe un mecanismo para ello en el sistema.
- Una persona con **dos cuentas** (una compra, la otra revende) la atrapan las señales D y F, no esta.

## 20. Suspensión temporal de cuentas por fraude de confianza alta (2026-10-04)

Pedido del equipo, sobre las siete señales: que una cuenta que cometió una acción de fraude de **nivel alto** quede **suspendida temporalmente** con un bloqueo en **Redis que vence solo**, y que una **sección solo de administrador** permita revisar cada caso a mano antes de dar el visto bueno a una cuenta que pudo ser marcada sin serlo. Hasta acá el sistema solo *señalaba* candidatos; esto es lo primero que *actúa* sobre una cuenta.

### Dos almacenes, cada uno con su trabajo

```
Redis  bloqueo:{id_usuario}   el candado. EXISTE mientras la cuenta está suspendida; su TTL es lo
                              que falta para que se levante SOLA. Se consulta en cada petición.
MySQL  bloqueo_cuenta         el CASO: qué hallazgo, con qué evidencia, cuándo, quién lo revisó y qué
                              decidió. Es el registro durable y lo que reconstruye el candado.
```

Solo con Redis la suspensión vencería sola, pero se perdería con un reinicio (el Redis del proyecto no persiste a propósito) y no quedaría quién decidió qué ni por qué. Solo con MySQL habría que acordarse de desbloquear y consultar una tabla en cada petición. El reparto es el mismo de siempre en este proyecto: la copia rápida y con vencimiento propio en Redis, el registro en MySQL, y MySQL gana si no coinciden (§ Consistencia).

### Cómo se llega a suspender a alguien

`bloqueoService.evaluar()` corre `consultarFraude()` — **la misma fuente de verdad que el panel**, no una segunda implementación de las señales que se pueda desalinear — y de sus hallazgos de nivel «alta» saca las cuentas **responsables** (los «posible» pasan por la misma tabla, pero dejan a la cuenta bajo vigilancia en vez de suspenderla: §21):

| Señal | A quién suspende | Huella del hallazgo |
|---|---|---|
| Cuentas de una misma persona | Todas las del grupo (son la misma persona) | `cuentas_relacionadas:{ids ordenados}` |
| Autocompra | Comprador y vendedor si son cuentas distintas; la cuenta, si es una sola | `autocompra:{comprador}>{vendedor}` |
| Reventa | Solo quien revende — el vendedor original es la víctima | `reventa:{vendedor}:{publicación}` |
| Ráfaga de gasto | La cuenta | `rafaga_gasto:{cuenta}:{día}` |
| Gasto anómalo | La cuenta | `gasto_anomalo:{cuenta}:{pedido}` |
| Categoría inusual | La cuenta | `categoria_inusual:{cuenta}:{pedido}` |
| Reseñas coordinadas | Nadie: no traen nivel de confianza, nunca son «alta» por sí solas | — |

- **Un hallazgo suspende a una cuenta una sola vez.** `(id_usuario, huella)` es único. El grafo no olvida: sin esto, el barrido volvería a bloquear cada minuto a quien ya cumplió su suspensión (el plazo «vence solo» sería mentira) o a quien un administrador ya liberó. Un hallazgo **distinto** de la misma cuenta es evidencia nueva y abre un caso nuevo. La huella es por relación, no por pedido, donde tiene sentido: un administrador que descartó «estas dos cuentas son familia» no ve la suspensión volver con cada compra entre ellas; si se suma una tercera cuenta al grupo, la huella cambia y se vuelve a revisar.
- **Los administradores nunca se suspenden.** Un automatismo no puede dejar sin acceso a las únicas personas que pueden deshacerlo (si todas las cuentas de administrador cayeran en un hallazgo, nadie podría liberar a nadie). Sus hallazgos se siguen viendo en el panel de fraude para que otro administrador los revise. El rol se lee de MySQL en cada barrido, no de la ficha.
- **Cuándo corre:** cada `FRAUDE_BLOQUEO_INTERVALO_MS` (60 s) desde el backend — un temporizador que arranca `server.js`, como el worker de ventas, no `app.js` — y al instante con el botón «Revisar ahora». Un solo barrido a la vez: si coinciden el temporizador y el botón, el segundo recibe el resultado del que ya corre.
- **Duración:** `FRAUDE_BLOQUEO_HORAS` (24 por defecto, admite decimales). Es el TTL que recibe Redis.

### Qué se hace cumplir y cómo

- `requireAuth` (todas las rutas con sesión) consulta el candado con un `PTTL`: `403` con `codigo: CUENTA_SUSPENDIDA` y la hora en que se levanta. Un token emitido **antes** de la suspensión deja de servir en la petición siguiente — no hay que esperar a que venza (2 h). `optionalAuth` trata a una cuenta suspendida como visitante: el catálogo público sigue abierto.
- `login` la rechaza igual, **después** de verificar la contraseña: quien no la sabe no se entera de que la cuenta existe ni de que está suspendida.
- El mensaje que ve la persona dice cuándo se levanta y que una persona revisa el caso, pero **no qué señal la disparó**: explicar el criterio enseñaría a esquivarlo. Un administrador no se consulta siquiera.
- **Fallar abierto:** si Redis no responde, la cuenta se trata como no suspendida (se registra el fallo, a lo sumo cada 30 s). Una caída de Redis no debe impedir entrar a todo el sitio; el costo es que durante la caída una cuenta suspendida podría actuar, y en cuanto Redis vuelve la reconciliación restablece los candados.
- **Escritura atómica que solo alarga** (`LUA_BLOQUEAR_CUENTA`, `config/redis.js`): escribe `SET … PX` solo si el TTL pedido supera al que ya corre, en una sola ejecución. Un segundo hallazgo, o la reconstrucción desde MySQL, nunca pueden acortar una suspensión vigente.
- El frontend: `api/client.js` avisa con un evento de ventana cuando cualquier respuesta trae `CUENTA_SUSPENDIDA` (así no hay que tocar cada pantalla), `AuthContext` cierra la sesión y `AvisoSuspension` muestra un banner con el mensaje del servidor. En el login basta el error del propio formulario.

### La sección de administrador (`/admin/bloqueos`)

Solo `administrador` (la ruta con `RequireRole` y los cuatro endpoints con `requireRole`): `GET /api/admin/bloqueos`, `POST /evaluar`, `POST /:id/liberar` y `POST /:id/extender`.

- **Bloqueadas ahora**, con lo **pendiente de revisión primero**: nombre, rol, cuánto falta y cuándo se levanta (el tiempo que cuenta es el de Redis, que es el que de verdad la levanta), el motivo en prosa tal como lo explicó el sistema al abrir el caso, la evidencia desplegable (qué lo corrobora y qué cuentas intervienen) y la ficha de la cuenta (la misma del panel de fraude, ahora un componente compartido).
- **Levantar bloqueo** («dar el visto bueno»): con confirmación y una nota opcional. Cierra **todos** los casos activos de la cuenta (la suspensión es de la cuenta, no de cada hallazgo), los deja como `liberado` con quién, cuándo y por qué, y borra el candado: la cuenta entra de inmediato. Como las huellas quedan, ese mismo hallazgo no la vuelve a suspender.
- **Extender 24 h / 7 días:** para cuando la revisión confirma la sospecha. Suma el tiempo al vencimiento de cada caso y alarga el candado; el caso queda «Revisada · se mantiene» y pasa al final de la lista.
- **Historial** de lo cerrado (los últimos 50): lo que un administrador levantó y lo que venció solo.
- `/admin/fraude` marca con «Suspendida hasta…» las fichas de las cuentas que ya lo están (`GET /api/admin/fraude` agrega `bloqueadas`).
- La lista se refresca sola cada 30 s (pueden llegar suspensiones nuevas mientras se mira); «Revisar ahora» muestra además las advertencias del barrido, para no dar por completa una revisión en la que alguna señal no se pudo evaluar.

### Consistencia y fallos

- **Abrir un caso:** primero MySQL (el caso, durable), después Redis (el candado). Si Redis falla, el caso ya quedó y la reconciliación lo repone en el siguiente barrido.
- **Levantar:** primero MySQL, después Redis. Un reintento tras una liberación a medias (MySQL cerrado, Redis no) quita el candado que quedó y responde bien.
- **`reconciliar()`** (al arrancar, en cada barrido y antes de listar): (1) los casos activos cuya hora pasó se marcan `expirado` — Redis ya los soltó solo —; (2) un caso activo sin candado lo recupera, **con lo que falta de su vencimiento**, no con 24 h nuevas; (3) un candado sin ningún caso activo se quita. Por la (3), un `SET bloqueo:{id}` hecho a mano en `redis-cli` se limpia solo: los bloqueos se abren por el sistema.
- **Dentro de un proceso, las operaciones que escriben corren de una en una** (cola de promesas): una liberación no puede cruzarse con una reconstrucción que «arreglaría» lo que acaba de pasar. Hay un solo backend; con varios procesos, el único `(cuenta, huella)` de MySQL sigue evitando casos duplicados.

### Verificación

- `npm run test:bloqueo` — **16 pruebas aisladas** con un Redis y un Prisma en memoria: responsables de cada señal (solo «alta», y a quien corresponde), un administrador nunca se suspende, un hallazgo no suspende dos veces (ni tras liberar ni tras vencer) pero uno distinto sí, barridos simultáneos que comparten resultado, liberar (con reintento tras una liberación a medias), extender y su validación, reconciliación (Redis perdido, candado de más, casos vencidos), un Redis que falla al abrir el caso, el candado que solo se alarga, `listar` y el historial, la configuración, y el middleware (`requireAuth`/`optionalAuth`, incluido que un error inesperado no se confunde con una suspensión).
- `npm run verificar:bloqueo` — 12 comprobaciones contra **Redis, MySQL, Neo4j y un Express reales**, con un patrón sintético propio (dos cuentas que comparten buzón, cada una con una compra real): el grafo las marca «alta»; el barrido las suspende (caso en MySQL, TTL real de 24 h en Redis); un segundo barrido no repite el caso; login y token dan `403 CUENTA_SUSPENDIDA` sin revelar la señal (y una contraseña incorrecta sigue dando 401); el administrador lista, extiende (el TTL sube una hora) y libera; la cuenta liberada entra de nuevo y otro barrido no la vuelve a suspender; **el TTL de Redis levanta un bloqueo solo** y el caso queda `expirado`; se borra un candado de Redis y `reconciliar()` lo reconstruye desde MySQL; el Lua real no acorta una suspensión vigente; un administrador no queda bloqueado aunque exista la clave. Idempotente: borra los casos de esas cuentas al empezar y las deja libres.
- **Probado en el navegador**: la sección con las cuentas pendientes, la evidencia, extender (pasa a «Revisada · se mantiene» con la nota y al final de la lista), levantar con confirmación (Cancelar no levanta; confirmar saca la tarjeta y la deja en el historial con quién y por qué); el login de una cuenta suspendida muestra el mensaje con la hora; una cuenta con la sesión abierta que se suspende pierde la sesión en la siguiente petición y ve el banner; y `/admin/fraude` marca las fichas de las cuentas suspendidas.
- **El primer barrido en la base de desarrollo** suspendió exactamente las 15 cuentas sintéticas `fraude.*` que siembra `verificar:fraude` (18 casos: algunas tienen dos señales) y ninguna cuenta real del seed.

### Límites honestos

- **El primer barrido es retroactivo.** Al activarlo sobre una base con historia, suspende de golpe a todas las cuentas que ya tengan un hallazgo alto, aunque sea de hace meses. Aquí fueron cuentas sintéticas; en una base real convendría una pasada de «solo registrar» o una ventana de tiempo para actuar solo sobre lo reciente.
- **El nivel «alta» es la confianza de un detector, no una prueba.** Compartir un buzón de correo es «alta» por sí solo: una pareja que comparte bandeja y compra por separado se suspende hasta que alguien la revise. Para eso existen la revisión humana, la nota y que un hallazgo liberado no vuelva.
- **La suspensión es de toda la cuenta**, no de una sola actividad: no hay forma de suspender solo la compra o solo la venta. (Sus productos y ofertas flash ya no siguen a la venta mientras dura: se ocultan y vuelven al levantarse, §21.)
- **Fallar abierto** deja una ventana durante una caída de Redis. Y no hay forma de que la persona suspendida **pida una revisión** desde el sitio: el caso lo mira un administrador por su cuenta.
- **El plazo es el mismo para todo** (24 h, que el equipo dio por bueno), venga de un gasto raro o de una cuenta duplicada; no escala con la reincidencia.
- **No se avisa** a los administradores de una suspensión nueva más que en la propia sección (no hay correo ni notificaciones).

### Otras alternativas (no implementadas)

- **Ya implementadas (§21):** la respuesta escalonada («posible» → límites suaves; «alta» → suspensión), la prevención con contadores en Redis y ocultar las publicaciones del vendedor suspendido.
- **Duración que escala:** 24 h → 7 días → solo manual a la tercera, para reincidentes.
- **Evaluar al ocurrir, no cada minuto:** engancharse tras `checkout()`/`resenaService.crear()` (con un debounce) para que la suspensión llegue segundos después de la acción.
- **Verificación en vez de suspensión** para gasto/categoría/ráfaga (riesgo de cuenta tomada): pedir de nuevo la contraseña o confirmar por correo antes de dejar pasar el pedido.
- **Retener el pedido, no la cuenta:** dejar un pedido sospechoso «en revisión» antes de despacharlo.
- **Apelación:** un formulario para la persona suspendida, cuyo texto aparezca en el caso.
- **Bloqueo manual** desde una ficha del panel de fraude, para sospechas «posible» que un administrador considere serias.

## 21. Respuesta escalonada, prevención de pedidos y vendedores suspendidos que se ocultan (2026-10-04)

Pedido del equipo, sobre la suspensión de §20 y a partir de las alternativas que ahí se proponían: (1) **respuesta escalonada** — un hallazgo «posible» ya no es «nada»: deja a la cuenta con límites suaves; solo «alta» suspende —; (2) **prevención con contadores en Redis** — rechazar el pedido de más *antes* de que se complete, en vez de detectarlo después en el grafo —; y (3) **ocultar las publicaciones de un vendedor suspendido** mientras dure la suspensión, de modo que si la cuenta se levanta («se le perdona») vuelvan solas. La duración de la suspensión sigue en 24 h: el equipo la dio por buena.

```
Nivel del hallazgo   Qué pasa con la cuenta                     Candado en Redis        Caso en MySQL (`tipo`)
«posible»            bajo vigilancia: sigue entrando y          restriccion:{id}        restriccion
                     comprando, con límites suaves
«alta»               suspendida (§20); si vende, sus            bloqueo:{id}            suspension
                     productos dejan de mostrarse
cualquiera           tope general de pedidos por hora           limite:pedidos:{id}     —  (solo Redis)
```

### Un candado genérico, dos clases de cuenta bajo medida

`candadoRedis.crearCandado(prefijo)` es el candado de §20 sin el prefijo fijo: `estado`, `bloquear` (el Lua `bloquearCuenta` que solo **alarga**), `levantar`, `usuarios` (`SCAN`) y `restantes` (`PTTL` en lote). `suspensionService` sigue siendo `bloqueo:{id}` — su comportamiento no cambió — y `restriccionService` es `restriccion:{id}`. La misma máquina, dos claves: un TTL que vence solo, y el caso durable en MySQL que lo reconstruye.

`bloqueo_cuenta` gana la columna `tipo` (`suspension` por omisión, `restriccion`) y su único pasa a `(id_usuario, huella, tipo)` (migración `20261004020000_bloqueo_tipo_restriccion`; el índice nuevo se crea **antes** de borrar el viejo porque la FK a `usuarios` necesita un índice que empiece por `id_usuario`). Las reglas del barrido:

- **«alta» → suspensión**, salvo que ya haya una suspensión para ese (cuenta, hallazgo).
- **«posible» → restricción**, salvo que ya haya un caso **de cualquier tipo** para ese (cuenta, hallazgo): o ya se revisó (un administrador quitó los límites, o vencieron), o ya es «alta». Sin esto, el barrido volvería a limitar cada minuto a quien un administrador acaba de perdonar.
- **Escalada:** si un «posible» sube a «alta» (otra señal lo corrobora: p. ej. dos homónimos que declaran la misma fecha de nacimiento), el barrido abre la **suspensión** y la restricción **se queda**: son dos casos y dos candados. Liberar la suspensión no quita la vigilancia; quitar la vigilancia no levanta la suspensión.
- Los administradores nunca se suspenden **ni se limitan**: se omiten (`omitidosAdministrador`) y `limitesDe()` devuelve «sin límites» aunque exista una clave a su nombre.
- `evaluar()` devuelve además `restriccionesNuevas` y `restringidas`; `listar()` separa `activas` de `restringidas`, y el historial trae el `tipo`.

### Los límites suaves (`restriccionService`, `middleware/controlPedidos`)

Mientras la cuenta tenga `restriccion:{id}` (`FRAUDE_RESTRICCION_HORAS`, 24 h) puede entrar y comprar, **con**:

| Límite | Cómo | Rechazo |
|---|---|---|
| Su **contraseña en cada pedido** | campo `contrasena` del pedido; `bcrypt` contra MySQL | `403 REQUIERE_CONTRASENA` (falta), `403 CONTRASENA_INCORRECTA`, `429 DEMASIADOS_INTENTOS` |
| Un **tope de monto por pedido** (`RESTRICCION_MONTO_MAXIMO`, Q500; `0` = sin tope) | lo hace cumplir `checkout`/`checkoutOferta` **dentro de la transacción**, porque solo ahí se conoce el total | `403 LIMITE_MONTO` («…cada pedido puede ser de hasta Q… Este pedido suma Q…») |
| **Menos pedidos por hora** (`RESTRICCION_PEDIDOS_HORA`, 2; `0` = sin tope propio) | rige el menor entre el tope general y el suyo | `429 LIMITE_PEDIDOS` («… (tu cuenta está en revisión)») |

- **Está en las rutas y no en los servicios, a propósito.** `controlPedidos` va tras `requireAuth` en las tres rutas que crean pedidos (checkout, oferta flash, recomendación): es una protección del canal HTTP, y así los scripts y las pruebas que llaman a los servicios no la sienten. Lo único que baja a los servicios es el parámetro `montoMaximo`. Quien agregue una ruta nueva que cree pedidos tiene que ponerle el middleware.
- **La contraseña no es un oráculo.** Cada intento se cuenta en Redis (`reauth:intentos:{id}`, el mismo `INCR`+`EXPIRE` atómico que los pedidos): 5 por ventana de 15 min y, pasados, `429` con `Retry-After` **sin ni siquiera comparar** — hasta la contraseña correcta espera. Uno acertado borra el contador, así que quien la sabe nunca acumula. Se comprueba **antes** de reservar cupo: un intento fallido no gasta un pedido.
- **Una sesión robada no alcanza:** quien tenga solo el token no puede comprar con una cuenta bajo vigilancia. (No protege de una contraseña robada.)
- **El frontend** reacciona al código, no sabe de antemano si la cuenta está bajo vigilancia: el servidor rechaza con `REQUIERE_CONTRASENA` y la pantalla abre `ConfirmarContrasenaModal` (en las tres páginas de compra), que **sigue abierto** si la contraseña es incorrecta o hay demasiados intentos (con el motivo del servidor, el campo vacío y el cursor de vuelta) y se cierra ante cualquier otro rechazo (tope de monto, pedidos por hora…), cuyo mensaje ya explica qué pasó en la página. El reintento conserva lo que la persona ya aceptó del compromiso de no reventa. El armazón de los diálogos (foco, Escape, fondo, Tab) es ahora un componente común, `components/common/Modal.jsx`, que usa también el aviso de no reventa.
- `RESTRICCION_ENABLED=false` apaga todos los límites suaves (los casos abiertos quedan sin efecto).

### Prevención: el tope de pedidos por hora (`limitePedidosService`)

La ráfaga de gasto (señal E) se ve **después**, cuando los pedidos ya se hicieron. Un contador por cuenta (`limite:pedidos:{id}`) rechaza el siguiente **antes** de que se complete:

- `INCR` + `EXPIRE` en **una sola ejecución atómica** (script Lua `reservarCupo`, `config/redis.js`): con N pedidos simultáneos pasan exactamente `límite`, sin la ventana entre «contar» y «decidir» que tendría un `INCR` suelto. Si ya se llegó, deshace su propio `INCR` y responde `-1` con lo que falta.
- **Un pedido que falla no gasta el cupo.** El middleware reserva antes de llamar al servicio y, si la respuesta termina en error (stock, precio, dirección, tope de monto…), lo devuelve (`liberarCupo`, que nunca baja de cero).
- Rechazo: `429`, cabecera `Retry-After` y `reintentarEnSegundos` («Llegaste al máximo de N pedidos por hora… Podés volver a intentarlo en M minutos»). `LIMITE_PEDIDOS_HORA` (5 por defecto; `0` = sin tope) vale para **todas** las cuentas, administradores incluidos.
- **Ventana fija**, no deslizante: se abre con el primer pedido y cierra una hora después. Es lo que da `INCR` + `EXPIRE` y se explica en una frase; el costo conocido es una ráfaga justo en el borde (hasta el doble del tope entre el final de una ventana y el principio de la siguiente).
- **Falla abierto**, como todo lo demás: sin Redis, o con una variable mal escrita, no se frena a nadie. `server.js` valida las dos configuraciones al arrancar y avisa, en vez de descubrir que no había tope cuando hacía falta.

### Ocultar a un vendedor suspendido

La visibilidad se **deriva** del candado, no se guarda: `suspensionService.vendedoresSuspendidos()` devuelve el conjunto de cuentas con `bloqueo:{id}` (un `SCAN`, con un memo de 3 s que `bloquear`/`levantar` invalidan en el proceso). Por eso un vendedor **vuelve en el mismo instante en que un administrador lo libera** — o, si el TTL vence solo, a lo sumo 3 s después —, sin escribir nada en Mongo, Elasticsearch ni Redis por cada producto, y sin poder quedarse «oculto» por una escritura a medias. Se aplica en cada lugar donde un producto se muestra o se compra:

| Dónde | Qué pasa |
|---|---|
| Catálogo (`productoService.listar`) | `vendedor_id: {$nin: [...]}`; filtrando por un vendedor suspendido, `[]` |
| Detalle (`GET /api/productos/:id`) | `404` para el público; un administrador lo abre, **marcado** `vendedor_suspendido` |
| Buscador (Elasticsearch) | `must_not` por `vendedor_id` **en la misma consulta** que arma las facetas y el total, así que ni se cuentan |
| Autocompletado | pide más opciones, descarta las del vendedor y devuelve a lo sumo 8 |
| Recomendaciones | se filtra **al leer**, no al guardar (el caché dura 1 h y una suspensión puede empezar dentro de ese rato); comprarla da «no es una recomendación vigente» |
| Carrito | el producto queda **`disponible: false`** (no se borra) y no se puede agregar de nuevo |
| Pedido y pedido de una oferta | `409` «Hay productos no disponibles», antes de tocar el stock (`verificarVendedoresActivos`, que lee `id_vendedor` de MySQL — la autoridad — y no cuesta ni una consulta si nadie está suspendido) |
| Oferta flash | `404` para el público y `409` al comprar, sin gastar cupo de Redis |

- **Un administrador sigue viéndolo todo**, marcado: `/admin` muestra «Oculto: vendedor suspendido» y el detalle dice por qué no se puede comprar. `/admin/bloqueos` avisa, al levantar, que los productos vuelven.
- **Falla abierto:** sin Redis no se oculta a nadie (el catálogo se ve completo, como antes de existir la suspensión).
- Lo que **no** cambia: los pedidos ya hechos del vendedor, su historial y las reseñas siguen donde están; solo deja de poder venderse.

### Qué se agregó a la interfaz

- `/admin/bloqueos` gana la sección **«Bajo vigilancia»** (una tarjeta por cuenta, con su caso, su evidencia, la ficha, los límites vigentes y «Quitar límites» con confirmación y nota), un renglón de configuración (límites suaves, tope general de pedidos por hora) y el `tipo` en el historial. «Revisar ahora» cuenta lo suspendido y lo puesto bajo vigilancia por separado.
- `POST /api/admin/bloqueos/:id/quitar-restriccion` (solo administrador): cierra los casos de restricción de la cuenta y borra `restriccion:{id}`; ese hallazgo no la vuelve a limitar (si más adelante sube a «alta», sí podría suspenderla — el aviso lo dice).
- `/admin/fraude` marca con **«Bajo vigilancia hasta…»** las fichas de esas cuentas (`GET /api/admin/fraude` agrega `restringidas`).
- Términos de Servicio **v1.2**: el tope de pedidos por hora, la vigilancia con límites suaves y que los productos de un vendedor suspendido se ocultan. Sin cifras: los topes se ajustan por configuración, y publicarlos enseñaría a esquivarlos.

### Consistencia y fallos

- Los casos de restricción siguen el mismo orden que los de §20: primero MySQL (durable), después Redis, y `reconciliar()` repone, vence y limpia **cada candado por su tipo**. Las operaciones que escriben corren de una en una dentro del proceso.
- Una restricción **no** se extiende: vence sola o se quita. Extender es solo de la suspensión.
- El contador de pedidos y el de intentos de contraseña **no tienen caso en MySQL**: son prevención efímera, no una decisión sobre una persona. Se pierden con un reinicio de Redis, y está bien: lo que protegen es una hora.

### Verificación

- `npm run test:bloqueo` — **43 pruebas aisladas** (Redis, Prisma y bases en memoria): las 16 de §20 más **7** de la respuesta escalonada (a quién restringe cada nivel, administradores exentos, escalada, sin repetir, quitar), **9** del control de pedidos (el tope atómico y simultáneo, el pedido fallido devuelve el cupo, la contraseña y sus intentos, el tope de monto, el menor de los dos topes, configuración inválida y Redis caído fallan abiertos) y **11** de ocultar al vendedor (catálogo, vuelta al liberar y al vencer —con el memo de 3 s, medido con un reloj inyectado—, administrador, falla abierta, `verificarVendedoresActivos`, buscador, autocompletado y recomendaciones en caché). Cada prueba de ocultar se comprobó **rompiendo** el código a propósito (7 mutaciones, las 7 detectadas). `npm run test:redis` suma 3 (carrito y oferta flash con un vendedor suspendido, y el tope de monto que llega a `checkoutOferta`).
- `npm run verificar:respuestaEscalonada` — **17 comprobaciones** contra **Redis, MySQL, Mongo, Elasticsearch, Neo4j y un Express reales**, con cuentas y un producto sintéticos propios: con el vendedor suspendido el producto desaparece del catálogo, del buscador (y de su faceta), de las sugerencias, del detalle, de la oferta flash y del pedido (un administrador lo sigue viendo, marcado); al liberarlo vuelve en el mismo instante, y con un TTL de 2,5 s reaparece solo ~3 s después del vencimiento; el tope por hora rechaza con `429`+`Retry-After` el pedido de más, los pedidos fallidos no gastan cupo, y con 5 pedidos **simultáneos** y tope 2 pasan exactamente 2 (y con 20 reservas directas y tope 5, exactamente 5); `0` apaga el tope y un valor inválido falla abierto; una cuenta bajo vigilancia necesita su contraseña, cae en el tope de monto (`LIMITE_MONTO`) y en su tope de pedidos por hora, y tras 5 contraseñas incorrectas hasta la correcta espera; un administrador no se limita; la sección de administrador las lista aparte, quitar los límites cierra el caso y borra la clave; y el barrido, con dos homónimos reales en Neo4j, los deja **bajo vigilancia** («posible») sin suspenderlos, no repite el caso, no vuelve a limitar a quien un administrador perdonó, y cuando comparten fecha de nacimiento (sube a «alta») los **suspende** sin quitarles la vigilancia. Idempotente: borra los casos de esas cuentas y repone el stock al empezar, y al terminar las deja libres y el producto inactivo.
- **Probado en el navegador:** la sección «Bajo vigilancia» con sus límites y «Quitar límites» (confirmación, aviso, el caso pasa al historial con quién y la nota); el diálogo de contraseña en el pedido de una cuenta restringida (se abre al rechazar el servidor, **sigue abierto** con un error si la contraseña es incorrecta, Escape lo cierra, la contraseña correcta completa el pedido); la cadena compromiso de no reventa → contraseña de un vendedor bajo vigilancia (el reintento conserva la aceptación); el rechazo por pedidos por hora cierra el diálogo y se explica en la página; `/admin` marca los productos de los vendedores suspendidos y su detalle explica por qué no se pueden comprar, mientras que para el público dan «No encontramos este producto»; y `/admin/fraude` marca a las cuentas bajo vigilancia.
- **El primer barrido en la base de desarrollo** puso bajo vigilancia a **9 cuentas**: 7 sintéticas (`fraude.*` y la cuenta de `verificar:carrito`) y dos **reales del seed — Ana Gómez** (dos «ráfaga de gasto», por pedidos del 22 y 23 de agosto) **y Luis Ramírez** (una autocompra anterior a la regla de «nadie compra lo que vende»). Es lo que el diseño prevé para un «posible», pero conviene saberlo antes de entrar con ellas: piden contraseña en cada pedido. Se quitan en `/admin/bloqueos` («Quitar límites») o apagando `RESTRICCION_ENABLED`.

### Límites honestos

- **El primer barrido es retroactivo también para «posible»**, y se mide con la historia, no con lo reciente: un hallazgo de hace meses (los pedidos sembrados de Ana) limita a la cuenta hoy. Un «posible» es débil de por sí; que el costo sea una contraseña y un tope —no una suspensión— es lo que lo hace tolerable, pero convendría una ventana de tiempo para actuar solo sobre lo reciente.
- **La vigilancia no impide el fraude: lo encarece.** Una cuenta bajo vigilancia sigue pudiendo comprar hasta el tope; no hay revisión de cada pedido.
- **El contador de intentos de contraseña es por cuenta.** Quien tenga solo el token de otra persona y se equivoque cinco veces la deja sin poder pedir 15 minutos: una denegación de servicio posible, aunque el costo para el atacante es tener ya la sesión. (Contarlos también por IP lo cerraría.)
- **Los topes son por cuenta, no por persona ni por tarjeta.** Quien tenga varias cuentas reparte los pedidos entre ellas; esas cuentas las atrapa la señal D *después*, no este contador.
- **Ventana fija:** una ráfaga en el borde de dos ventanas puede duplicar el tope por un rato.
- **Está en las rutas HTTP:** una ruta nueva que cree pedidos sin `controlPedidos` queda sin tope ni límites.
- **Ocultar usa un `SCAN` de `bloqueo:*` cada 3 s por proceso.** Sobra a esta escala; con miles de cuentas suspendidas convendría un conjunto en Redis (`SADD`/`SREM` al abrir y levantar). Y como cada proceso tiene su memo, con varios backends una suspensión abierta en otro tarda hasta 3 s en notarse acá.
- **Fallar abierto** deja ventanas durante una caída de Redis: sin candados nadie se oculta, se limita ni se suspende.

### Otras alternativas (siguen sin implementarse)

- **Duración que escala:** 24 h → 7 días → solo manual a la tercera, para reincidentes.
- **Evaluar al ocurrir, no cada minuto** (tras `checkout()`/`resenaService.crear()`, con un debounce).
- **Retener el pedido, no la cuenta:** dejar un pedido sospechoso «en revisión» antes de despacharlo.
- **Apelación:** un formulario para la persona suspendida, cuyo texto aparezca en el caso.
- **Bloqueo manual** desde una ficha del panel de fraude, para sospechas «posible» que un administrador considere serias.
- **Ventana de recencia** para los hallazgos que actúan (solo lo de los últimos N días), y avisar a los administradores de un caso nuevo (hoy solo se ve en la sección).

---

## 22. Dispositivos en lugar de nombres: los homónimos ya no son una señal (2026-11-05)

**Por qué.** Las señales D (cuentas de una misma persona) y F (autocompra) vinculaban cuentas por **nombre completo idéntico** (§17-§18). Dos personas distintas pueden llamarse igual —«José Pérez»—, y la señal F arrancaba en confianza **alta** (suspensión de 24 h) cuando un comprador le compraba a un vendedor «que se llama exactamente igual». Medido antes del cambio, en la base de desarrollo: 6 nombres compartidos entre cuentas, y la autocompra `25→24` calificada «alta» **solo por el nombre**. El nombre era la evidencia más débil del modelo con el peso más fuerte. §22 lo reemplaza por algo que una persona con varias cuentas sí comparte y que dos homónimos no: **el dispositivo desde el que entran**.

### Qué es un «dispositivo»

Un navegador no tiene un identificador de equipo que un sitio pueda leer (y leerlo sería invasivo), así que la tienda le pone uno. `frontend/src/utils/dispositivo.js` genera un valor **aleatorio** (UUID) la primera vez, lo guarda en `localStorage` y lo manda **solo al registrarse y al iniciar sesión** (cabecera `X-Dispositivo`; en cualquier otra petición no viaja, y una cabecera propia en una lectura obligaría al navegador a un pre-vuelo CORS por cada dirección). Junto con él viaja el **perfil**: rasgos gruesos del equipo —sistema, idioma, zona horaria, pantalla, núcleos, puntos táctiles— (`X-Dispositivo-Perfil`); al perfil el servidor le suma la familia del navegador (Chrome, Windows…, **sin versiones**) que lee del `User-Agent`. No hay canvas, audio, fuentes ni nada que identifique a alguien fuera de esta tienda.

| Qué | Dónde queda | Cómo |
|---|---|---|
| Identificador del dispositivo | MySQL `dispositivo_usuario.dispositivo_hash` y nodo `Dispositivo {hash}` | **SHA-256** con un prefijo propio; el valor en claro no se guarda ni se reenvía |
| Perfil (equipo «parecido») | `dispositivo_usuario.perfil_hash` y nodo `Perfil {hash}` | SHA-256 de los rasgos + familia del navegador |
| Etiqueta legible | `dispositivo_usuario.etiqueta` y `Dispositivo.etiqueta` | «Chrome · Windows», para que una persona reconozca el dispositivo en el panel |
| IP, `User-Agent` completo | — | no se guardan |

### Modelo vigente

- **MySQL** (fuente durable): `dispositivo_usuario` — una fila por `(cuenta, dispositivo)`, con `inicios`, `primera_vez`, `ultima_vez`; único `(id_usuario, dispositivo_hash)`, índices por `dispositivo_hash` y `perfil_hash`. Migración `20261105000000_dispositivo_usuario`. Es lo que permite reconstruir el grafo: antes un grafo vaciado no podía recuperar nada de esto porque no se guardaba.
- **Neo4j** (copia derivada): `(:Usuario)-[:USO_DISPOSITIVO {primera_vez, ultima_vez, inicios}]->(:Dispositivo {hash, etiqueta})-[:TIENE_PERFIL]->(:Perfil {hash})`. Los nodos son **compartidos**, igual que `Correo` para el buzón. Con restricciones de unicidad (`dispositivo_hash_unico`, `perfil_hash_unico`, creadas por `neo4j.asegurarEsquema()` en la primera escritura): dos inicios de sesión simultáneos desde un dispositivo nuevo ejecutan el `MERGE` a la vez, y sin ellas pueden crear dos nodos y partir el grupo en dos.
- Se **elimina** `Nombre` / `SE_LLAMA`: ya no se escriben, y `npm run fraude:backfill` borra los que dejó el diseño anterior. `Usuario.nombre` sigue en el grafo, solo para mostrar.
- Cada escritura que crea un `Usuario` le agrega su `USA_CORREO` (la de dispositivos también): todo `Usuario` del grafo tiene su buzón.

### Cuándo se registra

`authService.login` y `authService.registrar` llaman a `dispositivoService.registrarInicioSeguro`. En el login se anota **con la contraseña ya comprobada y antes de la suspensión**: una cuenta suspendida que intenta entrar desde un dispositivo nuevo es justo la pista que sirve para vincularla con otras; y como solo llega quien sabe la contraseña, nadie puede ensuciar el historial de una cuenta ajena. El upsert de MySQL se espera (un choque con el índice único —dos pestañas— se resuelve sumando el inicio); el reenvío a Neo4j **no se espera**, con el mismo criterio de mejor esfuerzo del resto del grafo. Una falla se registra y **no impide entrar**. Una petición sin cabecera (un script, un cliente viejo) no anota nada: nunca se inventa un dispositivo a partir de datos más débiles.

### Las reglas

| Vínculo entre las cuentas | Señal D (varias cuentas que compran) | Señal F (una le compra a la otra) |
|---|---|---|
| **Mismo buzón** (sin cambios) | **alta** por sí solo | **alta** por sí solo |
| **Mismo dispositivo** | «posible»; sube a «alta» con **otra razón**: más de un dispositivo en común, misma fecha de nacimiento, una autocompra entre ellas, reseñas coordinadas o conducta anómala de alguna | «posible»; sube a «alta» con razones **independientes**: más de un dispositivo en común, misma fecha de nacimiento, o que cualquiera de las dos aparezca en otra señal (reseñas coordinadas, reventa, gasto/categoría/ráfaga). La señal D de las mismas cuentas **no cuenta**: sería el mismo dispositivo dos veces |
| **Perfil parecido** (mismo perfil, otro identificador) | no forma grupos | «posible» (más débil); solo cuenta porque las dos cuentas además **se compran entre sí**, y un perfil compartido por **más de 4 cuentas** se ignora (una configuración corriente) |
| **Mismo nombre** | **ya no cuenta** | **ya no cuenta** |

Por qué el dispositivo parte en «posible» y no en «alta»: una familia, una oficina o un cibercafé comparten computador, y el identificador lo manda el cliente (se puede borrar o falsificar). Es evidencia moderada. Por qué el perfil es más débil todavía: miles de teléfonos iguales comparten sistema, idioma, zona horaria y pantalla. El perfil existe para el que borra los datos del sitio o usa incógnito en cada cuenta —se presenta con un identificador nuevo, pero el equipo es el mismo—, y por eso solo se mira donde ya hay una compra entre las dos cuentas.

**El caso que motivó el cambio.** Dos cuentas llamadas «Fraude Homonimo», con dispositivos y fechas de nacimiento distintos, ya **no forman grupo** (antes: «posible»). Un comprador y un vendedor que se llaman igual, desde dispositivos distintos, ya **no son una autocompra** (antes: confianza «alta», una suspensión). Ambos son controles negativos de `npm run verificar:fraude`.

### Panel `/admin/fraude`

Los vínculos se dibujan como nodos `Dispositivo` compartidos (etiqueta y referencia de 8 caracteres; el hash completo nunca llega al navegador, igual que el del buzón), el diagrama de la autocompra gana «Mismo dispositivo» y «Equipo parecido», y la ficha de cada cuenta lista sus dispositivos (`etiqueta · referencia · inicios · último`): dos cuentas con la **misma referencia** entraron desde el mismo lugar. `enriquecerUsuarios` lee `dispositivo_usuario` y, si esa tabla falla (migración sin aplicar), solo deja la ficha sin esa línea. Términos de Servicio **v1.3**: explican qué se guarda del dispositivo, que solo se guarda una huella irreversible, y que llamarse igual que otra persona no es motivo de revisión.

### Migración

1. `npm run prisma:deploy` (crea `dispositivo_usuario`) y `npx prisma generate` (el `predev` ya lo hace).
2. `npm run fraude:backfill` — borra `Nombre`/`SE_LLAMA`, reenvía productos, compras y reseñas con el modelo nuevo, y reconstruye los dispositivos desde MySQL (al principio, ninguno).
3. Los dispositivos **existen solo desde que el frontend nuevo empezó a mandarlos**: no hay historia que recuperar. Mientras las cuentas no vuelvan a entrar, las señales D y F por dispositivo no encuentran nada; las de buzón no cambian.

### Verificación

- `npm run test:dispositivos` — **16 pruebas aisladas**: las cabeceras que se aceptan y las que se descartan, la familia del navegador (Edge y Opera no se confunden con Chrome, ni el iPhone con macOS), el hash sin el identificador, el perfil estable entre versiones, el registro con MySQL y Neo4j de mentira (el identificador en claro nunca llega a ninguno; el choque `P2002` de dos pestañas; Neo4j apagado no estorba; una falla de MySQL no impide entrar), la ficha del panel y lo que genera el navegador (identificador persistido, almacenamiento bloqueado, solo ASCII imprimible, y que las cabeceras viajan **únicamente** en login y registro).
- `npm run verificar:fraude` (reescrita; contra MySQL, Mongo, Neo4j, Redis y los servicios reales): dispositivo + misma fecha de nacimiento → alta; dispositivo solo → posible sin corroboradores; dos dispositivos → alta; **homónimos → sin grupo**; anillo por buzón → alta; dispositivo + buzón → alta sin corroboradores; cadena de tres cuentas unida (A–B por dispositivo, B–C por buzón); en F: dispositivo compartido → posible, buzón → alta, equipo parecido → posible, dos dispositivos → alta, autoventa anterior a la regla → posible, **homónimos que se compran → sin señal**, perfil de 5 cuentas → ignorado; y sobre el grafo: sin `Nombre`, `Dispositivo`/`Perfil` solo con hashes, **el identificador en claro no está en ningún nodo ni en MySQL**, las restricciones de unicidad existen y **cuatro inicios simultáneos desde el mismo dispositivo nuevo dejan un solo nodo y dos aristas**.
- **Probado en el navegador:** el registro y el inicio de sesión mandan `X-Dispositivo` y `X-Dispositivo-Perfil` (pre-vuelo CORS incluido), el identificador queda en `localStorage`, y dos cuentas creadas desde el mismo navegador aparecen en MySQL y en Neo4j con el **mismo** dispositivo (y los hash, no el valor); `/admin/fraude` muestra los vínculos, las razones y los dispositivos de cada ficha. El barrido en marcha suspendió o limitó solo cuentas sintéticas `fraude.*`.

### Límites honestos

- **El identificador lo manda el cliente.** Quien lo conoce puede falsificarlo o rotarlo (borrar los datos del sitio, una ventana de incógnito por cuenta). El perfil cubre al que lo hace sin saber que lo miran; al que lo hace con método, no. Se detecta al descuidado, no al determinado.
- **Falsos positivos por computadores compartidos.** Una familia o un cibercafé quedan vinculados. Por eso el dispositivo solo es «posible» y sube con corroboración, y por eso un caso cerrado por una persona no se reabre por el mismo hallazgo.
- **Sin historia.** No hay dispositivos de antes del cambio; hasta que las cuentas vuelvan a entrar, la señal es ciega para ellas.
- **El perfil es una pista débil** y puede coincidir por casualidad entre dos equipos iguales (el tope de 4 cuentas lo acota, no lo elimina).
- **Un inicio de sesión no es una compra.** Dos cuentas que entraron desde el mismo navegador una sola vez cuentan igual que dos que lo comparten a diario; no se pondera la frecuencia (`inicios` se guarda, pero no decide nada).
- **Efecto en el desarrollo.** Dos cuentas que se usan **desde el mismo navegador** y se compran entre sí —el comprador y el vendedor de una demostración— quedan vinculadas por dispositivo: la autocompra es «posible» (límites suaves) y, si las dos además tienen compras, la señal D sube a «alta» por esa misma autocompra y el barrido suspende a ambas 24 h. Es el comportamiento previsto para una persona con dos cuentas; para una demostración conviene usar **perfiles de navegador distintos** (o ventanas de incógnito: otro identificador, aunque el perfil parecido lo deja en «posible») o `FRAUDE_BLOQUEO_ENABLED=false`.

## 23. El panel en dos ventanas, con filtros por cuenta, probabilidad, relación y vínculo (2026-11-07)

**Pedido.** Que `/admin/fraude` se pueda filtrar por usuario, probabilidad y relación, y que tenga dos ventanas: a la izquierda la lista de siempre y a la derecha los datos del caso elegido (quién, cuándo y los factores que importan).

**Qué cambió (solo el frontend; `GET /api/admin/fraude` no se tocó).**

- **Dos ventanas.** Izquierda: las mismas siete secciones y tarjetas (insignia de confianza, resumen de una línea, aclaración y «corroborado por»); la tarjeta ahora es un botón que abre el caso a la derecha en vez de desplegarlo debajo. Derecha: las **cuentas involucradas** (la ficha de siempre, con sus dispositivos y la insignia de suspendida o bajo vigilancia), **cuándo** (primer y último pedido, el día de la ráfaga, cuándo se crearon las cuentas, último inicio desde el dispositivo compartido), **datos clave** (las cifras que más pesan de cada señal), **por qué se marcó**, el diagrama de **relaciones** o las barras de magnitud, y **otros casos de estas cuentas** (cualquier otra señal que involucre a alguna de ellas, con un clic para saltar). El panel queda fijo a la vista, justo debajo de la cabecera del sitio (se mide su altura), y se desplaza por sí solo.
- **Filtros**, en el navegador y sobre lo que ya llegó: **cuenta** (nombre, correo o `#id`; sin tildes ni mayúsculas; todas las palabras deben calzar con la *misma* cuenta del caso), **probabilidad** (alta, posible y «sin nivel»: las reseñas coordinadas no se cruzan con otras señales y el servidor no les da nivel), **relación** (el tipo de hallazgo, siete) y **vínculo entre cuentas** (mismo dispositivo, mismo buzón de correo, equipo parecido, misma cuenta). Cada opción dice cuántos casos habría al elegirla **con los demás filtros puestos** (como las facetas disyuntivas de la tienda) y una opción sin casos queda desactivada.
- **En la URL:** `?usuario=&nivel=&relacion=&vinculo=&caso=`. Un enlace copiado, recargar o «atrás» reproducen la vista; un `caso` que ya no existe dice «Este caso ya no aparece». Cambiar un filtro no cierra el caso abierto: si deja de calzar, el panel lo avisa.
- **Celular.** Las dos ventanas se turnan: la lista, o el caso con «← Volver a la lista» (que devuelve al mismo punto de la lista); los filtros se ocultan mientras hay un caso abierto.
- **Corrección de paso.** La tarjeta de autocompra decía «Compra entre cuentas de una misma persona: alta por sí sola» también cuando el vínculo era solo el dispositivo o un equipo parecido, que arrancan en «posible» (§22): una insignia «posible» con una nota que decía «alta». Ahora la nota sale solo con el buzón compartido.

**Archivos.** `frontend/src/utils/fraudeCasos.js` (nuevo; funciones puras: aplanar las siete listas en «casos», filtrar, contar por opción, otros casos de la misma cuenta, la URL), `frontend/src/components/admin/FiltrosFraude.jsx` (nuevo) y `frontend/src/pages/admin/AdminFraudePage.jsx` (reorganizada: cada señal declara en una tabla qué muestra en la lista y en el panel).

**Verificación.** `npm run test:fraudePanel`: **41 pruebas aisladas** (clave estable de cada caso, vínculos, filtro por cuenta con tildes, `#id` y «misma cuenta», filtros combinados, conteos disyuntivos, otros casos, URL de ida y vuelta, duraciones). Revisión por mutación: **31 de 31** cambios al módulo hacen fallar alguna prueba. `npm run lint` sin errores y `npm run build` correcto. Probado en un navegador, en escritorio (1360 px) y en celular (375 px): los 30 casos de un conjunto de prueba se abren sin errores, filtros y URL, el panel fijo bajo la cabecera, un caso que el filtro deja fuera, un caso inexistente y una cuenta sin ficha. **Se probó con una API desechable, no con la real:** ese día MySQL no era alcanzable desde el anfitrión (Windows tenía reservado el puerto 3306), así que las señales eran las reales del grafo de Neo4j y las fichas de cuenta se inventaron con la forma de `FichaUsuario`; falta una pasada con la API completa.

**Límites.** El filtrado es del lado del cliente (decenas de casos: si llegaran a cientos habría que paginar o filtrar en el servidor); el nivel «sin nivel» solo existe para las reseñas coordinadas; elegir un caso agrega una entrada al historial (para que «atrás» funcione en el celular) y los filtros la reemplazan.
