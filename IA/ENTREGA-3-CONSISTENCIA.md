# Estrategia de consistencia — checkout distribuido (Entrega 3)

> Creado: 2026-09-08/09. Responde al requerimiento del PRD, Entrega 3: identificar cada componente involucrado en el checkout, mapear puntos de falla posibles, documentar el mecanismo de mitigación de cada uno, y probar al menos una falla simulada con evidencia real. No inventa arquitectura nueva — el sistema ya tenía varios mecanismos de consistencia distintos, construidos en momentos distintos por razones distintas; este documento es la primera vez que se juntan, se comparan, y se prueban de verdad contra una base caída, no contra un doble/mock.

---

## 1. Por qué el checkout es distribuido, aunque su núcleo sea una sola transacción

`checkoutService.checkout()`/`checkoutOferta()` siguen siendo, en su núcleo, **una única transacción de Prisma sobre MySQL** — pedido, líneas, pago, descuento de inventario y (desde el panel de ventas) el outbox se confirman o se revierten juntos, sin excepción, ya verificado desde la Fase Inicial (`verificarCheckout.js`). Eso no cambió y este documento no lo toca.

Lo que sí es distribuido es todo lo que pasa **después** de que esa transacción confirma: el pedido ya es real e irreversible en MySQL en ese momento, pero el sistema todavía tiene que reflejarlo en Mongo (catálogo), Redis (carrito) y, eventualmente, Cassandra (panel de ventas) — tres escrituras a bases distintas, ninguna de ellas parte de la transacción de MySQL, cada una con su propia forma de fallar.

## 2. Inventario de puntos de escritura cruzada

| # | Origen → Destino | Qué se escribe | Cuándo | Mecanismo hoy |
|---|---|---|---|---|
| 1 | MySQL (`compra`) → Mongo (`Producto`) | `total_vendido`, `inventario.cantidad` | Después de confirmar el checkout, fuera de la transacción | Mejor esfuerzo (fire-and-forget) — `try/catch` propio, `console.error` si falla, no revierte nada |
| 2 | MySQL (`compra`) → Redis (`carrito:{usuarioId}`) | Vaciado del carrito | Después de confirmar el checkout, fuera de la transacción | Mejor esfuerzo — `try/catch` independiente del anterior; el frontend también lo pide aparte, de forma redundante |
| 3 | MySQL (`checkout`) → MySQL (`venta_outbox`) | Snapshot de la venta (`payload`) | **Dentro** de la misma transacción del checkout | Atómico — no es un punto de falla distribuido, se revierte junto con todo lo demás si falla |
| 4 | MySQL (`venta_outbox`) → Cassandra (`ventas_por_dia`/`ventas_por_producto_mes`) | Proyecciones de venta | Cada 30s (worker) + al confirmar el checkout intenta procesar lo pendiente | **Outbox durable**: reintentos con backoff exponencial, marca `procesado_en` solo tras escribir las dos tablas, entrega *at-least-once* con escritura idempotente (ver ADR-004 §5) |
| 5 | Redis (`oferta:*`/`oferta-recomendada:*`) → MySQL (`checkoutOferta`) | Admisión ya otorgada, compra falla en MySQL | Si la guardia 2 (MySQL) rechaza después de que la guardia 1 (Redis) admitió | Compensación — `INCRBY` que revierte el descuento ya hecho en Redis, mejor esfuerzo |
| 6 | MySQL (`producto`) → Mongo (`Producto`, `ProductoEvento`) | Catálogo completo de un producto nuevo | Al crear un producto (`productoService.crear()`) | Compensación — si Mongo falla, se borra la fila de MySQL ya creada; **no está probado qué pasa si la compensación misma falla** (ver §4) |

Los puntos 1, 2 y 6 son best-effort clásico. El punto 4 es el único con una garantía de entrega fuerte (outbox + reintentos), porque fue diseñado explícitamente para eso (ADR-004). El punto 5 es una compensación puntual sobre una operación de admisión, no sobre un dato persistente.

## 3. Por qué la fuerza de la garantía no es la misma en todos los puntos — a propósito

No es inconsistencia del proyecto: es una decisión repetida, cada vez con el mismo criterio — **la fuerza de la garantía depende de qué tan caro es que ese dato quede desactualizado, no de una regla uniforme "todo cross-database debe ser igual de robusto".**

- **Carrito (Redis, punto 2):** si el vaciado falla, el peor caso es que el usuario vea en su carrito algo que ya compró — molesto, pero el TTL de 7.5 min lo resuelve solo, y no hay ningún dato incorrecto en juego (el carrito nunca fue la fuente de verdad de nada).
- **Catálogo (Mongo, punto 1):** si el reenvío falla, `total_vendido`/`inventario.cantidad` quedan desactualizados en Mongo — un problema real (un comprador podría ver stock que ya no existe), pero acotado y con reparación manual ya construida (`recalcular-ventas`/`recalcular-inventario`, probado en §5).
- **Ventas para el panel (Cassandra, punto 4):** perder o duplicar una venta en el panel de análisis es la clase de error que un informe financiero no debería tener nunca, incluso ante una caída — de ahí la inversión en outbox durable en vez de un `try/catch` best-effort.

Esta jerarquía no estaba escrita en ningún lado como principio explícito antes de este documento — estaba implícita en cada decisión por separado (ADR-002 §3.3, ADR-004 §5). Vale como criterio para el próximo punto de integración también: al diseñar el reenvío hacia Neo4j ([PLAN-NEO4J-DETECCION-FRAUDE.md](PLAN-NEO4J-DETECCION-FRAUDE.md) §6), se eligió mejor esfuerzo explícitamente porque una señal de fraude tarde unos segundos de más no tiene el mismo costo que una venta perdida del panel — la misma pregunta ("¿qué tan caro es que esto llegue tarde o se pierda?"), aplicada de nuevo.

## 4. Punto de falla identificado, no mitigado

El PRD pide **mapear** puntos de falla, no que todos estén resueltos. Uno real, encontrado al escribir este documento: en `productoService.crear()` (punto 6), si el paso de Mongo falla, el código borra la fila de MySQL ya creada (`prisma.inventario.deleteMany` + `prisma.producto.delete`) — pero si **esa** compensación también falla (por ejemplo, MySQL se vuelve inalcanzable en la misma ventana en la que Mongo ya lo era), queda una fila de `producto`/`inventario` en MySQL sin ningún documento `Producto` en Mongo. Ninguno de los dos `recalcular-*` existentes lo repara: ambos recorren documentos `Producto` **ya existentes** en Mongo para refrescar sus campos, ninguno crea documentos que faltan. Es una ventana angosta (dos fallos encadenados, no uno), pero real y sin mitigación hoy — queda anotado para no perderlo, no se resuelve en este documento.

## 5. Prueba de falla simulada — evidencia real, no mockeada

A diferencia de las 17 pruebas de `test:ventas` (que sí usan dobles de dependencias, ver ADR-004 §9), esto corrió contra los contenedores reales, deteniéndolos con `docker compose stop` y ejecutando un checkout real (`backend/scripts/intentarCheckoutReal.js`) con datos reales — la intención es capturar el comportamiento tal cual lo vería un usuario, no una simulación en el código.

### Escenario 1 — Mongo caído durante el checkout

```
docker compose stop mongo
node scripts/intentarCheckoutReal.js
```

Resultado real:
```
inventario MySQL antes: { cantidad: 17 }
No se pudo actualizar total_vendido/cantidad en Mongo: connect ECONNREFUSED ::1:27018, connect ECONNREFUSED 127.0.0.1:27018
RESULTADO: checkout() no lanzó excepción.
  compra.id: 51 | pago.estado: aprobado
inventario MySQL después: { cantidad: 16 }
```

La compra se confirmó igual (id 51, pago aprobado, inventario real descontado 17→16) — el fallo de Mongo quedó atrapado y registrado, sin tocar la transacción de MySQL. Con Mongo todavía caído, `GET /api/productos/1` seguía devolviendo `inventario.cantidad: 17` — el dato quedó desactualizado, tal como predice §2/§3, no autocorregido.

Al levantar Mongo de nuevo (`docker compose start mongo`), la desactualización **persistió** — no se autorepara sola con solo que Mongo vuelva. Recién al llamar `POST /api/admin/recalcular-inventario` el valor pasó a `16`, coincidiendo con MySQL. Confirma que la reparación manual documentada es necesaria y que efectivamente funciona — no es solo una promesa en un comentario.

### Escenario 2 — Cassandra caído durante el checkout

```
docker compose stop cassandra
node scripts/intentarCheckoutReal.js
```

Resultado real:
```
inventario MySQL antes: { cantidad: 16 }
RESULTADO: checkout() no lanzó excepción.
  compra.id: 52 | pago.estado: aprobado
inventario MySQL después: { cantidad: 15 }
```

Ninguna excepción ni siquiera se imprimió desde este script — porque el punto 3 (checkout → `venta_outbox`) es parte de la misma transacción de MySQL y no depende de Cassandra en absoluto; el punto 1 (→ Mongo) tampoco falló esta vez, Mongo ya estaba arriba. El único componente afectado fue el worker en segundo plano del backend ya corriendo, que sí intentó procesar el pendiente y falló:

```
venta_outbox para compra 52:
  procesado_en: null,
  intentos: 1,
  proximo_intento: "2026-09-09T03:30:52.789Z",
  ultimo_error: "All host(s) tried for query failed."
```

Nada se perdió: la fila del outbox quedó con su `payload` intacto, un reintento programado con backoff, y el error real capturado — exactamente el comportamiento que documenta ADR-004 §5.

Al levantar Cassandra de nuevo (`docker compose start cassandra`, esperando su healthcheck), **sin ninguna intervención manual** — no hizo falta correr `ventas:sincronizar` a mano, el worker que ya corría en el backend en segundo plano lo recogió solo en su siguiente ciclo de 30s:

```
outbox compra 52 (después): procesado_en: "2026-09-09T03:31:22.830Z", intentos: 2, ultimo_error: null
```

Y la fila efectivamente llegó a Cassandra (partición `dia`, calculada en hora de Guatemala UTC−6 — la venta ocurrió a las 03:30 UTC, que todavía es "2026-09-08" en Guatemala, no "09"):

```
cqlsh> SELECT dia, detalle_id, compra_id, cantidad, importe FROM tiendaya_analytics.ventas_por_dia WHERE dia = '2026-09-08' ALLOW FILTERING;

 dia        | detalle_id | compra_id | cantidad | importe
------------+------------+-----------+----------+---------
 2026-09-08 |         52 |        52 |        1 |   54.93
```

**Contraste real entre los dos escenarios, con evidencia y no solo con la intención de diseño:** el Escenario 1 (Mongo) dejó un dato desactualizado que necesitó una llamada manual a `recalcular-inventario` para corregirse — el sistema no se autorepara solo con que la base vuelva. El Escenario 2 (Cassandra) se recuperó completamente solo, sin ninguna acción humana, en menos de un minuto. Es exactamente la diferencia que predice §3: más inversión en la garantía (outbox durable) donde perder el dato es más caro (ventas para un informe financiero), menos inversión donde no lo es (una caché de catálogo, reparable a demanda).

## 6. Qué queda para el informe final de Entrega 3

Este documento cubre el requerimiento de consistencia. Separado de esto, sigue pendiente el buscador (§ Entrega 3 del PRD, `productoService.listar()` hoy solo tiene un `$regex` simple, ya marcado como insuficiente en su propio comentario) — no es parte de este documento a propósito, son dos requerimientos distintos de la misma entrega.
