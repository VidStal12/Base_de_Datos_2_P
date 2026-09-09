# Guía de código — Entrega 2

> Creado: 2026-09-09. No es un plan ni un ADR — es un mapa de **qué archivo hace qué y por qué importa**, para estudiar el código de Entrega 2 sin tener que reconstruirlo leyendo el historial de git. Para el *por qué* de cada decisión (alternativas consideradas, justificación), los documentos de diseño siguen siendo la fuente: [ENTREGA-2-PLAN.md](ENTREGA-2-PLAN.md) (carrito, oferta, recomendaciones), [ADR-004](ADR-004-analitica-ventas-cassandra.md) (ventas/Cassandra), [PLAN-NEO4J-DETECCION-FRAUDE.md](PLAN-NEO4J-DETECCION-FRAUDE.md) (fraude/Neo4j). Este documento resume el *qué* y el *cómo*, con la ruta exacta de cada archivo.

---

## 0. Cinco patrones que se repiten — entenderlos una vez rinde en las seis features

Antes de ir feature por feature: casi todo lo nuevo de Entrega 2 es una variación de estas cinco ideas. Reconocerlas hace que leer cualquier archivo de abajo sea mucho más rápido.

1. **Dos guardas — admisión rápida + autoridad final.** Redis decide rápido si algo *puede* intentarse (`DECR` atómico vía script Lua); MySQL, en su propia transacción, decide si de verdad *pasa*. Ganar la guardia 1 nunca es la confirmación. Usado en oferta flash (§2) y recomendaciones (§3) — la misma guardia 2 (`checkoutOferta()`), literalmente la misma función, para las dos.
2. **`MERGE`, no `CREATE` — todo reenvío es idempotente.** Cassandra y Neo4j reciben copias reenviadas *después* de que MySQL ya confirmó algo. Un reintento (por una caída a mitad de camino) nunca debe duplicar ni corromper — así que la clave de cada nodo/fila es siempre un identificador natural (`detalle_id`, `producto_id`, dirección normalizada, token de pago), nunca un autoincremental propio de la copia.
3. **La fuerza de la garantía depende de qué tan caro es llegar tarde — no todo reenvío es igual de robusto, a propósito.** El carrito y el catálogo son mejor esfuerzo (`try/catch`, se loguea y sigue). Las ventas tienen outbox durable con reintentos (perder una venta del informe no es aceptable). El fraude es mejor esfuerzo otra vez (una señal tardía no cuesta lo mismo que una venta perdida). Ver [ENTREGA-3-CONSISTENCIA.md §3](ENTREGA-3-CONSISTENCIA.md) para el argumento completo.
4. **Caché de campo, resuelta al escribir, nunca al leer.** `vendedor_nombre` en `Producto`, `usuario_nombre` en `Resena` — un solo cruce a MySQL en el momento de crear el documento, nunca en cada lectura del catálogo. El mismo criterio decidió (§ el chat de diseño) que la tabla `usuarios` se queda en MySQL en vez de moverse a Mongo.
5. **Verificación contra el sistema real, no contra mocks, siempre que se pueda.** Cada feature tiene un script `verificar:*` que corre contra Redis/MySQL/Mongo/Cassandra/Neo4j de verdad, con datos reales o sembrados a propósito (nunca presentados como orgánicos si no lo son). `test:ventas` es la única excepción deliberada (dobles de dependencias) — documentado como tal, no como el estándar del proyecto.

---

## 1. Carrito (Redis)

TTL por inactividad, no fijo — se reinicia en cualquier interacción, incluida una simple lectura.

| Archivo | Qué hace | Por qué importa |
|---|---|---|
| `backend/src/config/redis.js` | Conexión perezosa a Redis (`ioredis`), reutilizada entre servicios. También registra el script Lua `decrementarOferta` (§2/§3 lo usan). | El único punto donde se abre la conexión — todo lo demás la importa. |
| `backend/src/services/cartService.js` | Hash por usuario (`carrito:{id}` → `{productoId: cantidad}`). `agregar()` clampa contra stock real; `refrescarTTL()` se llama en cada operación. | El TTL "por inactividad" vive acá, no es una expiración fija — cada lectura también lo reinicia. |
| `backend/src/routes/cartRoutes.js` | `GET/POST/PATCH/DELETE /api/carrito*`, todas detrás de `requireAuth`. | El carrito requiere sesión — es la razón por la que existe `requerirSesion()` en el frontend. |
| `frontend/src/context/CartContext.jsx` | Estado del carrito en React + lógica de "continuar donde lo dejaste": si `agregar()` se llama sin sesión, guarda la acción pendiente en `sessionStorage` y la completa sola después del login. | Único lugar donde vive esa lógica de reanudación — vale leerlo completo, no solo por encima. |
| `frontend/src/components/common/Toast.jsx` | Notificación simple que confirma cuando se completó un "agregar" pendiente. | Un solo caso de uso a propósito, no un sistema de notificaciones genérico. |
| `backend/scripts/verificarCarrito.js` | 5 checks reales: TTL inicial, reinicio de TTL, clamp contra stock, borrado de clave al vaciar, vaciado tras checkout. | `npm run verificar:carrito`. |

---

## 2. Oferta flash (Redis + MySQL)

El ítem de mayor peso individual de toda la rúbrica de Entrega 2 (3.0 pts). Dos guardas — ver patrón 1.

| Archivo | Qué hace | Por qué importa |
|---|---|---|
| `backend/src/models/mongo/Producto.js` | Sub-schema `oferta_flash: {activo, precio_oferta, stock_oferta, vigente_desde, vigente_hasta}`. | `activo` es independiente de las fechas — se puede pausar sin tocar la ventana. `stock_oferta` es el tamaño ORIGINAL del pool; el remanente en vivo vive solo en Redis. |
| `backend/src/services/ofertaFlashService.js` | `intentarComprar()` = guardia 1 (llama al script Lua). `comprar()` = orquesta guardia 1 → guardia 2 (`checkoutService.checkoutOferta`) → si la 2 falla, revierte el contador de Redis con `INCRBY`. | Leer `comprar()` primero — es el resumen ejecutable de todo el patrón de dos guardas. |
| `backend/src/services/checkoutService.js` (función `checkoutOferta`) | La guardia 2 real: transacción de Prisma, precio provisto por quien llama (no `inventario.precio`), exige stock MySQL real aunque Redis ya haya admitido. | Comparte el archivo con `checkout()` (el checkout normal) pero **ninguna línea de código** — decisión deliberada para no arriesgar el checkout ya verificado. |
| `backend/src/routes/ofertaRoutes.js` | `GET stock` (público), `PATCH` (configurar, dueño/admin), `POST comprar` (cualquier sesión). | — |
| `frontend/src/pages/seller/SellerProductFormPage.jsx` (sección oferta) | Formulario para que el vendedor active/edite la oferta de su propio producto. | — |
| `frontend/src/pages/ProductDetailPage.jsx` (bloque oferta) | Badge + precio tachado + remanente en vivo. | — |
| `frontend/src/pages/OfertaCheckoutPage.jsx` | Compra directa de 1 unidad — deliberadamente fuera del carrito/`CartContext`. | — |
| `backend/scripts/verificarOfertaFlash.js` | 15 intentos simultáneos contra un pool de 5 — exactamente 5 admitidos, contador en Redis en 0, inventario MySQL real descontado en 5. | `npm run verificar:ofertaFlash` — la prueba de atomicidad bajo concurrencia que pide el PRD. |

---

## 3. Recomendaciones por tendencia (Redis + MySQL + Mongo)

No la pidió el PRD — se agregó a pedido. Reutiliza *toda* la maquinaria de §2, cambiando solo quién decide el precio/elegibilidad.

| Archivo | Qué hace | Por qué importa |
|---|---|---|
| `backend/src/services/tendenciaService.js` | `analizarTendencia()`: resuelve `compra_detalle` (MySQL) contra `Producto` (Mongo) en la aplicación — sin join real entre bases. `comprar()`: guardia 1 con clave por **(producto, usuario)**, no global; guardia 2 = la misma `checkoutOferta()` de §2. | El cupo personal (2 unidades) no es un pool compartido — es "cuántas unidades puede llevarse ESTE usuario al precio que se le calculó". |
| `backend/src/routes/recomendacionRoutes.js` | `GET /` (recomendaciones del usuario del token), `POST /:id/comprar`. | Nunca un `:usuarioId` en la URL — siempre el del token. |
| `frontend/src/pages/HomePage.jsx` (`RecomendacionesSection`) | Sección "Recomendado para vos", con la explicación de por qué. | — |
| `frontend/src/pages/RecomendacionCheckoutPage.jsx` | Compra directa, mismo patrón que `OfertaCheckoutPage.jsx`. | — |
| `backend/scripts/verificarRecomendaciones.js` | Corre contra el historial de compras REAL de un usuario (no fabricado), confirma que encuentra un producto de otro vendedor, y 7 intentos simultáneos sobre un cupo de 2 → exactamente 2 admitidos. | `npm run verificar:recomendaciones`. |

---

## 4. Reseñas (Mongo + MySQL)

Prerrequisito real de la Señal A de fraude (§6) — no se planeó así, pero terminó siéndolo.

| Archivo | Qué hace | Por qué importa |
|---|---|---|
| `backend/src/models/mongo/Resena.js` | Colección de referencia (no embebida — ver ADR-002 §6.1: volumen no acotado). Índice único `{producto_id, usuario_id}`. | El índice único es la garantía real bajo concurrencia — el chequeo en `resenaService.js` es solo para devolver un 409 legible en el caso normal. |
| `backend/src/services/resenaService.js` | `crear()` exige una compra con pago aprobado (misma definición de "compra real" que usa `ventasSyncService.js` para el panel de ventas — un solo criterio). Recalcula `Producto.resenas_resumen` en cada creación. | La exigencia de compra real se agregó *después* de la primera versión — sin ella, cualquier cuenta sin fricción podía inflar/hundir una calificación. Motivo real del cambio, no cosmético. |
| `frontend/src/components/common/StarRating.jsx` | Un componente, dos modos: solo-lectura (sin `onChange`) e interactivo. | — |
| `frontend/src/components/product/ResenasSection.jsx` | Lista + formulario, en `ProductDetailPage.jsx`. | — |

---

## 5. Panel de ventas (Cassandra) — outbox durable

El único punto de todo Entrega 2 con garantía de entrega dura (patrón 3). Construido por un compañero de equipo (WOG15); reseñado y verificado.

| Archivo | Qué hace | Por qué importa |
|---|---|---|
| `docker/cassandra-init/01-schema.cql` | `CREATE KEYSPACE` + las dos tablas. El backend reutiliza este mismo archivo en runtime (no lo duplica). | Dos proyecciones de la misma venta: `ventas_por_dia` (partición por día) y `ventas_por_producto_mes` (partición por producto+mes) — cada consulta real resuelta por partición, sin `ALLOW FILTERING`. |
| `backend/src/config/cassandra.js` | Conecta sin keyspace primero (puede no existir en un volumen nuevo), aplica el CQL, reconecta con keyspace. | — |
| `backend/prisma/schema.prisma` (modelo `venta_outbox`) + su migración | Tabla MySQL: `detalle_id` (PK, = `compra_detalle.id`), `payload`, `procesado_en`, `intentos`, `proximo_intento`, `ultimo_error`. | La identidad es `detalle_id` — reintentar nunca duplica una venta. |
| `backend/src/services/ventasOutboxService.js` | `encolarCompra(tx, compra)` — inserta el outbox **dentro** de la misma transacción de MySQL del checkout. | Si esto falla, el checkout ENTERO se revierte — decisión de consistencia fuerte, discutida en ENTREGA-3-CONSISTENCIA.md. |
| `backend/src/services/checkoutService.js` (llamada a `encolarCompra`) | `checkout()` y `checkoutOferta()` llaman a `encolarCompra` — cubre carrito, oferta flash Y recomendaciones con una sola integración. | — |
| `backend/src/services/ventasSyncService.js` | Worker cada 30s (`VENTAS_SYNC_INTERVAL_MS`): toma pendientes, escribe las dos tablas de Cassandra, marca `procesado_en` solo después de las dos. Backoff exponencial en error. `backfillHistorico()` para carga inicial. | Marcar "procesado" solo tras escribir AMBAS tablas es lo que hace segura una caída a mitad de camino — un reintento no deja una proyección sin la otra. |
| `backend/src/services/ventasService.js` | Lee Cassandra por particiones, agrega en Express (no en Cassandra). | Cassandra caída = error explícito, nunca sustituido por una consulta financiera a MySQL. |
| `backend/src/utils/ventas.js` | Fechas en hora de Guatemala (UTC−6) independiente del huso del servidor; validación de filtros; el cálculo puro del reporte (testeable sin bases). | — |
| `backend/src/routes/adminRoutes.js` (`GET /ventas`) | Solo administrador. | — |
| `backend/scripts/sincronizarVentas.js` | `npm run ventas:historico` (backfill) / `npm run ventas:sincronizar` (una pasada manual). | — |
| `frontend/src/pages/admin/AdminVentasPage.jsx` | Dashboard con filtros, gráfica y comparación de período — el único panel de Entrega 2 con gráfica (los de recomendaciones/fraude son listas simples). | — |
| `backend/tests/ventas.test.js`, `ventasSync.test.js` | 17 pruebas con dobles de dependencias — la excepción documentada al patrón 5. | `npm run test:ventas`. |

---

## 6. Detección de fraude (Neo4j) — mejor esfuerzo

La segunda familia — el PRD solo pedía una. Construido y verificado el 2026-09-08. Ver PLAN-NEO4J-DETECCION-FRAUDE.md §12 por una corrección real de diseño encontrada al implementar (clave de `Direccion`/`MetodoPago` por contenido, no por id de MySQL — el id nunca podría repetirse entre cuentas).

| Archivo | Qué hace | Por qué importa |
|---|---|---|
| `backend/src/config/neo4j.js` | Conexión perezosa (`neo4j-driver`), helpers `escribir()`/`leer()` que abren y cierran su propia sesión. | Olvidar cerrar una sesión/driver en un script suelto deja el proceso colgado — pasó varias veces armando esto (ver ESTADO-PROYECTO.md §4). |
| `backend/src/services/fraudeSyncService.js` | `registrarCompra()`/`registrarResena()` — los `MERGE` reales. `Direccion` clavada por dirección normalizada (texto), `MetodoPago` por `token_pasarela`, `COMPRÓ` con `detalle_id` como parte de su clave. | El archivo más importante para entender el modelo — leerlo junto con PLAN-NEO4J-DETECCION-FRAUDE.md §5/§12. |
| `backend/src/services/checkoutService.js` / `resenaService.js` (llamadas a `fraudeSyncService`) | Mismo punto donde ya se reenvía a Mongo/Redis/outbox — un `try/catch` más, independiente de los demás. | Mejor esfuerzo: si falla, no bloquea la compra/reseña que ya sucedió. |
| `backend/src/services/fraudeService.js` | Las dos consultas Cypher (Señal A: reseñas coordinadas: Señal B: desviación de patrón + dirección/pago compartido) y su formateo para el panel. | Leer las dos consultas Cypher directamente — son el "reto específico" multi-salto que pide el PRD. |
| `backend/src/routes/adminRoutes.js` (`GET /fraude`) | Solo administrador. | — |
| `backend/scripts/backfillNeo4j.js` | Recorre `compra_detalle` (pago aprobado) y `Resena`, llamando a las MISMAS funciones de `fraudeSyncService.js` que el camino en vivo. | `npm run fraude:backfill` — no es una segunda implementación que se pueda desalinear de la primera. |
| `backend/scripts/verificarFraudeNeo4j.js` | Siembra un patrón sintético de cada señal corriendo `checkout()`/`resenaService.crear()` REALES (no `MERGE` directo), confirma que las dos consultas los encuentran. | `npm run verificar:fraude` — prueba el camino en vivo de punta a punta, no solo las consultas de lectura. |
| `frontend/src/pages/admin/AdminFraudePage.jsx` | Dos tablas simples — deliberadamente no un dashboard con gráficas (a diferencia de ventas): el resultado son "pares candidatos", no una serie de tiempo. Explícito en la UI: nunca una acusación. | — |

---

## 7. Infraestructura y configuración transversal

| Archivo | Qué hace |
|---|---|
| `docker-compose.yml` | Los cinco servicios (MySQL, Mongo, Redis, Cassandra, Neo4j). El de Redis tiene el puerto parametrizado (`${REDIS_HOST_PORT:-6379}`) por el problema de rango reservado de Windows/Hyper-V — ver el comentario ahí mismo. |
| `backend/.env` / `.env.example` | Todas las variables de conexión de las 5 bases, cada bloque con el porqué de sus valores no obvios en comentarios. |
| `backend/src/services/checkoutService.js` | El archivo más "central" de todo Entrega 2 — `checkout()` y `checkoutOferta()` son el único lugar que toca Mongo, Redis, el outbox de Cassandra Y Neo4j, todo en el mismo `.then()` tras la transacción de MySQL. Vale leerlo completo una vez, de punta a punta. |

---

## 8. Cómo se relacionan los tres paneles de administrador

`/admin` (catálogo) → `/admin/ventas` (Cassandra, gráfica) → `/admin/fraude` (Neo4j, listas). Los tres exigen rol `administrador`; ninguno comparte código de UI entre sí a propósito — cada uno tiene una forma de dato distinta (tabular editable, serie de tiempo, pares candidatos) y forzar un componente compartido habría complicado los tres sin necesidad real.
