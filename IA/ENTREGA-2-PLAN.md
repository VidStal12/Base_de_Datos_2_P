# Plan — Entrega 2 (Clave-Valor, Grafos)

> Creado: 2026-08-30. Este documento es el plan de trabajo para Entrega 2 — qué pide el PRD, qué hay hoy en el proyecto relevante a cada punto, la decisión grafos-vs-columnar (con formato ADR, ya que el PRD la exige documentada así), y el plan de implementación por pieza. Se agrega a los tres ADR existentes en vez de convertirse en un cuarto: cubre una entrega completa, no una única decisión puntual — el patrón que ya sigue [ENTREGA-1-TRAZABILIDAD.md](ENTREGA-1-TRAZABILIDAD.md) para Entrega 1.
>
> **Decisión de stack para esta entrega (dada por el equipo, no derivada acá):** almacén clave-valor → **Redis**. Familia grafos/columnar → **Neo4j** (grafos).

---

## 1. Alcance: qué pide el PRD

Transcripción de [PRD.md §5](PRD.md#5-entregas-y-requerimientos), sección Entrega 2, para que este documento sea autocontenido.

> **Contexto del PRD:** El carrito relacional genera escrituras/lecturas frecuentes de datos transitorios. La venta de unidades limitadas bajo concurrencia exige atomicidad sin bloqueos de aplicación. Las necesidades de análisis de fraude y tendencias requieren evaluación de familias distintas.

**Funcionalidades:**
- Carrito persistente por sesión con expiración automática por inactividad
- Oferta flash: N unidades disponibles bajo múltiples solicitudes concurrentes, sin sobreventa
- Panel administrativo: patrones de posible manipulación de reseñas *(aplica — elegimos grafos)*
- ~~Panel de actividad de ventas por intervalos de tiempo~~ *(no aplica — solo si se elige columnar)*

**Requerimientos técnicos:**
- [ ] Carrito sobre almacén clave-valor (Redis) con **TTL configurado explícitamente** y **efecto documentado sobre el checkout**
- [ ] Oferta de inventario limitado mediante **operaciones atómicas** del almacén clave-valor, validada bajo **concurrencia simulada** (sin bloqueos a nivel de aplicación)
- [ ] **Evaluación comparativa** de grafos vs. columnar para los dos requerimientos de análisis (criterios específicos al sistema, no genéricos)
- [ ] Implementación de grafos (Neo4j): modelo cuentas-reseñas-productos + **consulta multi-salto** que detecte patrón anómalo de interacción
- [ ] Para columnar (no seleccionada): documentación de condiciones bajo las cuales su incorporación estaría justificada

**Rúbrica (10 pts):**

| Criterio | Peso |
|---|---|
| Implementación del carrito (clave-valor + expiración justificada) | 1.5 pts |
| Oferta de inventario limitado con operaciones atómicas bajo concurrencia | 3.0 pts |
| Evaluación comparativa grafos vs. columnar | 1.5 pts |
| Implementación de la familia seleccionada + reto específico | 3.0 pts |
| Calidad del informe + diagrama de arquitectura actualizado | 1.0 pt |

El ítem de mayor peso individual (3.0 pts) es la oferta de inventario limitado — no el carrito. Vale planificarlo con ese peso en mente, no como una extensión menor del carrito.

---

## 2. Estado actual relevante (dónde estamos parados)

### 2.1 Carrito — histórico (estado antes de implementar §4.1, ya migrado)

> Esta subsección describe cómo era el carrito **antes** de esta entrega — se mantiene sin editar como registro del punto de partida. El estado vigente está en §4.1, ya implementado.

[`frontend/src/context/CartContext.jsx`](../frontend/src/context/CartContext.jsx) vivía enteramente en `localStorage`, sin ningún endpoint de backend. Puntos que importaron para el plan de migración:

- **Clave fija** (`tiendaya_carrito`), no por sesión ni por usuario — si dos personas comparten el mismo navegador (perfil de Windows compartido, computadora pública), comparten el mismo carrito. Esto no es un bug reportado, pero es exactamente el tipo de cosa que una migración a Redis con sesión real debería dejar de tener, no reproducir.
- **Sin expiración de ningún tipo** — un carrito armado hace un mes seguiría ahí. El requerimiento del PRD (TTL por inactividad) no tiene equivalente actual que preservar; es funcionalidad nueva, no una migración 1:1.
- **No requiere sesión iniciada** — un visitante anónimo puede agregar productos al carrito; recién en `/checkout` se exige login. Esto es una decisión de producto real que la migración a Redis tiene que resolver explícitamente (ver §4.1).
- El carrito guarda el **objeto producto completo** (no solo `{productoId, cantidad}`) para poder mostrar imagen/precio sin otra consulta — al mover a Redis, probablemente conviene guardar solo `{productoId, cantidad}` y resolver el resto contra `GET /api/productos/:id` al leer el carrito, evitando que el carrito tenga una copia de precio/descripción que se desactualice si el producto cambia mientras está en el carrito.
- **Efecto sobre checkout ya documentado en código, útil como referencia:** [`CheckoutPage.jsx:66`](../frontend/src/pages/CheckoutPage.jsx) llama `vaciar()` **solo dentro del `try`**, después de que `checkoutApi.confirmar()` resuelve con éxito — si el checkout falla, el carrito se conserva. Este comportamiento hay que preservarlo exactamente igual con el carrito en Redis (no vaciar hasta que el pedido esté confirmado).

### 2.2 Inventario — atómico hoy, pero con MySQL, no con clave-valor

[`checkoutService.js`](../backend/src/services/checkoutService.js): el descuento de inventario ya es atómico — una transacción de Prisma que valida stock y descuenta `inventario.cantidad` en MySQL, con rollback automático si algo falla (verificado con `verificar:checkout`, incluyendo el caso de sobreventa rechazada). **Esto no cumple el requerimiento de Entrega 2 tal cual** — el PRD pide explícitamente que la atomicidad bajo concurrencia se resuelva con operaciones atómicas *del almacén clave-valor*, no con una transacción relacional. Es una funcionalidad nueva (oferta flash con Redis) que coexiste con el checkout normal, no un reemplazo del mecanismo ya construido y verificado — ver §4.2 para cómo se relacionan sin pisarse.

`Producto.inventario` (Mongo) ya es una copia de lectura de `inventario` (MySQL), reenviada en cada escritura (ver [ADR-002 §3.3/§3.6](ADR-002-migracion-catalogo-documental.md)) — mismo patrón de "una base transaccional + reenvío a una copia de lectura en otra" que se puede reutilizar para relacionar Redis con MySQL en la oferta flash.

### 2.3 Reseñas — decididas, no construidas — **prerrequisito real para grafos**

[ADR-002](ADR-002-migracion-catalogo-documental.md), sección 6.1 "Reseñas de producto", ya decidió el modelo (colección `resenas` en Mongo, `resenas_resumen` embebido en el producto), pero **no existe ni una sola reseña real en el sistema** — no hay colección, no hay endpoint, no hay UI. Esto no bloqueaba Entrega 1 (el PRD solo exigía la decisión embed/reference, no la implementación), pero **sí bloquea Entrega 2**: el requerimiento de grafos es "modelo cuentas-reseñas-productos + consulta multi-salto que detecte patrón anómalo" — sin reseñas reales (o al menos simuladas a propósito), no hay datos de qué patrón detectar. Ver §4.3 y §5.

### 2.4 Redis / Neo4j — no existen en el stack todavía

`docker-compose.yml` tiene `mysql` y `mongo` únicamente. Sin dependencia `redis`/`ioredis` ni `neo4j-driver` en `backend/package.json`. Sin ningún archivo bajo `backend/src/config/` para ninguna de las dos. Se empieza de cero en ambas — no hay nada que migrar de una versión previa a diferencia de, por ejemplo, la migración a Mongo que sí tenía datos relacionales de origen.

---

## 3. Decisión: grafos (Neo4j) vs. columnar — formato ADR

Formato exigido por [PRD §6](PRD.md#6-registro-de-decisiones-arquitectónicas-adr).

### Contexto

Dos necesidades de análisis, cada una candidata a una familia distinta:
1. **Detección de fraude en reseñas** — identificar relaciones anómalas entre cuentas, reseñas y productos (p. ej. cuentas coordinadas que reseñan en bloque). Es un problema de **relaciones y su forma**, no de agregación tabular.
2. **Panel de tendencias de venta** — ventas por intervalos de tiempo, productos en ascenso de demanda. Es un problema de **series de tiempo y agregación por rango**, no de relaciones.

El PRD exige implementar *una* de las dos familias con su reto específico, y documentar formalmente por qué la otra no se justifica todavía.

### Alternativas consideradas

| Opción | Resuelve | Descartada por |
|---|---|---|
| **Grafos (Neo4j)** — elegida | Fraude en reseñas | — |
| Columnar (Cassandra/ScyllaDB) | Tendencias de venta | Ver Justificación |
| Ambas familias | Los dos análisis | Fuera de alcance — el PRD pide una, y sumar la segunda sin necesidad va contra el criterio explícito del PRD de que la *calidad* del análisis pesa más que la *cantidad* de tecnologías (§2, §6) |
| Ninguna | — | No viable — el PRD exige al menos una implementada |

### Decisión

Grafos (Neo4j), implementando detección de fraude en reseñas. Columnar queda documentado como no seleccionado (ver §3.4 de este documento, la sección de condiciones).

### Justificación (criterios específicos al sistema, no genéricos)

- **Patrón de consulta real de cada problema:**
  - Fraude en reseñas necesita **traversal multi-salto**: "cuentas que reseñaron el mismo conjunto acotado de productos en una ventana de tiempo corta, todas con calificación alta" no es una fila ni un rango — es un patrón de conexión entre nodos que en SQL o en Mongo requeriría varios self-joins/lookups encadenados y no escala legible. Es exactamente el caso de uso de referencia de un grafo (Cypher resuelve esto con un patrón de camino de N saltos en una sola consulta).
  - Tendencias de venta, en cambio, es agregación por bucket de tiempo sobre datos append-only — el patrón que Cassandra/ScyllaDB resuelve bien a **escala de escritura sostenida en cluster**. Este proyecto ya tiene precedente de resolver exactamente ese patrón (bucket de tiempo + agregación) sin una base columnar: `estadisticasEdiciones()` ([ADR-003 §3.4](ADR-003-historial-cambios-eventos.md)) agrupa `producto_eventos` por fecha con el framework de agregación de Mongo, y `total_vendido` (Mongo) ya cachea una métrica de venta acumulada. El patrón "tendencias por intervalo" es una extensión natural de algo que el proyecto ya sabe hacer sin sumar una base nueva.
  - Conclusión: el problema que *sí* necesita una familia nueva de verdad es el de fraude — el de tendencias es resoluble con lo que ya hay.
- **Diversificación real de la evaluación técnica:** Fase Inicial ya cubrió relacional, Entrega 1 ya cubrió documental (con agregación e índices compuestos). Un panel de tendencias en columnar seguiría ejercitando "agregación por rango", una habilidad que el proyecto ya demostró en Entrega 1. Grafos ejercita algo genuinamente nuevo (traversal de relaciones), que es más alineado con el objetivo del PRD (§2) de demostrar criterio técnico sobre familias *distintas*, no repetir el mismo tipo de consulta con otro motor.
- **Costo operativo comparable:** ambas opciones agregan un contenedor Docker nuevo y un driver nuevo — ninguna es claramente más barata de operar que la otra a la escala de este proyecto, así que el costo operativo no inclina la decisión en ningún sentido (a diferencia de, por ejemplo, ADR-002 §3.2, donde el costo de romper la atomicidad del checkout sí fue decisivo).

### Consecuencias

**Beneficios:**
- Cubre un patrón de consulta (traversal multi-salto) que ningún otro componente del stack resuelve bien hoy.
- Reutiliza un patrón de sincronización ya probado en este proyecto (base transaccional + reenvío de mejor esfuerzo a una copia especializada en otra base, ver ADR-002 §3.3) — la relación Mongo (reseñas, fuente de verdad) → Neo4j (grafo, copia especializada para el análisis) es la misma forma que MySQL (`inventario`) → Mongo (`Producto.inventario`).

**Limitaciones asumidas:**
- **Las reseñas no existen todavía** (§2.3) — implementar grafos sin datos reales de reseñas obliga a construir primero una versión mínima de esa funcionalidad, que no era parte de esta entrega según el PRD original. Es trabajo adicional real, no un detalle menor.
- **No hay fraude real que detectar** en los datos de prueba de un proyecto de curso — la consulta multi-salto necesita datos sembrados a propósito (un pequeño "anillo" de cuentas de prueba con patrón de reseña coordinado) para tener algo concreto que encontrar. Hay que documentar esos datos como sintéticos y deliberados, no presentarlos como hallazgo orgánico.
- Un componente más para operar, respaldar y en el que razonar (mismo trade-off ya asumido en ADR-002 §5 al sumar Mongo).

### 3.4 Condiciones bajo las cuales columnar (Cassandra/ScyllaDB) sí estaría justificado

Requerimiento explícito del PRD para la familia no seleccionada:

- **Volumen de escritura sostenido que un solo nodo de Mongo no pueda absorber** — p. ej., miles de eventos de venta por segundo en horas pico, donde la necesidad real ya no es "agregar por intervalo" (que Mongo resuelve) sino "ingerir sin caerse" a una tasa que exige escalado horizontal de escritura entre varios nodos, el punto fuerte real de Cassandra/ScyllaDB.
- **Retención masiva de series de tiempo con TTL nativo por partición** — si el panel de tendencias necesitara conservar datos crudos (no agregados) durante años a un volumen que hiciera cara la retención en Mongo, el modelo de particionamiento por tiempo de una base columnar (con expiración nativa por partición) sería la herramienta correcta.
- **Necesidad de lecturas de rango extremadamente predecibles a gran escala** (p. ej. dashboards de BI consultados constantemente por muchos analistas a la vez) — el modelo de fila ancha de Cassandra está optimizado específicamente para ese acceso, más que la agregación general de Mongo.

Ninguna de estas tres condiciones aplica a la escala actual del proyecto (5 productos de prueba, un puñado de compras) — es la razón concreta, no genérica, de por qué no se justifica sumarla ahora.

---

## 4. Plan de implementación

### 4.1 Carrito en Redis (implementado y verificado, 2026-08-30)

**Decisión de identidad de sesión:** el carrito ahora **requiere sesión iniciada** — ya no hay carrito anónimo. Se clavea directamente por `usuario.id_usuario` (no una cookie de sesión separada), así que no hace falta ningún mecanismo de fusión al iniciar sesión: el carrito de un usuario es siempre el mismo carrito, esté logueado desde hace rato o recién.

**Esquema de claves (Redis), tal cual implementado:**
```
carrito:{usuario.id_usuario}   → hash: { "productoId": "cantidad", ... }
```
Un hash por usuario, no una clave por línea — el TTL se administra en un solo lugar por carrito, no por ítem.

**TTL — 7.5 minutos (450s), por inactividad, no fijo:** se reinicia en **cualquier** interacción — incluida una simple lectura (`GET /api/carrito`), no solo agregar/quitar — porque "inactividad" significa que ni mirar el carrito cuenta como actividad. Implementado con `EXPIRE carrito:{id} 450` reejecutado en cada operación de `cartService.js`, nunca puesto una sola vez al crear la clave. Verificado en `scripts/verificarCarrito.js`: TTL sube de nuevo tras una lectura posterior, no solo se mantiene.

**Efecto sobre el checkout** (requerimiento explícito del PRD):
- Si el TTL vence antes de pagar, el carrito desaparece — igual que un carrito vacío por cualquier otro motivo, sin caso especial.
- Si el checkout falla, el carrito no se toca — mismo comportamiento que ya tenía antes de Redis (`CheckoutPage.jsx`, `vaciar()` solo dentro del `try`).
- Si el checkout tiene éxito, el carrito se vacía **del lado del servidor**, dentro de `checkoutService.checkout()` mismo — no se dejó como una responsabilidad exclusiva del cliente (el frontend también lo pide aparte, de forma redundante/best-effort, pero ya no es la única garantía). Se decidió así después de notar, al escribir la verificación, que depender solo del cliente para este paso dejaba una ventana real (pestaña cerrada justo después de pagar) donde el carrito seguiría mostrando algo ya comprado.

**Backend** — `cartService.js` + `cartRoutes.js` (todo detrás de `requireAuth`, sin excepción):
```
GET    /api/carrito              → contenido actual (resuelve cada productoId contra Mongo para descripción/precio/imagen vigentes)
POST   /api/carrito/items        → {productoId, cantidad}, suma a lo ya existente, clamp contra stock vigente
PATCH  /api/carrito/items/:id    → {cantidad}, fija la cantidad exacta
DELETE /api/carrito/items/:id    → quitar un ítem
DELETE /api/carrito              → vaciar completo
```

**Frontend:** `CartContext.jsx` mantiene la misma interfaz pública (`items`, `agregar`, `actualizarCantidad`, `quitar`, `vaciar`, `cantidadTotal`, `total`) para no tocar los componentes que ya lo consumían (`Header`, `ProductCard`, `CheckoutPage`) — internamente pasó de mutaciones síncronas de `localStorage` a llamadas async contra la API nueva. `agregar()` ahora devuelve si de verdad agregó algo (`false` si redirigió a `/login` por falta de sesión) para que quien la llama no actúe como si hubiera funcionado — encontrado al migrar el botón "Comprar ahora" (`ProductDetailPage.jsx`), que navegaba a `/carrito` sin importar el resultado.

Verificación completa (`npm run verificar:carrito`) y en el navegador: agregar/TTL/clamp/quitar/checkout, más un caso que el plan original no había previsto — el carrito **persiste a través de un ciclo logout→login** (beneficio directo de clavear por usuario en vez de por sesión de navegador), confirmado manualmente.

### 4.2 Oferta de inventario limitado (implementado y verificado, 2026-08-30)

**Estado:** implementado end-to-end y probado bajo concurrencia real — ver `backend/scripts/verificarOfertaFlash.js` (`npm run verificar:ofertaFlash`) y ESTADO-PROYECTO.md §3.8 para el detalle completo. Resumen de lo que cambió respecto al plan original de abajo:

- **Modelo elegido** (de las opciones discutidas): un flag en el producto real del catálogo, no un concepto separado — `Producto.oferta_flash` (Mongo): `{activo, precio_oferta, stock_oferta, vigente_desde, vigente_hasta}`, embebido, 1:1, mismo criterio que `resenas_resumen`. El vendedor/administrador lo activa desde el propio formulario de edición de producto (`SellerProductFormPage.jsx`) — no hizo falta una pantalla nueva.
- **`ofertaId` = `producto_id`** — no un id separado, ya que un producto tiene a lo sumo una oferta activa a la vez.
- **La ventana de vigencia maneja el TTL de Redis, no solo el flag `activo`**: comprar exige `activo === true` Y estar dentro de `[vigente_desde, vigente_hasta]`; el TTL de la clave de Redis se calcula como `segundos_hasta(vigente_hasta)` en el momento del lazy-init, así que la clave vence sola cuando termina la ventana anunciada, sin necesidad de un barrido/cron aparte. `activo` queda como interruptor independiente (pausar sin tocar fechas, o preparar una oferta de antemano con `activo:false`).
- Todo lo demás (script Lua atómico, dos guardas, reenvío best-effort, verificación bajo concurrencia) se implementó tal como se planeó abajo — ver el detalle técnico completo, y el código real, en ESTADO-PROYECTO.md §3.8.

Es una funcionalidad **nueva y separada** del checkout normal, no un reemplazo — el checkout normal sigue con su transacción de Prisma tal cual está, verificada y sin tocar (ver §2.2). La oferta flash es un *gate* adicional delante de un subconjunto acotado de unidades.

**Por qué un `DECR` simple no alcanza (para tenerlo documentado, es justo el tipo de detalle que la rúbrica de "operaciones atómicas... sin bloqueos a nivel de aplicación" premia):** decrementar y *después* chequear si el resultado es negativo dentro de la aplicación no es atómico de punta a punta si algo más lee el valor entre el decremento y el chequeo — hay que resolverlo en una sola operación atómica en Redis. Dos formas correctas:
- **Lua script** (`EVAL`) que en una sola ejecución atómica lee el stock, decide si hay suficiente, decrementa y devuelve el resultado — Redis ejecuta scripts Lua de forma atómica por diseño, sin necesidad de locks de aplicación.
- `DECRBY` seguido de: si el resultado quedó negativo, revertir con `INCRBY` y rechazar. Funciona, pero dos comandos separados (aunque cada uno es atómico individualmente) — el script Lua es la versión más prolija y la que mejor demuestra "sin bloqueos a nivel de aplicación" para el informe.

**Esquema propuesto:**
```
oferta:{ofertaId}:stock      → entero, inicializado desde una porción de inventario.cantidad (no el total)
```

**Relación con MySQL — dos guardas, no una:** ganar el `DECR`/script en Redis es una **admisión rápida** ("tenés derecho a intentar comprar al precio de oferta"), no la confirmación final. El checkout real que sigue (crear pedido + pago + descuento de `inventario.cantidad`) sigue pasando por la transacción de Prisma ya existente, que es la que de verdad decide si la compra se concreta. Esto evita que la oferta en Redis y el inventario real en MySQL puedan desincronizarse en el peor caso (Redis dice que hay stock de oferta pero MySQL ya no tiene stock real) — la transacción de MySQL sigue siendo la autoridad final, exactamente el mismo principio que ya rige para `inventario`/Mongo desde ADR-002 §3.2/§3.3, aplicado ahora a Redis en vez de a Mongo.

**Validación bajo concurrencia simulada** (requerimiento explícito): un script (`backend/scripts/verificarOfertaFlash.js`, mismo espíritu que `verificarCheckout.js`) que dispare **N requests concurrentes** (`Promise.all` con más solicitudes que unidades disponibles) contra el endpoint de la oferta y verifique: exactamente `stock inicial` ganadores, el resto rechazado, y el contador final en Redis en exactamente `0` (no negativo, no positivo de más).

### 4.3 Reseñas — versión mínima (prerrequisito, Mongo)

Alcance acotado a lo que el grafo necesita, no la funcionalidad completa que describe ADR-002 §6.1:
- Colección `resenas` (Mongo): `{ producto_id, usuario_id, calificacion, comentario, fecha }`.
- Endpoint para crear una reseña (comprador, solo si tiene una compra de ese producto — la validación en sí misma es útil para el fraude: un comprador *sin* compra real que reseña es ya una señal).
- `resenas_resumen` embebido en `Producto` (Mongo), recalculado al crear una reseña — el campo ya está declarado en el schema (`Producto.js`, `resenas_resumen: {promedio, cantidad}`), nunca poblado hasta ahora.
- UI mínima: mostrar reseñas en `ProductDetailPage`, formulario simple para dejar una.
- **Datos sembrados a propósito**: un pequeño conjunto de cuentas de prueba con patrón de reseña coordinado (mismos productos, calificación alta, ventana de tiempo corta), documentado explícitamente como sintético — es lo que le da a la consulta de grafos algo real que encontrar (ver §3, Limitaciones asumidas).

### 4.4 Grafos: detección de fraude (Neo4j)

**Modelo propuesto:**
```
(:Usuario {id_usuario, nombre})
(:Producto {producto_id, descripcion})
(:Usuario)-[:RESEÑÓ {calificacion, fecha}]->(:Producto)
(:Usuario)-[:COMPRÓ {fecha}]->(:Producto)
```
Reseñas y compras como relaciones (no nodos aparte) — es el patrón bipartito estándar para este tipo de análisis, y permite la señal de fraude más directa y defendible: **reseñar sin haber comprado**.

**Sincronización:** mismo patrón ya usado en el proyecto (ADR-002 §3.3) — Mongo (`resenas`) es la fuente de verdad, se reenvía a Neo4j como relación `RESEÑÓ` después de cada escritura, de mejor esfuerzo. Las compras (`compra_detalle`, MySQL) se reenvían igual como relación `COMPRÓ`, al confirmarse el checkout — mismo punto donde ya se reenvía `total_vendido` a Mongo (`checkoutService.js`).

**Consulta multi-salto propuesta** (patrón de cuentas coordinadas — reseñan en bloque el mismo conjunto de productos en una ventana corta, sin haber comprado):
```cypher
MATCH (u1:Usuario)-[r1:RESEÑÓ]->(p:Producto)<-[r2:RESEÑÓ]-(u2:Usuario)
WHERE u1 <> u2
  AND abs(duration.between(r1.fecha, r2.fecha).seconds) < 3600
  AND r1.calificacion >= 4 AND r2.calificacion >= 4
  AND NOT (u1)-[:COMPRÓ]->(p)
  AND NOT (u2)-[:COMPRÓ]->(p)
WITH u1, u2, count(p) AS productosCompartidos
WHERE productosCompartidos >= 3
RETURN u1.nombre, u2.nombre, productosCompartidos
ORDER BY productosCompartidos DESC
```
Dos saltos (`Usuario`→`Producto`→`Usuario`) con condiciones sobre ambas relaciones — cumple "consulta multi-salto que detecte patrón anómalo de interacción" tal como lo pide el PRD.

**Panel administrativo** (funcionalidad del PRD asociada a elegir grafos): una pantalla nueva en `/admin` que corre esta consulta y lista los pares/grupos de cuentas señalados, con link a cada producto en común — mismo estilo que el widget "Productos más editados" ya existente en `AdminDashboardPage.jsx`.

### 4.5 Recomendaciones por tendencia (implementado y verificado, 2026-08-31)

**No es un requerimiento nuevo del PRD** — es una segunda forma de llegar a "oferta flash", agregada a pedido, que complementa a §4.2 sin reemplazarlo. §4.2 sigue intacta y sin tocar: un vendedor sigue pudiendo configurar una oferta a mano sobre su propio producto, con exactamente el mismo mecanismo ya verificado. Esto es un camino ADICIONAL: en vez de que un vendedor decida qué ofrecer, el sistema analiza el historial real de compras de cada comprador y encuentra, automáticamente, productos similares de **otros** vendedores — sin que nadie lo configure.

**Por qué seguía haciendo falta Redis, aunque a primera vista una recomendación personalizada no tiene un pool compartido que cuidar:** la duda inicial era razonable — si el precio es personalizado, ¿quién está compitiendo por qué? La respuesta terminó siendo: Redis pasa a cumplir DOS roles distintos, no uno:
- **Caché** (`recomendaciones:{usuarioId}`, TTL de 1h): el análisis cruza `compra_detalle` (MySQL) con `Producto` (Mongo) — no tiene sentido recalcularlo en cada vista del catálogo. Este rol es nuevo, no existía en §4.2.
- **Admisión atómica** (`oferta-recomendada:{productoId}:{usuarioId}:stock`), el mismo script Lua de §4.2 (`decrementarOferta`, reutilizado sin cambios) — pero la clave ahora es por **(producto, usuario)**, no global. No hay un pool compartido entre compradores distintos, pero sí un cupo personal (2 unidades) que protege contra doble clic, dos pestañas, o un reintento de red — la misma clase de problema que resuelve un `DECR` simple no basta, solo que ahora la carrera es contra uno mismo en vez de contra el resto de los compradores.

**Análisis de tendencia** (`tendenciaService.analizarTendencia`, `backend/src/services/tendenciaService.js`): no hay join real entre MySQL y Mongo, se resuelve en la aplicación —
1. `compra_detalle` del usuario (MySQL) → subcategoría con más unidades compradas en total (Mongo, resolviendo cada `id_producto`).
2. Dentro de esa subcategoría: el valor más común POR NOMBRE de atributo (no el par nombre+valor más frecuente en general — así "Almacenamiento" y "RAM" quedan representados los dos, no solo el que más se repite) y el vendedor más comprado.

**Coincidencias** (`buscarCoincidencias`): productos activos de esa subcategoría, de CUALQUIER vendedor, puntuados por cuántos atributos preferidos comparten — no exige que coincidan todos (a diferencia del filtro de facetas del catálogo normal), porque con un catálogo chico exigir coincidencia total devuelve fácilmente cero resultados. 15% de descuento sobre el precio normal, simple y fácil de ajustar después.

**Guardia 2, reutilizada sin cambios:** `checkoutService.checkoutOferta()` — la misma función de §4.2, ni una línea nueva. El precio (`precio_recomendado`) se vuelve a validar contra la recomendación vigente del usuario en el momento de comprar, nunca se confía en un precio que mande el cliente — sin esto, cualquiera podría pedir el descuento en un producto cualquiera adivinando la URL.

**Datos sembrados a propósito** (mismo criterio que §4.3 para reseñas coordinadas): el catálogo original tenía un solo vendedor por subcategoría — sin un segundo vendedor con los MISMOS atributos, no hay nada que la comparación pueda encontrar. Se agregó una segunda cuenta de vendedor (Marta Díaz) con productos que comparten atributos con los de Luis en Camisetas y Celulares (`prisma/seed.js`, y sembrado también en la base de desarrollo ya en uso por `verificarRecomendaciones.js`), y `RAM` como atributo nuevo de la subcategoría Celulares.

**Verificación** (`npm run verificar:recomendaciones`, `backend/scripts/verificarRecomendaciones.js`): corrida real contra el historial de compras YA ACUMULADO de Ana durante el resto de las pruebas de este proyecto (no fabricado para este script) — detectó correctamente Camisetas/Talla:M/Color:Azul/Luis como su tendencia dominante, encontró el producto de Marta como coincidencia cruzada con un precio menor al normal, y bajo 7 intentos de compra simultáneos sobre un cupo personal de 2, admitió exactamente 2, rechazó el resto, el contador en Redis terminó en 0, y el inventario real en MySQL se descontó en exactamente 2 unidades. Un intento de comprar un producto que no es una recomendación vigente se rechazó con 403. Probado también de punta a punta en el navegador como Ana: la sección "Recomendado para vos" aparece en el inicio con la explicación de por qué, y una compra se confirma al precio recomendado (referencia `TX-OFERTA-...`, mismo prefijo que la oferta flash porque reutiliza la misma `checkoutOferta`).

---

## 5. Riesgos y dependencias

- **Reseñas es una dependencia dura, no un detalle** — sin §4.3 completo, §4.4 no tiene nada que consultar. Conviene planificarlo en ese orden explícitamente, no en paralelo asumiendo que "ya va a estar listo".
- **La oferta de inventario limitado (§4.2) es el ítem de mayor riesgo de diseño** — dos guardas (Redis + MySQL) que tienen que coordinarse sin desincronizarse ni bloquearse mutuamente. Vale prototipar y validar la concurrencia simulada temprano, no dejarlo para el final.
- Dos infraestructuras nuevas (Redis, Neo4j) suman a las dos que ya corren (MySQL, Mongo) — cuatro contenedores Docker en desarrollo. Vale confirmar que el entorno de todo el equipo los soporta cómodamente antes de la semana de entrega. Redis ya está sumado y probado; falta Neo4j.

---

## 6. Preguntas abiertas para el equipo

- ~~¿Carrito anónimo o solo con sesión iniciada?~~ — resuelto: requiere sesión (§4.1).
- ~~Valor de TTL por inactividad~~ — resuelto: 7.5 min / 450s (§4.1).
- ~~Cuántas unidades y qué producto(s) usar para demostrar la oferta flash~~ — resuelto: un producto real del catálogo, marcado con `oferta_flash` (§4.2). La cantidad es configurable por el vendedor/administrador; la verificación automática usa 5 unidades contra 15 intentos concurrentes.
- Alcance real de la UI de reseñas — ¿algo mínimo (solo lo que el grafo necesita, §4.3) o la funcionalidad completa que ya describe ADR-002 §6.1 (con `resenas_resumen` visible en el catálogo, no solo en el detalle)?

---

## 7. Orden de trabajo sugerido

1. ~~Redis + migración del carrito (§4.1)~~ — ✅ hecho (2026-08-30).
2. ~~Oferta de inventario limitado (§4.2)~~ — ✅ hecho (2026-08-30).
3. Reseñas mínimas (§4.3) — en paralelo a 1-2 si el equipo lo divide, pero **antes** del paso 4 sin excepción.
4. Neo4j + detección de fraude + panel admin (§4.4) — depende del paso 3.
5. Redacción final: evaluación comparativa (§3), diagrama de arquitectura actualizado, informe.

---

## 8. Rúbrica mapeada (checklist de avance)

| Criterio (PRD) | Peso | Estado |
|---|---|---|
| Carrito clave-valor + TTL justificado | 1.5 pts | ✅ Implementado y verificado (2026-08-30) — ver ESTADO-PROYECTO.md |
| Oferta de inventario limitado, atómica, bajo concurrencia | 3.0 pts | ✅ Implementado y verificado (2026-08-30) — ver ESTADO-PROYECTO.md §3.8 |
| Evaluación comparativa grafos vs. columnar | 1.5 pts | ✅ Redactada en este documento (§3) |
| Implementación de grafos + reto específico (consulta multi-salto) | 3.0 pts | ⬜ No iniciado — plan en §4.3/§4.4, bloqueado por reseñas |
| Calidad del informe + diagrama de arquitectura actualizado | 1.0 pt | ⬜ Diagrama de arquitectura todavía no existe como artefacto versionado — pendiente para el cierre de la entrega |
