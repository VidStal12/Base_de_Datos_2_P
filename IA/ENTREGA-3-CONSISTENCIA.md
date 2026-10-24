# Estrategia de consistencia — checkout distribuido (Entrega 3)

> **Actualización 2026-10-17:** el checkout HTTP normal y flash ahora exige un intento durable e idempotente. El pedido y el resultado del intento se confirman juntos en MySQL. La reserva/devolución flash tiene identificador, Lua idempotente y recuperación de compensaciones pendientes; esto reemplaza la compensación flash de un solo intento descrita en el punto 5 y en las pruebas históricas de este documento. La compra por recomendaciones conserva su mecanismo anterior. Ver [CHECKOUT-IDEMPOTENCIA.md](CHECKOUT-IDEMPOTENCIA.md) para el flujo vigente, resumen del escenario de duplicación y evidencia de integración real.

> **Actualización 2026-10-20:** el requerimiento se pensó para comprobarse **en vivo**: con la aplicación corriendo se apaga en Docker el contenedor de una o de varias bases, y la aplicación tiene que seguir siendo utilizable, solo que sin los datos de esa base. Medido con los contenedores realmente detenidos, **no lo cumplía** (con Redis apagado hasta el catálogo público tardaba ~108 s por petición y el carrito y el checkout no respondían; con Neo4j una compra tardaba 31 s; con MySQL el login devolvía `401` con el texto crudo de Prisma y la interfaz cerraba la sesión). **Ya lo cumple**: la nueva §7 tiene la medición antes/después de las seis bases, solas y combinadas, el diseño, los riesgos aceptados y cómo probarlo en vivo. Con eso se resuelve el tercer punto de §4 (Redis no falla rápido) y se corrigen dos filas de §5.4 (Mongo).

> Creado: 2026-09-08/09; §5 rehecho el 2026-10-06 con `backend/scripts/demo_consistencia_compra.js --falla=…` (seis escenarios con aserciones, ver §5). Responde al requerimiento del PRD, Entrega 3: identificar cada componente involucrado en el checkout, mapear puntos de falla posibles, documentar el mecanismo de mitigación de cada uno, y probar al menos una falla simulada con evidencia real. No inventa arquitectura nueva — el sistema ya tenía varios mecanismos de consistencia distintos, construidos en momentos distintos por razones distintas; este documento es la primera vez que se juntan, se comparan, y se prueban de verdad contra una base caída, no contra un doble/mock.

---

## 1. Por qué el checkout es distribuido, aunque su núcleo sea una sola transacción

`checkoutService.checkout()`/`checkoutOferta()` siguen siendo, en su núcleo, **una única transacción de Prisma sobre MySQL** — pedido, líneas, pago, descuento de inventario, (desde el panel de ventas) el outbox y (desde el compromiso de no reventa) la constancia que el vendedor aceptó se confirman o se revierten juntos, sin excepción, ya verificado desde la Fase Inicial (`verificarCheckout.js`). Eso no cambió y este documento no lo toca.

Lo que sí es distribuido es todo lo que pasa **después** de que esa transacción confirma: el pedido ya es real e irreversible en MySQL en ese momento, pero el sistema todavía tiene que reflejarlo en Mongo (catálogo), Redis (carrito), Neo4j (grafo de fraude) y, eventualmente, Cassandra (panel de ventas) — cuatro escrituras a bases distintas, ninguna de ellas parte de la transacción de MySQL, cada una con su propia forma de fallar.

## 2. Inventario de puntos de escritura cruzada

| # | Origen → Destino | Qué se escribe | Cuándo | Mecanismo hoy |
|---|---|---|---|---|
| 1 | MySQL (`compra`) → Mongo (`Producto`) | `total_vendido`, `inventario.cantidad` | Después de confirmar el checkout, fuera de la transacción | Mejor esfuerzo (fire-and-forget) — `try/catch` propio, `console.error` si falla, no revierte nada; sin reintento: la copia queda desfasada hasta una reparación a demanda (`recalcular-*`). (La lectura de Mongo que hace `checkout()` ANTES de la transacción, para comprobar que el producto esté activo, es otra cosa: si falla, rechaza sin tocar MySQL — §5, escenario 1a) |
| 2 | MySQL (`compra`) → Redis (`carrito:{usuarioId}`) | Vaciado del carrito | Después de confirmar el checkout, fuera de la transacción | Mejor esfuerzo — `try/catch` independiente del anterior; el frontend también lo pide aparte, de forma redundante |
| 3 | MySQL (`checkout`) → MySQL (`venta_outbox`) | Snapshot de la venta (`payload`) | **Dentro** de la misma transacción del checkout | Atómico — no es un punto de falla distribuido, se revierte junto con todo lo demás si falla |
| 4 | MySQL (`venta_outbox`) → Cassandra (`ventas_por_dia`/`ventas_por_producto_mes`) | Proyecciones de venta | Cada 30 s (worker del backend) o a demanda (`npm run ventas:sincronizar`); el checkout ya no intenta procesar nada | **Outbox durable**: reintentos con backoff exponencial, marca `procesado_en` solo tras escribir las dos tablas, entrega *at-least-once* con escritura idempotente (ver ADR-004 §5) |
| 5 | Redis (`oferta:{id}:stock`/`oferta-recomendada:*`) → MySQL (`checkoutOferta`) | Admisión ya otorgada, compra falla en MySQL | Si la guardia 2 (MySQL) rechaza después de que la guardia 1 (Redis) admitió | Compensación — `INCRBY` que revierte el descuento ya hecho en Redis, mejor esfuerzo |
| 6 | MySQL (`producto`) → Mongo (`Producto`, `ProductoEvento`) | Catálogo completo de un producto nuevo | Al crear un producto (`productoService.crear()`) | Compensación — si Mongo falla, se borra la fila de MySQL ya creada; **no está probado qué pasa si la compensación misma falla** (ver §4) |
| 7 | Mongo (`Producto`) → Redis (`oferta:{id}:datos`/`:revision`) | Invalidación de la copia del producto que guarda la oferta flash activa | Al editar el producto, configurar o pausar la oferta, crear una reseña (cambia el resumen) o reconciliar el inventario (cambia el precio normal) | Mejor esfuerzo, con el **mismo protocolo de revisión que el carrito**: el escritor solo sube la revisión y borra el hash (nunca publica); la siguiente lectura regenera desde Mongo y solo publica si la revisión no cambió, así que una lectura lenta no resucita datos viejos. Si la invalidación falla, la copia vieja sobrevive **como máximo 600 s**: cada lectura renueva el TTL de 450 s, así que sin un tope de edad una oferta muy consultada no la soltaría hasta su fin, y el precio de oferta que se cobra **sí sale de esa copia**; pasado el tope, la lectura la descarta y regenera. El stock real y el precio normal los valida MySQL al confirmar |
| 8 | Neo4j (hallazgos «alta» y «posible») → MySQL (`bloqueo_cuenta`) → Redis (`bloqueo:{id}` o `restriccion:{id}`) | El caso de suspensión (o de vigilancia con límites suaves) de una cuenta y su candado con TTL | Cada 60 s (barrido) o «Revisar ahora»; también al liberar o extender un administrador | **MySQL primero** (el caso, durable, único `(id_usuario, huella, tipo)` que impide suspender —o limitar— dos veces por el mismo hallazgo), **Redis después** (best-effort: si falla, el caso ya quedó). `reconciliar()` repone los candados que falten desde los casos activos — con lo que les falta, no con tiempo nuevo —, quita los que no tienen caso y marca como vencidos los que pasaron. Una liberación va en el mismo orden, y un reintento tras una a medias quita el candado que quedó |
| 9 | Redis (`bloqueo:{id}`) → catálogo, buscador, sugerencias, detalle, recomendaciones, carrito, pedidos y ofertas flash | Qué productos se muestran y se pueden comprar: los de un **vendedor suspendido** no | En cada consulta de catálogo, búsqueda, carrito o pedido (`vendedoresSuspendidos`: un `SCAN` con memo de 3 s) | **No hay copia que sincronizar:** la visibilidad se **deriva** del candado en cada lectura, sin escribir nada en Mongo, Elasticsearch ni Redis por producto. Vuelve sola: al liberar un administrador (el memo se invalida: al instante) o al vencer el TTL (≤ 3 s). **Falla abierto**: sin Redis no se oculta a nadie. `verificarVendedoresActivos` (MySQL, la autoridad) rechaza la compra aunque una copia vieja —un carrito armado antes, una recomendación cacheada— todavía lo muestre |
| 10 | MySQL (`compra`) → Neo4j (`COMPRÓ`) | La arista de la compra en el grafo de detección de fraude | Después de confirmar el checkout, fuera de la transacción (`checkout()` y `checkoutOferta()`) | Mejor esfuerzo — `try/catch` propio, independiente de los reenvíos a Mongo y Redis; sin cola. Es un `MERGE` con clave natural `detalle_id`, así que reenviar la misma compra no duplica: `npm run fraude:backfill` repara lo que falte (§5, escenario 4) |

Los puntos 1, 2, 6, 7 y 10 son best-effort clásico. El punto 4 es el único con una garantía de entrega fuerte (outbox + reintentos), porque fue diseñado explícitamente para eso (ADR-004). El punto 5 es una compensación puntual sobre una operación de admisión, no sobre un dato persistente, y el 7 es una caché derivada con vida acotada: el peor caso es servir hasta 10 minutos un dato atrasado (en el peor de los casos el precio de oferta, por una invalidación perdida), nunca más allá del fin de la oferta ni del inventario real, que sigue validando MySQL. El punto 8 es distinto de todos los demás: la copia de Redis **no es una caché de lectura sino un control de acceso**, así que su orden de escritura (primero el registro durable, después el candado) y su vuelta a la verdad tras un fallo (`reconciliar()`) importan más; ver §3.

## 3. Por qué la fuerza de la garantía no es la misma en todos los puntos — a propósito

No es inconsistencia del proyecto: es una decisión repetida, cada vez con el mismo criterio — **la fuerza de la garantía depende de qué tan caro es que ese dato quede desactualizado, no de una regla uniforme "todo cross-database debe ser igual de robusto".**

- **Carrito (Redis, punto 2):** si el vaciado falla, el peor caso es que el usuario vea en su carrito algo que ya compró — molesto, pero el TTL de 7.5 min lo resuelve solo, y no hay ningún dato incorrecto en juego (el carrito nunca fue la fuente de verdad de nada).
- **Catálogo (Mongo, punto 1):** si el reenvío falla, `total_vendido`/`inventario.cantidad` quedan desactualizados en Mongo — un problema real (un comprador podría ver stock que ya no existe), pero acotado y con reparación manual ya construida (`recalcular-ventas`/`recalcular-inventario`, probado en §5).
- **Ventas para el panel (Cassandra, punto 4):** perder o duplicar una venta en el panel de análisis es la clase de error que un informe financiero no debería tener nunca, incluso ante una caída — de ahí la inversión en outbox durable en vez de un `try/catch` best-effort.

Esta jerarquía no estaba escrita en ningún lado como principio explícito antes de este documento — estaba implícita en cada decisión por separado (ADR-002 §3.3, ADR-004 §5). Vale como criterio para el próximo punto de integración también: al diseñar el reenvío hacia Neo4j ([PLAN-NEO4J-DETECCION-FRAUDE.md](PLAN-NEO4J-DETECCION-FRAUDE.md) §6), se eligió mejor esfuerzo explícitamente porque una señal de fraude tarde unos segundos de más no tiene el mismo costo que una venta perdida del panel — la misma pregunta ("¿qué tan caro es que esto llegue tarde o se pierda?"), aplicada de nuevo.

La misma lógica aplica al revés para las **reglas de negocio**: una copia derivada puede quedar atrasada, así que nunca es la única barrera de una regla. La regla "nadie compra lo que vende" (2026-10-04, [PLAN-NEO4J-DETECCION-FRAUDE.md](PLAN-NEO4J-DETECCION-FRAUDE.md) §18) consulta `producto.id_vendedor` en MySQL, la fuente transaccional, y no el `vendedor_id` que Mongo cachea en el catálogo; y se evalúa **antes** de tocar stock o Redis, de modo que un rechazo no deja nada que compensar (ni pedido, ni unidad descontada, ni cupo de oferta gastado) — no agrega ningún punto de escritura cruzada nuevo a la tabla de §2.

El **compromiso de no reventa** (2026-10-04, [PLAN-NEO4J-DETECCION-FRAUDE.md](PLAN-NEO4J-DETECCION-FRAUDE.md) §19) sigue el mismo criterio. Lo exige el servidor (`compromisoService`), que lee el rol de MySQL y no confía en lo que mande el cliente, y lo hace en el mismo lugar y orden que la regla anterior — después de ella y antes de tocar stock o Redis, así que en la oferta flash y la recomendación un vendedor sin compromiso no gasta cupo. Su **constancia** (`compra.no_reventa_aceptada_en`) se guarda **dentro de la transacción del pedido**: o queda con el pedido o no hay pedido; no es un reenvío que pueda fallar por separado, y por eso no entra en la tabla de §2. Lo que sí es una copia derivada es el grafo de Neo4j donde se detecta quien lo rompe, que sigue siendo de mejor esfuerzo; desde la suspensión temporal de cuentas (2026-10-04, [§20](PLAN-NEO4J-DETECCION-FRAUDE.md)) una reventa de confianza alta ya no solo se señala: suspende la cuenta hasta que una persona la revise — ver el párrafo siguiente.

La **suspensión temporal de cuentas** (punto 8) es el único lugar donde una copia derivada *actúa* sobre una persona, y por eso tiene dos reglas que ningún otro punto necesita. **(1) El hallazgo no es la autoridad de la decisión:** la tabla `bloqueo_cuenta` guarda el caso y quién lo revisó, y un hallazgo suspende a una cuenta una sola vez (único por cuenta y hallazgo) — porque el grafo no olvida, y sin eso lo liberado o vencido se volvería a suspender cada minuto. **(2) Falla abierto, a propósito:** si Redis no responde, la cuenta se trata como no suspendida. Aplicando la pregunta de arriba — «¿qué tan caro es que esto llegue tarde o se pierda?» —, dejar sin acceso a todo el sitio durante una caída de Redis cuesta más que dejar que una cuenta suspendida actúe unos minutos, y en cuanto Redis vuelve la reconciliación restablece los candados desde MySQL (probado contra un Redis real en `verificar:bloqueo`: se borra el candado y se reconstruye con lo que le faltaba). Las cuentas de administrador quedan fuera del automatismo: no puede dejar sin acceso a quienes pueden deshacerlo.

El punto 9 es la decisión de diseño opuesta a las demás, a propósito: **una copia derivada que no se sincroniza porque no se guarda.** Ocultar los productos de un vendedor suspendido pudo ser «marcar cada producto como oculto» (en Mongo, en Elasticsearch, en las recomendaciones cacheadas, en las ofertas) y desmarcarlos al liberar; eso habría sido un reenvío por cada copia —cada uno con su propia forma de fallar a medias y dejar un producto oculto para siempre—. En su lugar, cada lectura pregunta por el candado: un vendedor vuelve **en el mismo instante** en que el candado desaparece, sea porque un administrador lo libera o porque Redis lo vence, y no hay estado que reparar. El costo es una consulta a Redis por lectura (acotada por el memo de 3 s) y la pregunta de siempre —«¿qué tan caro es que esto llegue tarde?»—: si el TTL vence solo, el producto tarda hasta 3 s en reaparecer; para la compra, la autoridad es MySQL, no ninguna copia.


## 4. Puntos de falla identificados, no mitigados

El PRD pide **mapear** puntos de falla, no que todos estén resueltos. Uno real, encontrado al escribir este documento: en `productoService.crear()` (punto 6), si el paso de Mongo falla, el código borra la fila de MySQL ya creada (`prisma.inventario.deleteMany` + `prisma.producto.delete`) — pero si **esa** compensación también falla (por ejemplo, MySQL se vuelve inalcanzable en la misma ventana en la que Mongo ya lo era), queda una fila de `producto`/`inventario` en MySQL sin ningún documento `Producto` en Mongo. Ninguno de los dos `recalcular-*` existentes lo repara: ambos recorren documentos `Producto` **ya existentes** en Mongo para refrescar sus campos, ninguno crea documentos que faltan. Es una ventana angosta (dos fallos encadenados, no uno), pero real y sin mitigación hoy — queda anotado para no perderlo, no se resuelve en este documento.

**Un segundo punto, más probable que el anterior, encontrado el 2026-10-06 al inyectar un fallo en `ProductoEvento.create`** (el paso que sigue a `Producto.create` dentro de `crear()`): la compensación borra la fila de MySQL pero **no** el documento de Mongo que ya se había creado. Verificado contra las bases reales: el documento queda con `estado: activo`, aparece en el catálogo público (`GET /api/productos`) y `GET /api/productos/:id` responde 200, sin fila de `producto` ni de `inventario` en MySQL — un producto fantasma que se ve y no se puede comprar. Basta **un** fallo (no dos encadenados). Ningún `recalcular-*` lo repara: `recalcular-inventario` lo informa en `productos_omitidos` (no tiene inventario en MySQL) pero no lo borra ni lo desactiva. Arreglo propuesto, **no aplicado**: que la compensación deshaga también el documento y el evento de Mongo (en orden inverso a la creación), y un barrido que detecte documentos sin fila en MySQL.

**Un tercer punto, medido el 2026-10-06: un Redis realmente caído no falla rápido.** Los `await` a Redis del camino de una petición —la invalidación del carrito tras el commit de `checkout()`, y las consultas de suspensión y de tope de pedidos que `requireAuth`/`controlPedidos` hacen antes de empezar— dependen de que ioredis se rinda. Con sus opciones por defecto (`maxRetriesPerRequest: 20` y cola offline activa; `config/redis.js` no las cambia), un comando contra un Redis que rechaza conexiones tardó **73 s en rechazarse en esta máquina Windows** (medido con un cliente contra un puerto cerrado; unos 11 s son lo esperable donde `ECONNREFUSED` es inmediato). Mientras tanto la petición espera: en el checkout el commit ya ocurrió, pero la respuesta y los reenvíos a Mongo y a Neo4j quedan detrás de esa espera (ensanchan la ventana de §5, escenario 1b), y las comprobaciones «falla abierto» (suspensión, topes) solo abren después de ella. Es un problema de latencia y de ventana más que de datos —nada se pierde—, pero la simulación `--falla=redis` lo oculta porque rechaza al instante. Arreglo propuesto, **no aplicado**: opciones de ioredis con un `commandTimeout` corto (p. ej. 1,5 s) o `maxRetriesPerRequest: 1`, y lanzar la invalidación del carrito y el reenvío a Mongo en paralelo en vez de en serie. **Resuelto el 2026-10-20 (§7):** `config/redis.js` usa ahora `commandTimeout: 1500`, `maxRetriesPerRequest: 1` y rechaza al instante mientras la conexión está caída; con el contenedor de Redis detenido, el login, el carrito y el checkout responden en 0,1-1,1 s (antes 73 s o sin respuesta en 200 s).

## 5. Prueba de falla simulada — evidencia real sobre las bases reales

El PRD pide, como mínimo, **una falla simulada sobre el checkout y el comportamiento resultante del sistema**, identificando cada componente, sus puntos de falla y la mitigación adoptada (reintentos idempotentes, un patrón de compensación, o la aceptación documentada de una ventana de consistencia eventual). Hay **tres generaciones de evidencia** y conviene no confundirlas (la C, en §7, es la que más se parece a lo que pide el requerimiento: apagar contenedores con la aplicación en marcha):

| | Cuándo | Cómo se provoca la falla | Qué cubre |
|---|---|---|---|
| **A. Contenedor detenido** | 2026-09-08/09 | `docker compose stop mongo` / `stop cassandra` + `scripts/intentarCheckoutReal.js` | Mongo y Cassandra caídos (capturas históricas, §5.5) |
| **B. Falla inyectada** | 2026-10-06 | `node scripts/demo_consistencia_compra.js --falla=<escenario>` | Seis escenarios con aserciones (§5.3), contra las bases reales |
| **C. Aplicación completa con contenedores detenidos, en vivo** | 2026-10-19/20 | `docker stop tiendaya-<base>` (una o varias) con el backend corriendo + sondas HTTP concurrentes, una compra completa y la interfaz | Las seis bases, solas y combinadas, con la aplicación entera (§7) |

**Por qué hay una B.** Después de A, el checkout cambió: desde el 2026-10-03 `checkout()` lee Mongo **antes** de abrir la transacción (para comprobar que el producto esté activo), de modo que con Mongo detenido lanza —tras el *timeout* del driver— y la compra no se confirma (el control de flujo está comprobado en el escenario 1a). El «Escenario 1» de A (compra confirmada con Mongo caído) **ya no se reproduce tal cual**; lo que sigue siendo cierto de él —un reenvío post-commit que falla deja a Mongo desfasado— solo ocurre ahora si Mongo cae en la ventana entre esa lectura y el reenvío, y eso no se puede provocar deteniendo el contenedor. Por eso el escenario se divide en 1a y 1b y se prueba inyectando la falla en la llamada exacta.

**Qué es real y qué es simulado en B.** Las cinco bases están arriba y se leen de verdad antes y después (stock y pedidos de MySQL, el documento de Mongo, la clave del carrito en Redis, las filas de Cassandra, las aristas de Neo4j, la fila del outbox). Lo simulado es **el fallo**: la llamada que fallaría (`Producto.find`, `Producto.updateOne`, `cassandra.obtenerCliente`, `redis.invalidarCarrito`, `fraudeSyncService.registrarCompra`) se reemplaza solo en el proceso del script y solo mientras dura esa llamada por una que rechaza con el error de la base caída (`ECONNREFUSED`). No hay dobles de la base ni se detiene ningún contenedor (eso interrumpiría el backend que esté corriendo). Con el contenedor realmente detenido el resultado esperado es el mismo —para Mongo, tras el *timeout* de selección de servidor del driver—, y eso se hizo después, con la aplicación entera y los contenedores realmente detenidos: ver §7.

### 5.1 Cómo correrlo

```
cd backend
npm run demo:consistencia                 # camino normal, todo arriba
node scripts/demo_consistencia_compra.js --falla=mongo-despues
npm run demo:consistencia:fallas          # los seis escenarios + la tabla final
```

Escenarios: `mysql-dentro`, `mongo-antes`, `mongo-despues`, `redis`, `neo4j`, `cassandra`. Cada uno imprime el **componente**, el **punto de falla**, la **falla inyectada**, la **mitigación adoptada**, el estado de las cinco bases antes y después, y una lista de **verificaciones** (33 en total); si alguna no coincide con lo que este documento afirma, el script sale con código 1 (se comprobó rompiendo a propósito la reparación: la verificación falla y el código de salida es 1). Es idempotente: crea (o repara) las cuentas `demo.*@tiendaya.com` y el producto «PRODUCTO DEMO - consistencia entre bases», que queda **inactivo** salvo durante cada compra, repone su stock a 10 y alinea la copia de Mongo antes de cada escenario. Cada corrida compra unas pocas unidades de Q100 (los pedidos se conservan).

### 5.2 Camino normal (referencia)

Con todo arriba, justo después de `checkout()`: MySQL con el stock descontado, el carrito SQL vacío, **el carrito de Redis invalidado**, la copia de Mongo al día, la compra **ya en Neo4j**, y la venta **solo en el outbox**:

```
ANTES      MySQL stock=10 | carrito SQL=1 | outbox=0   Redis: copia del carrito con 1 línea   Cassandra filas de esta venta=0
DESPUÉS    MySQL stock=9  | carrito SQL=0 | outbox=1   Redis: sin copia   Mongo stock=9, total_vendido=6   Cassandra 0   Neo4j 1
DRENADO    outbox=0   Cassandra filas de esta venta=1
```

La única ventana que se ve **sin ninguna falla** es la de Cassandra (de 0 a 30 s, hasta el siguiente ciclo del worker): la venta ya es real en MySQL y todavía no está en el panel.

### 5.3 Escenarios

**1a — MongoDB cae ANTES de que MySQL confirme** (`--falla=mongo-antes`). Falla inyectada: `Producto.find` lanza `ECONNREFUSED` durante `checkout()`.

```
checkout()   LANZÓ: connect ECONNREFUSED 127.0.0.1:27018 (falla simulada)
MySQL antes y después: stock=10 | pedidos=6 | outbox pendiente=0     (idéntico)
Mongo, Cassandra y Neo4j: sin ningún cambio
```

Falla **cerrada**: no hay nada confirmado ni nada que compensar. La compra se reintenta cuando Mongo vuelva. El costo (sin Mongo no se puede comprar) es deliberado: es la regla «un producto inactivo no se vende», y el estado de publicación vive en Mongo.

**1b — MongoDB cae justo DESPUÉS del commit** (`--falla=mongo-despues`). Falla inyectada: `Producto.updateOne` lanza `ECONNREFUSED` durante `checkout()`.

```
checkout()         NO lanzó — compra #253, pago aprobado
el backend registra  No se pudo actualizar total_vendido/cantidad en Mongo: connect ECONNREFUSED ... (falla simulada)
MySQL              stock=9 | vendido=11 | outbox pendiente de esta venta=1
MongoDB            stock=10 | total_vendido=10   <-- DESFASADO respecto a MySQL
Neo4j              relaciones COMPRÓ de esta venta=1            (el fallo de Mongo no impidió los demás reenvíos)
2 s después (Mongo "vuelve"): stock Mongo=10 vs MySQL=9: SIGUE desfasado, no se autorepara
recalcularInventario({productoIds}) y recalcularVentas({productoIds})  →  Mongo stock=9 | total_vendido=11   (= MySQL)
y correrlos otra vez no cambia nada (idempotente)
```

La compra quedó confirmada; lo que quedó mal es **solo la copia de lectura**: el catálogo muestra una unidad de más y `total_vendido` va uno atrás. No puede haber sobreventa porque la validación de stock es el `UPDATE` condicional de MySQL, no la copia. **Mitigación: aceptación documentada de una ventana de consistencia eventual** (§3: el costo de un número desfasado en el catálogo es acotado) **más una reparación idempotente a demanda**: `recalcularInventario()`/`recalcularVentas()` (`catalogoSyncService.js`; el administrador las dispara con `POST /api/admin/recalcular-inventario|ventas`) sobrescriben la copia con lo que dice MySQL, así que repetirlas es seguro. La ventana **no se cierra sola**: dura hasta que alguien repara. Esa es la debilidad que queda y por qué §3 la ubica como «real, pero acotada».

**2 — Cassandra cae mientras el worker drena el outbox** (`--falla=cassandra`). Falla inyectada: `cassandra.obtenerCliente` rechaza durante un drenaje.

```
checkout()  NO lanzó — compra #252: no dependió de Cassandra (la fila del outbox va en la MISMA transacción)
DRENAJE con Cassandra caída:  {"seleccionados":1,"procesados":0,"fallidos":1}
  fila del outbox   procesado_en=null | intentos=1 | próximo intento en 30 s (backoff)
  último error      All host(s) tried for query failed (falla simulada)
  filas en Cassandra 0   (ventana abierta: la venta existe en MySQL, no aún en el panel)
REINTENTO con Cassandra de vuelta:  {"seleccionados":1,"procesados":1,"fallidos":0}
  fila del outbox   procesado_en=2026-10-07T02:06:02Z | intentos=2 | último error=null     filas en Cassandra 1
SE REENVÍA A PROPÓSITO LA MISMA VENTA  →  filas en Cassandra 1 (misma clave primaria: no se duplica)
```

Nada se perdió: la fila conserva su `payload` íntegro, el error y un reintento con *backoff* exponencial; al volver Cassandra, el siguiente ciclo la procesa **sin intervención**, y reenviar la misma venta no la duplica porque las dos inserciones tienen clave primaria `(…, detalle_id)`. **Mitigación: outbox durable con reintentos idempotentes** (la entrega es *at-least-once* y la escritura idempotente; ADR-004 §5).

**3 — Redis cae al invalidar el carrito** (`--falla=redis`). Falla inyectada: `redis.invalidarCarrito` lanza `ECONNREFUSED`.

```
checkout()  NO lanzó — compra #250, pago aprobado
el backend registra  No se pudo actualizar/leer la caché del carrito: connect ECONNREFUSED ... (falla simulada)
carrito SQL = 0 (se borra DENTRO de la transacción)     Redis: la copia sigue con 1 línea, TTL 449 s
leer el carrito (caliente)         devuelve 1 producto ya comprado: la copia de Redis quedó vieja
revisar (al entrar al checkout)    reconstruye desde SQL: 0 productos
```

El carrito **durable** (MySQL) ya estaba vacío; solo la copia en Redis quedó vieja, y vence sola (≤ 450 s) o la reemplaza `revisar()`, que es lo primero que hace la pantalla de checkout al entrar. **Mitigación: aceptación documentada de una ventana eventual acotada por TTL** (§2 fila 2; el carrito nunca fue fuente de verdad). **Límite de esta simulación:** el fallo inyectado rechaza al instante; con Redis realmente detenido ioredis tarda mucho más en rendirse y la petición espera (tercer punto de §4, 73 s medidos aquí), cosa que este escenario no muestra.

**4 — Neo4j cae al reenviar la compra al grafo** (`--falla=neo4j`). Falla inyectada: `fraudeSyncService.registrarCompra` lanza `ServiceUnavailable`.

```
checkout()  NO lanzó — compra #251, pago aprobado
el backend registra  No se pudo reenviar la compra a Neo4j: ServiceUnavailable: connect ECONNREFUSED 127.0.0.1:7687 (falla simulada)
Neo4j  relaciones COMPRÓ de esta venta=0   (MySQL sí tiene la compra)     Mongo al día: el fallo no afectó al otro reenvío
reenviar la compra desde MySQL (lo que hace backfillNeo4j.js)  →  1       y reenviarla OTRA VEZ  →  1  (MERGE por detalle_id)
```

El grafo queda sin la compra —la señal de fraude la ve tarde— hasta que se reenvía; el reenvío es un `MERGE` con clave natural `detalle_id`, así que repetirlo no duplica. **Mitigación: mejor esfuerzo + reintento idempotente a demanda** (`npm run fraude:backfill`); no hay cola, a propósito (§3: una señal de fraude tarde no cuesta como una venta perdida).

**5 — MySQL falla a mitad de la transacción** (`--falla=mysql-dentro`). Falla provocada: un pedido de dos ítems del mismo producto, 1 unidad y 9999 (hay 10): el primero ya descontó stock cuando el segundo no tiene.

```
checkout()  LANZÓ: Stock insuficiente para el producto 123
stock 10 -> 10 | pedidos 6 -> 6 | carrito SQL, outbox, Mongo, Cassandra y Neo4j: sin ningún cambio
```

El descuento del primer ítem **se revirtió** con el resto (`ROLLBACK`): pedido, líneas, pago, descuento de stock, fila del outbox y borrado del carrito son una sola transacción. Ningún reenvío corrió, porque todos van **después** del commit. **Mitigación: atomicidad de la transacción** (nada que compensar).

### 5.4 Resumen: componente, punto de falla, comportamiento observado y mitigación

| Componente | Punto de falla | Observado (medido en las bases reales) | Mitigación adoptada | Categoría del PRD |
|---|---|---|---|---|
| MySQL | a mitad de la transacción | pedido rechazado; stock 10→10, 0 pedidos nuevos, ninguna otra base tocada | `ROLLBACK` atómico | (base de todo lo demás: nada que compensar) |
| MongoDB | antes del commit (pre-chequeo de estado) | simulado: `checkout()` lanza; MySQL, Mongo, Cassandra y Neo4j sin cambio. Con el contenedor detenido (§7) el estado de publicación se lee del índice de búsqueda y la compra se confirma (`201`, 1,1 s) | respaldo en el índice de búsqueda; si tampoco responde, falla cerrada y se reintenta la compra | sin inconsistencia posible |
| MongoDB | después del commit (`$inc` de la copia) | compra confirmada; Mongo stock 10 vs MySQL 9 hasta que Mongo responde. Desde 2026-10-20 se repara solo (≤ 15 s tras volver, §7.4); antes había que correr `recalcular-*` | ventana eventual + reparación idempotente automática (los productos afectados se anotan y se recalculan desde MySQL) y a demanda (`recalcular-*`) | aceptación documentada de una ventana eventual |
| Redis | invalidación del carrito | compra confirmada; carrito SQL vacío; la copia de Redis queda hasta su TTL (≤ 450 s) o hasta `revisar()` | ventana eventual acotada por TTL | aceptación documentada de una ventana eventual |
| Neo4j | reenvío de la compra al grafo | compra confirmada; el grafo queda sin ella (0) hasta reenviarla desde MySQL (1, idempotente) | mejor esfuerzo + reenvío idempotente (`MERGE` por `detalle_id`) | reintento idempotente (manual) |
| Cassandra | escritura de las proyecciones de venta | la venta espera en el outbox con `intentos`, *backoff* y error; al volver se escribe sola (1 fila); reenviarla no la duplica | outbox durable + reintentos con inserciones idempotentes | reintentos idempotentes |

### 5.5 Evidencia histórica A (2026-09-09, contenedor realmente detenido)

Se conserva como antecedente; la corrida completa, con las seis bases y la aplicación entera, es la de §7. Se hizo con el código de entonces, que aún **no** consultaba Mongo antes de la transacción: por eso el checkout confirmó con Mongo caído.

*Mongo detenido* (`docker compose stop mongo` + `node scripts/intentarCheckoutReal.js`):

```
inventario MySQL antes: { cantidad: 17 }
No se pudo actualizar total_vendido/cantidad en Mongo: connect ECONNREFUSED ::1:27018, connect ECONNREFUSED 127.0.0.1:27018
RESULTADO: checkout() no lanzó excepción.   compra.id: 51 | pago.estado: aprobado
inventario MySQL después: { cantidad: 16 }
```

Con Mongo todavía caído, `GET /api/productos/1` seguía devolviendo `inventario.cantidad: 17`. Al levantarlo, la desactualización **persistió**; recién tras `POST /api/admin/recalcular-inventario` el valor pasó a `16`. Es lo que reproduce hoy el escenario 1b.

*Cassandra detenido* (`docker compose stop cassandra` + el mismo script): el checkout confirmó (compra 52, inventario 16→15) y el worker del backend, ya corriendo, dejó la fila del outbox con `procesado_en: null`, `intentos: 1`, `proximo_intento` y `ultimo_error: "All host(s) tried for query failed."`. Al levantar Cassandra, **sin intervención manual**, el siguiente ciclo de 30 s la procesó (`intentos: 2`, `ultimo_error: null`) y la fila apareció en `ventas_por_dia` (`dia = 2026-09-08`, hora de Guatemala UTC−6). Es lo que reproduce hoy el escenario 2, con la idempotencia además comprobada.

**Contraste real entre las tres clases de mitigación** (con evidencia, no solo con la intención de diseño): Cassandra se recupera **sola** y sin duplicar —donde perder el dato es más caro—; Redis se recupera sola por **TTL** —donde el dato nunca fue la verdad—; Mongo y Neo4j necesitan una **reparación a demanda**, porque su reenvío no tiene cola: la ventana de Mongo no se cierra sola. Es exactamente la jerarquía que predice §3.

### 5.6 Lo que esta prueba NO cubre

- **Una caída del proceso entre el commit y los reenvíos.** No se simula; equivale a que los tres reenvíos post-commit (Redis, Mongo, Neo4j) fallen a la vez, y cada uno queda en la ventana descrita arriba. Cassandra no se ve afectada: la fila del outbox ya está confirmada con el pedido.
- **Los dos puntos de §4** (la compensación de `productoService.crear()` que también falla, y el documento de Mongo que esa compensación nunca borra): siguen sin mitigación; el segundo se verificó con un fallo inyectado puntual que no forma parte de la demo, porque `crear()` no es el flujo de checkout.
- **Concurrencia:** dos compras simultáneas del mismo producto con un reenvío fallido. Cada `$inc` perdido deja la copia más atrás, y la misma reparación (que recalcula desde MySQL, no incrementa) lo corrige; no se probó.
- **Contenedores realmente detenidos:** cubierto en §7 (las seis bases, solas y combinadas, con la aplicación entera). Incluye la **latencia** de un Redis caído de verdad (§4, tercer punto), que la simulación no mostraba porque rechaza al instante.

## 6. Qué queda para el informe final de Entrega 3

Este documento cubre el requerimiento de consistencia. El buscador (el otro requerimiento técnico de la misma entrega) quedó implementado y verificado el 2026-09-22 con Elasticsearch — tolerancia ortográfica, facetas por agregación real y autocompletado — y vive en [PLAN-ELASTICSEARCH-BUSQUEDA.md](PLAN-ELASTICSEARCH-BUSQUEDA.md), no acá a propósito: son dos requerimientos distintos. Su sincronización sigue el mismo criterio de §3 (la fuerza de la garantía depende del costo de que el dato quede desactualizado): de mejor esfuerzo, sin outbox, recuperable con `busqueda:backfill`. La evaluación opcional del PRD —mover los pagos a un almacén NoSQL— reutiliza el análisis de fallas de este documento con Mongo como autoridad del pago (misma compensación bajo el bloqueo del usuario, mismo barrido); su ensayo, sus diez escenarios de falla y la decisión están en [ADR-005](ADR-005-evaluacion-nosql-pagos.md). Lo que sigue pendiente de Entrega 3 es el informe.

## 7. Degradación elegante: la aplicación con una o varias bases apagadas (prueba en vivo, 2026-10-19/20)

**El requerimiento se pensó para comprobarse en vivo:** con la aplicación corriendo se apaga en Docker el contenedor de una base —o de varias— y la aplicación tiene que seguir siendo utilizable, solo que **sin los datos de esa base**. §5 probaba las fallas *dentro* del proceso (B) o solo el checkout con un contenedor detenido (A); esta sección apaga los contenedores de verdad (`docker stop tiendaya-<base>`) y mide la aplicación **entera** —catálogo, búsqueda, sesión, carrito, una **compra completa**, paneles de administrador y edición de vendedor— por HTTP contra el backend corriendo y en la interfaz.

**Método.** Con el backend de desarrollo en marcha y todas las bases arriba se arma una compra (cuenta sintética, un producto con su carrito); se detiene el contenedor y se lanzan **en paralelo** las sondas HTTP (con un tope de 60-200 s para ver también los bloqueos largos) más la compra completa — ver el carrito, preparar el intento, confirmar —; se repite una segunda pasada, se vuelve a encender el contenedor **sin reiniciar el backend** y se comprueba que todo responde y que los datos quedaron coherentes. Los tiempos son de la *primera pasada* (la que paga el descubrimiento de la caída), en segundos, en esta máquina (Windows + Docker Desktop).

### 7.1 Qué se encontró: la aplicación NO lo cumplía

| Base apagada | Prueba | Antes (código del 2026-10-17) | Ahora |
|---|---|---|---|
| **Redis** | Login | 72,6 s | 0,2 s |
| | Ver carrito / agregar al carrito | **sin respuesta en 200 s** | 0,1 s / 0,6 s |
| | Confirmar el pedido | **sin respuesta en 200 s** (el preparar tardó 87,6 s) | 1,1 s, `201` |
| | Catálogo público (segunda pasada) | 107,7 s | 0,1 s |
| | Recomendaciones | `500` tras 180 s | 0,1 s |
| **Neo4j** | Confirmar el pedido | 31,6 s | 1,0 s |
| | Editar un producto (vendedor) | 31,2 s | 1,1 s |
| | Panel de fraude | 57 s y `200` con listas **vacías** | `503` en 1,3 s, con mensaje |
| **Elasticsearch** | Búsqueda / autocompletado | `503` tras 7,8 s / 7,2 s | 0,2 s / 0,1 s (búsqueda básica, §7.2) |
| | Editar un producto | 7,9 s | 0,9 s |
| **MongoDB** | Catálogo / categorías | `500` tras 30 s | 0,1 s (desde el índice de búsqueda) |
| | Detalle de un producto | `404` tras 30 s («no encontramos este producto») | 0,0 s |
| | Agregar al carrito | `400` tras 30 s | 0,5 s |
| | Confirmar el pedido | `503` tras 30 s | 1,1 s, `201` |
| | Editar un producto | `400` tras 30 s | `503` en 0,1 s, con mensaje |
| **MySQL** | Login | `401` tras 10 s, **con la ruta del archivo de Prisma en el cuerpo** | `503` en 2,5 s, con mensaje |
| | Perfil (`/auth/me`) | `404` tras 10 s — y la interfaz **cerraba la sesión** | `503` en 2,5 s; la sesión se conserva |
| | Mis pedidos / agregar al carrito | `500` / `400` tras 10 s | `503` en 2,5 s |
| **Cassandra** | Panel de ventas | `503` inmediato (ya estaba bien) | igual |

**La causa de fondo no era qué hacía el código al fallar** —casi todo ya fallaba «abierto» o con un `503` explicado (§3, §4)— **sino cuánto tardaba en enterarse.** ioredis esperaba ~73 s por comando, y como **toda** petición autenticada consulta Redis para saber si la cuenta está suspendida, un Redis apagado dejaba a todo el sitio, catálogo público incluido, a ~108 s por petición (§4, tercer punto, ya lo anticipaba y proponía este arreglo); el driver de Mongo esperaba 30 s para seleccionar servidor; el de Neo4j hasta 30 s por consulta (y el checkout espera el reenvío al grafo antes de responder); el pool de MySQL, 10 s. Aparecieron además defectos de otra clase:

- **Un fallo se reportaba como otra cosa.** MySQL apagado: `401` en el login (con el mensaje crudo del driver, incluida la ruta del archivo), `404` en `/auth/me` y `400` al agregar al carrito; la interfaz tomaba cualquier error al leer el perfil como «sesión inválida» y **cerraba la sesión de todo el mundo**. Mongo apagado: el detalle de un producto decía «no encontramos este producto».
- **Un fallo de arranque se quedaba para siempre.** Si la primera conexión a Mongo o a Elasticsearch fallaba (el backend arrancó con esa base apagada), el error o el cliente a medio preparar quedaba guardado: la base volvía y la aplicación seguía rota hasta reiniciarla.
- **Un defecto preexistente que la prueba en la interfaz dejó a la vista:** al completar una compra con Mongo apagado, la pantalla del pedido mostraba la línea «× 1» **sin nombre de producto** — y lo hacía también con todo arriba, porque desde ADR-002 MySQL guarda de cada línea solo el producto como ancla y la pantalla seguía leyendo la descripción de ahí. Ahora el nombre y la imagen salen del catálogo (o de su copia en el índice) y, si ninguno responde, la línea se identifica por su número (`compraService.js`).
- **El panel de fraude mentía.** Con Neo4j apagado respondía `200` con listas vacías —«no hay nada sospechoso»— cuando en realidad nadie había mirado.

### 7.2 Qué hace la aplicación sin cada base

| Base apagada | Qué se pierde | Qué sigue funcionando | Con qué mecanismo |
|---|---|---|---|
| **Redis** | Ofertas flash y compras con cupo personal (se ocultan; comprarlas da `503` con mensaje). Los topes de pedidos y los bloqueos de cuentas «fallan abiertos» (ya diseñado, §3) | Todo lo demás: catálogo, búsqueda, login, carrito (se arma desde MySQL), **checkout**, recomendaciones (sin caché) | Cliente con tiempos acotados y rechazo inmediato; sus consumidores ya eran de mejor esfuerzo |
| **Elasticsearch** | Tolerancia a errores de tipeo, relevancia y autocompletado inteligente | Búsqueda y autocompletado **básicos sobre Mongo** (texto literal, facetas calculadas en el servidor; la interfaz avisa «búsqueda básica»); editar productos no se detiene | `catalogoLecturaService`: Mongo es el respaldo del índice |
| **Neo4j** | Panel de fraude (`503`); el barrido que suspende cuentas queda ciego | Compras, ventas, ediciones: el reenvío al grafo se omite al instante | Cortacircuitos; la compra no espera |
| **Cassandra** | Panel de ventas (`503`) | Todo, **incluido el checkout**: las ventas esperan en el outbox y se escriben solas al volver | Outbox durable (§3) |
| **MongoDB** | Reseñas, ofertas flash, historial y la edición de productos y categorías (`503` con mensaje) | Catálogo, detalle y categorías **desde el índice de búsqueda**; carrito y **checkout** (el estado de publicación de cada producto se lee del índice); la copia de stock que quedó atrás **se repara sola** al volver (≤ 15 s) | `catalogoLecturaService`, `productoService.estadoPublicacion`, `reconciliacionMongoService`: el índice es el respaldo de Mongo |
| **MySQL** | Cuentas, carrito, pedidos: sin login, ni compra, ni edición (`503` con mensaje) | Catálogo, detalle, búsqueda, categorías, recomendaciones; **las sesiones abiertas siguen** (el perfil mínimo se arma del token y se reintenta cada 10 s) | `503` explicado; la interfaz no cierra la sesión |
| **Mongo y Elasticsearch a la vez** | No hay catálogo ni su copia: ni qué mostrar ni qué vender | Login y el resto de lo que no necesita productos | `503`: sin saber si está publicado, no se vende |

**Una combinación de verdad.** Con **Redis, Elasticsearch, Neo4j y Cassandra apagados a la vez** (solo MySQL y Mongo arriba) todo el flujo del comprador funciona: catálogo, búsqueda básica, login, carrito, **compra completa en 1,1 s** (`201`) y edición de un producto; solo los paneles de ventas y de fraude responden `503`. Con **MySQL y Redis apagados** el catálogo y la búsqueda siguen; login, carrito y pedidos dicen que no están disponibles. Con **las seis apagadas** el backend arranca igual (en ~2 s), `/api/health` responde `200`, `/api/health/componentes` dice `critico` y cada pantalla responde un `503` claro en milisegundos; al encender las seis **sin reiniciar el backend** todo vuelve solo en ~24 s (el tiempo que tardan los contenedores). Una caída de tres minutos con las seis apagadas y todos los procesos de fondo corriendo (outbox, barrido de fraude, recuperación de intentos) no tumbó el proceso, y la venta hecha mientras Cassandra estaba apagada llegó sola a su tabla.

### 7.3 Resultado medido, base por base (primera pasada, con una compra real)

Cada celda: `ok` = respuesta correcta; `503` = no disponible con mensaje; tiempo en segundos.

| Prueba | ES | Neo4j | Cassandra | Redis | Mongo | MySQL | Redis+ES+Neo4j+Cass. | MySQL+Redis | Mongo+ES |
|---|---|---|---|---|---|---|---|---|---|
| Catálogo | ok 0,1 | ok 0,1 | ok 0,1 | ok 0,1 | ok 0,1 | ok 0,1 | ok 0,1 | ok 0,1 | 503 0,0 |
| Detalle de un producto | ok 0,1 | ok 0,1 | ok 0,1 | ok 0,1 | ok 0,0 | ok 0,1 | ok 0,0 | ok 0,1 | 503 0,0 |
| Búsqueda / autocompletado | ok 0,2 / 0,1 | ok 0,3 | ok 0,1 | ok 0,1 | ok 0,1 | ok 0,1 | ok 0,1 | ok 0,3 / 0,2 | 503 0,0 |
| Login | ok 0,2 | ok 0,2 | ok 0,2 | ok 0,2 | ok 0,2 | 503 2,5 | ok 0,2 | 503 2,5 | ok 0,2 |
| Ver carrito / agregar | ok 0,1 / 0,6 | ok 0,0 / 0,5 | ok 0,0 / 0,5 | ok 0,1 / 0,6 | ok 0,0 / 0,5 | ok 0,0 / 503 2,5 | ok 0,1 / 0,5 | 503 2,5 | ok 0,0 / 503 0,1 |
| **Confirmar el pedido** | **ok 1,5** | **ok 1,0** | **ok 1,4** | **ok 1,1** | **ok 1,1** | 503 | **ok 1,1** | 503 | 503 0,0 |
| Panel de ventas | ok 0,4 | ok 0,2 | **503 0,0** | ok 0,2 | ok 0,2 | ok 2,6 | 503 0,0 | ok 2,6 | ok 0,2 |
| Panel de fraude | ok 0,3 | **503 1,3** | ok 0,3 | ok 0,3 | ok 0,2 | ok (parcial) 5,1 | 503 1,1 | ok (parcial) 8,8 | ok 0,2 |
| Editar un producto (vendedor) | ok 0,9 | ok 1,1 | ok 0,8 | ok 0,2 | **503 0,1** | 503 2,5 | ok 1,3 | 503 2,5 | 503 0,1 |

(«Parcial»: el panel responde con lo que sí pudo leer y avisa lo que no; con MySQL apagado no puede enriquecer las fichas.) En la segunda pasada todo lo que responde lo hace en menos de 0,3 s: el cortacircuitos ya sabe que la base está caída y no la vuelve a esperar.

### 7.4 Cómo se logra

1. **Fallar rápido** — cada cliente con tiempos acotados (el cambio de mayor efecto) y un cortacircuitos mínimo (`utils/resiliencia.js`): la primera falla de *conexión* lo abre y, durante 5 s, las llamadas siguientes fallan al instante en vez de esperar cada una su timeout; pasado ese tiempo se deja pasar una prueba. Solo las fallas de conexión lo abren — un error de la consulta, no.

   | Cliente | Antes | Ahora |
   |---|---|---|
   | ioredis (`config/redis.js`) | sin tope por comando, 20 reintentos (~73 s) | 1,5 s por comando, 1 reintento, y rechazo **inmediato** mientras la conexión está caída |
   | Mongoose (`config/mongo.js`) | 30 s de selección de servidor, 10 s de cola | 2 s; con la conexión perdida falla al instante; el primer fallo de conexión no se guarda |
   | Prisma + MariaDB (`config/prisma.js`) | 10 s de espera de pool | 2,5 s |
   | neo4j-driver (`config/neo4j.js`) | hasta 30 s por consulta | 1,5 s de conexión y 0,5 s de reintento; cortacircuitos |
   | cassandra-driver (`config/cassandra.js`) | 5 s de conexión, 10 s de lectura | 2 s y 5 s; falla al instante si el nodo ya está marcado caído; cortacircuitos |
   | Elasticsearch (`config/elasticsearch.js`) | 30 s y 3 reintentos | 2 s y ninguno; cortacircuitos; la preparación del índice ya no se queda a medias |

2. **Decir qué falta, con el estado correcto** (`utils/http.js`): una base apagada responde **`503`** con `codigo: SERVICIO_NO_DISPONIBLE` y el componente — nunca `401`, `404` ni `500` — y **sin** rutas de archivo ni nombres internos del driver (`componenteCaido()` reconoce el error de cada driver; la tabla de formas está en `tests/resilienciaNucleo.test.js`). Un manejador global (`app.js`) cubre las rutas que dejaban escapar el error.
3. **Cada base es el respaldo de otra** (`catalogoLecturaService.js`, `productoService.estadoPublicacion`): Elasticsearch guarda una copia de lo que el catálogo muestra y Mongo es la fuente de esa copia. Mongo apagado → el catálogo, el detalle, las categorías y —lo importante— **el estado de publicación que exigen el carrito y el checkout** salen del índice. Elasticsearch apagado → la búsqueda cae a Mongo. Solo se cae al respaldo cuando falló el esperado (un error de validación o un bug no se esconde) y, si los dos están apagados, se informa la caída del origen.
4. **Lo que quedó atrás se repara solo** (`reconciliacionMongoService.js`): los productos cuya copia de Mongo no se pudo actualizar tras confirmar un pedido se anotan y, en cuanto Mongo responde, se recalculan **desde MySQL** (idempotente: el mismo resultado se ejecute una o cinco veces) — solo esos productos, nunca el catálogo entero.
5. **Que se vea** (`/api/health/componentes` y la franja amarilla del frontend): un ping barato por el mismo camino que usa el código real, con tope propio de 1,5 s y vigencia de 2 s, devuelve `completo`, `degradado` o `critico` y si cada base responde. Los milisegundos y el texto del error solo los recibe un administrador (desde 2026-10-23): ese texto viene del driver y puede traer host, puerto o usuario. La interfaz lo consulta cada 10 s y le dice a la persona qué cambia («la búsqueda es básica», «hoy no hay ofertas flash»).
6. **La sesión no depende de MySQL para seguir** (`AuthContext.jsx`): solo `401`/`403`/`404` cierran la sesión; con un `503` o sin red se arma un perfil mínimo del token (id y rol, que decide qué secciones ve) y se reintenta cada 10 s.
7. **El pedido se muestra completo sin el catálogo** (`compraService.js`): el pedido es de MySQL; los nombres de producto se piden al catálogo y, si no responde, la línea se identifica por su número.
8. **Los procesos de fondo no tumban el servidor** (`server.js`): una promesa rechazada sin manejar —un reenvío «de mejor esfuerzo», un temporizador— se registra y el servidor sigue; los barridos escriben **una** línea cada 15 s por base caída en vez del bloque completo del driver en cada vuelta.

### 7.5 Cómo probarlo en vivo

```bash
docker stop tiendaya-redis                                    # una base
docker stop tiendaya-redis tiendaya-elasticsearch tiendaya-neo4j tiendaya-cassandra   # varias
curl http://localhost:3000/api/health/componentes             # qué responde ahora
docker start tiendaya-redis                                   # vuelve sola: no hace falta reiniciar el backend
```

Los seis contenedores son `tiendaya-mysql`, `tiendaya-mongo`, `tiendaya-redis`, `tiendaya-cassandra`, `tiendaya-neo4j` y `tiendaya-elasticsearch` (nunca `postgres_ezpass` ni `redis_ezpass`, que son de otro proyecto). En la interfaz aparece una franja amarilla («Algunos servicios no están disponibles en este momento») con lo que cambia, que se actualiza sola cada 10 s. La lógica (la decisión de a quién preguntar, el cortacircuitos, las políticas de cada cliente, la reconciliación, el carrito degradado) está cubierta por `npm run test:resiliencia` (49 pruebas) y por las suites existentes, que siguen pasando.

### 7.6 Riesgos aceptados y límites (a propósito, documentados)

- **Comprar con Mongo apagado usa el índice para saber si el producto está publicado.** Un producto que el vendedor pausó mientras el índice *también* estaba apagado figuraría como activo hasta que Mongo vuelva; uno que el índice no conoce se trata como no disponible. Si ninguno de los dos responde, no se vende (falla cerrada, como en §5.3, escenario 1a).
- **Con Redis apagado no se aplican los topes de pedidos por hora ni los bloqueos de cuentas** (ya eran «falla abierta» por diseño: `suspensionService.js`, `limitePedidosService.js`): una cuenta suspendida podría actuar durante la caída. Al volver Redis, el barrido de bloqueos reconstruye los candados desde MySQL (`bloqueoService.reconciliar()`, cada 60 s).
- **Una compra flash intentada mientras Redis estaba apagado queda como intento fallido** (`503` con el mensaje de qué falta, ver [CHECKOUT-IDEMPOTENCIA.md](CHECKOUT-IDEMPOTENCIA.md)): al volver Redis hay que iniciar una compra nueva — la pantalla ofrece «Preparar una nueva compra» —, y entonces se confirma (verificado: `201` con un intento renovado; con Redis apagado, la compra normal del mismo producto siguió confirmándose).
- **Neo4j y Elasticsearch no se ponen al día solos:** lo ocurrido durante su caída (compras y productos hacia el grafo; ediciones hacia el índice) se recupera con `npm run fraude:backfill` y `npm run busqueda:backfill`, ambos idempotentes. Mientras tanto el índice puede mostrar un precio o stock desactualizado en la búsqueda (el detalle y el carrito leen siempre la fuente).
- **La reconciliación de Mongo vive en memoria:** si el backend se reinicia durante la caída se pierde la lista, y queda `POST /api/admin/recalcular-inventario` y `-ventas` (§5.4).
- **La primera petición tras la caída paga el descubrimiento** (hasta ~2,5 s con MySQL, ~1,3 s en el panel de fraude); después, el cortacircuitos la vuelve inmediata.
- **La aplicación vuelve a usar una base unos segundos después de que su contenedor está sano** (de inmediato a ~25 s; el peor caso observado fue Cassandra, cuyo driver reconecta con espera creciente y a la que además se le da una ventana de 5 s del cortacircuitos). Nada hay que reiniciar.
- **Los tiempos son de esta máquina** (Windows + Docker Desktop, donde un puerto publicado de un contenedor detenido rechaza conexiones al instante); donde las conexiones se cuelgan en vez de rechazarse, el tope de cada cliente es lo que acota la espera.

## 8. Pausas para demostrar fallos reales y comunicación al comprador

Desde el 2026-10-20, el checkout normal dispone de dos pausas asíncronas opcionales,
fuera de la transacción: `before_transaction` y `after_commit_before_redis`.
Permiten detener MySQL o Redis desde Docker en un punto identificable del flujo.
La configuración, los pasos, las verificaciones y los límites están en
[DEMO-FALLOS-CHECKOUT.md](DEMO-FALLOS-CHECKOUT.md).

Cuando falla la invalidación de Redis tras confirmar MySQL, se conserva la compra
y se devuelve `advertencias` con `CARRITO_CACHE_PENDIENTE`. La pantalla del pedido
comunica que la compra está confirmada y que no debe repetirse. El aviso se guarda
en el intento con mejor esfuerzo para recuperarlo al consultar o reenviar. Una
caída de MySQL durante el checkout devuelve `CHECKOUT_INCIERTO`: se conserva el
intento antes de volver a decidir una compra, porque una desconexión alrededor del
COMMIT no demuestra un rollback.

La interfaz del checkout normal muestra un aviso persistente ante una respuesta
incierta, un error de red o un error de servidor durante la confirmación. Explica
que conserva el intento y ofrece **Consultar estado**, que solo hace una lectura
del intento existente. Si ya está completado, abre el pedido; si sigue pendiente
o el servicio no responde, conserva el aviso y permite consultar nuevamente. El
botón de confirmación pasa a **Reintentar mismo pedido**, usando el mismo intento.
Este aviso funciona en el flujo normal, sin activar las pausas de demostración.

Las pruebas automatizadas de estos cambios usan dobles. La demostración de esta
sección con contenedores reales aún debe ejecutarse y adjuntarse como evidencia;
el motor de Docker Desktop no estaba disponible durante esta implementación.
