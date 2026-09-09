# Plan — Neo4j para detección de fraude (Entrega 2)

> Creado: 2026-09-08. Plan de implementación, no implementación todavía — la idea es cerrar el diseño acá, con confirmación explícita, antes de tocar código o `docker-compose.yml` (mismo criterio que se usó antes de construir §4.2/§4.5 de [ENTREGA-2-PLAN.md](ENTREGA-2-PLAN.md)).

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

- `checkoutService.checkout()` y `checkoutService.checkoutOferta()`: después de confirmar la compra (mismo punto donde ya se reenvía a Mongo/Redis/outbox de ventas), reenviar de mejor esfuerzo: `MERGE` del nodo `Usuario` y `Producto` si no existen, relación `COMPRÓ`, y `MERGE` de `Direccion`/`MetodoPago` + `ENVIÓ_A`/`PAGÓ_CON` a partir de `direccionId`/`metodoPagoId` ya presentes en la misma llamada.
- `resenaService.crear()`: después de guardar la reseña, reenviar de mejor esfuerzo la relación `RESEÑÓ`.
- `MERGE`, no `CREATE`, en todos los casos — reintentar un reenvío que ya se aplicó no debe duplicar nodos ni relaciones (mismo principio de idempotencia que ya rige en Cassandra, ADR-004 §4).

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

¿Avanzamos con esto tal cual, o hay algo del modelo (§5), las señales (§3/§4) o los parámetros (§10) que preferís ajustar antes de que empiece a construirlo?
