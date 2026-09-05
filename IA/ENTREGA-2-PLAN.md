# Plan — Entrega 2 (Clave-Valor, Columnar)

> Creado: 2026-08-30. Actualizado: 2026-09-04. Este documento conserva el plan y la evidencia previa de Redis y registra el cambio de alcance a ventas. La decisión vigente se desarrolla en [ADR-004](ADR-004-analitica-ventas-cassandra.md); las propuestas de reseñas y Neo4j de §4.3/§4.4 quedan identificadas como históricas y aplazadas.
>
> **Decisión vigente del equipo:** almacén clave-valor → **Redis**. Familia grafos/columnar → **Apache Cassandra** (columnas anchas, *wide-column*, incluida por el PRD en la familia columnar). Implementación y evidencia local registradas el 2026-09-05 en ADR-004 §9.

---

## 1. Alcance: qué pide el PRD

Resumen de [PRD.md §5](PRD.md#5-entregas-y-requerimientos), sección Entrega 2, con el estado y la familia elegida por el equipo.

> **Contexto del PRD:** El carrito relacional genera escrituras/lecturas frecuentes de datos transitorios. La venta de unidades limitadas bajo concurrencia exige atomicidad sin bloqueos de aplicación. Las necesidades de análisis de fraude y tendencias requieren evaluación de familias distintas.

**Funcionalidades:**
- Carrito persistente por sesión con expiración automática por inactividad
- Oferta flash: N unidades disponibles bajo múltiples solicitudes concurrentes, sin sobreventa
- Panel administrativo: patrones de posible manipulación de reseñas *(aplazado — familia de grafos no seleccionada)*
- Panel de actividad de ventas por intervalos de tiempo y productos en ascenso *(aplica — elegimos Cassandra)*

**Requerimientos técnicos:**
- [x] Carrito sobre almacén clave-valor (Redis) con **TTL configurado explícitamente** y **efecto documentado sobre el checkout**
- [x] Oferta de inventario limitado mediante **operaciones atómicas** del almacén clave-valor, validada bajo **concurrencia simulada** (sin bloqueos a nivel de aplicación), según evidencia previa de §4.2
- [x] **Evaluación comparativa** de grafos vs. columnar para ambos análisis, actualizada en [ADR-004 §2](ADR-004-analitica-ventas-cassandra.md#2-alternativas-y-decisión)
- [x] Implementación de **al menos una familia**: Cassandra, modelo por intervalos y comparación de demanda entre períodos; evidencia en ADR-004 §9
- [x] Para grafos (no seleccionada): condiciones de incorporación en [ADR-004 §8](ADR-004-analitica-ventas-cassandra.md#8-cuándo-incorporar-grafos)

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

### 2.3 Reseñas — decididas, no construidas; dependencia de la opción de grafos aplazada

[ADR-002](ADR-002-migracion-catalogo-documental.md), sección 6.1 "Reseñas de producto", decidió el modelo (colección `resenas` en Mongo, `resenas_resumen` embebido en el producto), pero no existen su colección, endpoint o UI implementados. Esa ausencia sería una dependencia de un detector en Neo4j. **No bloquea el panel Cassandra seleccionado**: sus datos de origen son las compras ya registradas en MySQL.

### 2.4 Infraestructura vigente y siguiente incorporación

MySQL, MongoDB y Redis ya tienen integración en el proyecto. Se incorpora Cassandra al mismo `docker-compose.yml`, con driver del backend, volumen persistente y un nodo de desarrollo. No se incorpora `neo4j-driver`. Los comandos de arranque, migración de outbox, carga histórica y pruebas de ventas están en el [README](../README.md); que estén documentados no acredita todavía ejecución ni disponibilidad de los servicios.

---

## 3. Decisión vigente: Cassandra; Neo4j aplazado

El registro formal vigente, con el formato exigido por [PRD §6](PRD.md#6-registro-de-decisiones-arquitectónicas-adr), es [ADR-004 — Analítica de ventas por intervalos con Cassandra](ADR-004-analitica-ventas-cassandra.md).

### Contexto

Dos necesidades de análisis, cada una candidata a una familia distinta:
1. **Detección de fraude en reseñas** — identificar relaciones anómalas entre cuentas, reseñas y productos (p. ej. cuentas coordinadas que reseñan en bloque). Es un problema de **relaciones y su forma**, no de agregación tabular.
2. **Panel de tendencias de venta** — ventas por intervalos de tiempo, productos en ascenso de demanda. Es un problema de **series de tiempo y agregación por rango**, no de relaciones.

El PRD exige implementar **al menos una** de las dos familias con su reto específico y documentar las condiciones para incorporar la no seleccionada. Permite ambas; no exige exactamente una.

### Alternativas consideradas

| Opción | Resuelve | Decisión vigente |
|---|---|---|
| Grafos (Neo4j) | Fraude en reseñas | Aplazado; primero harían falta reseñas y una necesidad de recorrer sus relaciones |
| **Columnar (Cassandra)** — elegida | Tendencias de venta | Aprovecha el historial SQL existente y desarrolla el panel priorizado por el equipo |
| Ambas familias | Los dos análisis | Permitido, pero fuera del alcance actual acordado; no se demuestra necesidad de ambas |
| Ninguna | — | No viable — el PRD exige al menos una implementada |

### Decisión

Cassandra como copia analítica desde MySQL, consultada por particiones temporales y de producto. Express agrupa resultados acotados para una gráfica de ventas y una comparación de demanda entre períodos. El checkout sigue siendo transaccional en MySQL; un outbox captura cada venta y un worker la replica con reintentos idempotentes.

**Histórico de la decisión:** el 2026-08-30 se había elegido preliminarmente Neo4j para demostrar consultas multi-salto sobre cuentas, reseñas y productos. Esa elección quedó reemplazada el 2026-09-04 al priorizar el equipo el panel de ventas. Las propuestas de §4.3/§4.4 se conservan como antecedente aplazado, no como tareas obligatorias de esta entrega.

### Justificación (criterios específicos al sistema, no genéricos)

- **Datos disponibles:** las tres modalidades de compra ya producen detalle, importe, cantidad y fecha en MySQL; no hace falta construir antes el sistema de reseñas.
- **Patrones de acceso concretos:** todos los productos de un día y un producto en un mes. Dos proyecciones Cassandra permiten consultar esas particiones sin joins ni búsquedas globales con `ALLOW FILTERING`.
- **Separación de responsabilidades:** MySQL confirma ventas y el panel consulta su copia. `total_vendido` de Mongo sigue siendo una caché acumulada para catálogo, sin confundirla con una serie temporal.
- **Alcance docente explícito:** el volumen actual podría analizarse en SQL. Incorporar columnas anchas permite demostrar el modelado por consultas pedido por el PRD, sin atribuir a Cassandra una necesidad de escala que no se ha medido.

### Consecuencias

**Beneficios:**
- Entrega el panel de ventas seleccionado con filtros compartidos y comparación de ventanas.
- Conserva la atomicidad MySQL y agrega entrega recuperable mediante outbox, sin hacer depender una compra de la disponibilidad de Cassandra.

**Limitaciones asumidas:**
- Copia eventual: el panel puede demorarse al menos hasta el siguiente ciclo del worker y más si hay fallos o reintentos.
- Agregación en backend sobre lectura acotada a 90 días recientes más la ventana anterior; la cantidad de filas todavía influye en el costo.
- Un nodo Cassandra en Docker para desarrollo no ofrece alta disponibilidad. Un rango temporal acotado tampoco prueba rendimiento a gran escala.
- Cancelaciones y reembolsos no están implementados; el modelo deberá incorporar ajustes si se agregan.

### 3.4 Condiciones bajo las cuales grafos (Neo4j) estaría justificado

Requerimiento explícito del PRD para la familia no seleccionada:

- Reseñas persistidas y suficientes relaciones entre cuentas, productos y vendedores para que el análisis tenga datos de origen.
- Una consulta real de varios saltos, como grupos de cuentas que coinciden de manera reiterada en reseñas de los mismos productos dentro de ventanas cortas.
- Un flujo de revisión de señales y una estrategia de reconstrucción del grafo desde las fuentes; datos sintéticos identificados como tales si se usan para demostrar el patrón.

La ausencia actual de reseñas y la prioridad acordada del panel permiten aplazar esa incorporación. La comparación completa y las consecuencias están en [ADR-004](ADR-004-analitica-ventas-cassandra.md).

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

### 4.3 Reseñas — propuesta histórica aplazada (Mongo)

> Antecedente del plan Neo4j del 2026-08-30. No es dependencia del panel Cassandra seleccionado; si se retoma grafos, habrá que revisar conjuntamente el modelo, sus señales y la política de creación de reseñas.

Alcance acotado a lo que el grafo necesita, no la funcionalidad completa que describe ADR-002 §6.1:
- Colección `resenas` (Mongo): `{ producto_id, usuario_id, calificacion, comentario, fecha }`.
- Endpoint para crear una reseña (comprador, solo si tiene una compra de ese producto — la validación en sí misma es útil para el fraude: un comprador *sin* compra real que reseña es ya una señal).
- `resenas_resumen` embebido en `Producto` (Mongo), recalculado al crear una reseña — el campo ya está declarado en el schema (`Producto.js`, `resenas_resumen: {promedio, cantidad}`), nunca poblado hasta ahora.
- UI mínima: mostrar reseñas en `ProductDetailPage`, formulario simple para dejar una.
- **Datos sembrados a propósito**: un pequeño conjunto de cuentas de prueba con patrón de reseña coordinado (mismos productos, calificación alta, ventana de tiempo corta), documentado explícitamente como sintético — es lo que le da a la consulta de grafos algo real que encontrar (ver §3, Limitaciones asumidas).

### 4.4 Grafos: detección de fraude (Neo4j) — propuesta histórica aplazada

> Este diseño no está implementado ni forma parte del alcance vigente. Se conserva para mostrar el análisis previo; el registro actual es ADR-004. La propuesta debe revisarse antes de retomarla: §4.3 exige compra previa para reseñar, mientras que el ejemplo de consulta siguiente busca reseñas sin compra, un caso que ese flujo normal no produciría.

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

### 4.6 Panel de ventas por intervalos y ascenso de demanda (Cassandra)

Decisión y modelo detallados en [ADR-004](ADR-004-analitica-ventas-cassandra.md). **Estado: implementado; carga histórica, conciliación, permisos HTTP y build verificados.** La inspección visual autenticada queda pendiente; límites y evidencia en ADR-004 §9.

- **Fuente:** `compra_detalle` + `compra.fecha` en MySQL, con existencia de un pago aprobado. El detalle puede seguir `pendiente`. `precio_final` ya es total neto de línea; `descuento` es ahorro total y no se resta de nuevo.
- **Captura:** tabla MySQL `venta_outbox`, PK `detalle_id`, con `payload`, `procesado_en`, `intentos`, `proximo_intento`, `ultimo_error`; se escribe en la transacción de ambos métodos de checkout. Abarca compras normales, flash y recomendadas.
- **Entrega:** worker cada 30 s por defecto, reintentos programados y marcado de procesado solo después de escribir las dos proyecciones. La misma clave y valores permiten repetir una entrega sin duplicar ventas.
- **Cassandra:** `ventas_por_dia`, clave `((dia), fecha_venta, detalle_id)`, y `ventas_por_producto_mes`, clave `((producto_id, mes), fecha_venta, detalle_id)`. Dinero en decimal. Consultas por particiones conocidas y agregación acotada en Express.
- **Panel:** `/admin/ventas` consume `GET /api/admin/ventas`, solo para administrador. Fechas inclusivas Guatemala UTC−6, intervalo día/semana/mes, producto y mínimo de unidades recientes (5 por defecto). Rango máximo de 90 días, sin fechas futuras.
- **Comparación:** período inmediatamente anterior de igual duración, incremento en unidades y porcentaje. Base anterior cero produce porcentaje `null`, mostrado sin base de comparación. Si se incluye hoy, el último día puede estar incompleto.
- **Lecturas:** Cassandra aporta las métricas y Mongo las descripciones actuales. Si Cassandra falla, se informa indisponibilidad; no hay sustitución financiera por MySQL.
- **Operación:** `npm run ventas:historico` para historial/reconstrucción, `npm run ventas:sincronizar` para una pasada y `npm run test:ventas` para comprobar las reglas. Variables y comandos completos en el [README](../README.md).
- **Datos de desarrollo:** las compras sintéticas conservadas por las pruebas flash forman parte de ese historial. Deben presentarse como datos de prueba.

## 5. Riesgos y dependencias

- **MySQL sigue siendo autoridad:** hay que aplicar la migración de outbox y capturar el evento dentro de ambos checkouts; escribir después del commit sin una cola durable dejaría huecos si el proceso cae.
- **La oferta de inventario limitado (§4.2) es el ítem de mayor riesgo de diseño** — dos guardas (Redis + MySQL) que tienen que coordinarse sin desincronizarse ni bloquearse mutuamente. Vale prototipar y validar la concurrencia simulada temprano, no dejarlo para el final.
- **Entrega eventual:** un ciclo de 30 s no es un SLA; fallos, cola pendiente y reintentos pueden aumentar la demora. La disponibilidad de Cassandra debe verificarse y el panel debe hacer visible su estado.
- **Capacidad local:** MySQL, Mongo, Redis y Cassandra requieren recursos del entorno Docker. Un nodo de Cassandra sirve para desarrollo, no para afirmar alta disponibilidad.
- **Alcance de datos:** no hay cancelaciones ni reembolsos; futuros flujos exigirán eventos de ajuste. Un mínimo de unidades reduce ruido, pero promociones o faltantes de stock aún influyen en las ventas observadas.

---

## 6. Preguntas abiertas para el equipo

- ~~¿Carrito anónimo o solo con sesión iniciada?~~ — resuelto: requiere sesión (§4.1).
- ~~Valor de TTL por inactividad~~ — resuelto: 7.5 min / 450s (§4.1).
- ~~Cuántas unidades y qué producto(s) usar para demostrar la oferta flash~~ — resuelto: un producto real del catálogo, marcado con `oferta_flash` (§4.2). La cantidad es configurable por el vendedor/administrador; la verificación automática usa 5 unidades contra 15 intentos concurrentes.
- ~~Familia para el análisis~~ — resuelto: Cassandra y panel de ventas; reemplaza Neo4j (ADR-004).
- Alcance de reseñas y posible detección en grafos — aplazado; no bloquea esta entrega con la familia columnar seleccionada.
- Formato final del informe y evidencia esperada por el curso — pendiente de definir con el equipo.

---

## 7. Orden de trabajo sugerido

1. ~~Redis + migración del carrito (§4.1)~~ — ✅ hecho (2026-08-30).
2. ~~Oferta de inventario limitado (§4.2)~~ — ✅ hecho (2026-08-30).
3. Cassandra en Docker + migración de outbox y captura transaccional de ventas (§4.6).
4. Worker idempotente, carga histórica y API por particiones; panel React con filtros y comparación.
5. Verificación de reglas, integración, reintentos, permisos y visualización; registrar evidencia efectiva.
6. Redacción final: ADR-004, [diagrama de arquitectura](ERD-ARQUITECTURA-POLIGLOTA.md) e informe.

---

## 8. Rúbrica mapeada (checklist de avance)

| Criterio (PRD) | Peso | Estado |
|---|---|---|
| Carrito clave-valor + TTL justificado | 1.5 pts | ✅ Implementado y verificado (2026-08-30) — ver ESTADO-PROYECTO.md |
| Oferta de inventario limitado, atómica, bajo concurrencia | 3.0 pts | ✅ Implementado y verificado (2026-08-30) — ver ESTADO-PROYECTO.md §3.8 |
| Evaluación comparativa grafos vs. columnar | 1.5 pts | ✅ Actualizada en §3 y ADR-004; grafos aplazado con condiciones explícitas |
| Implementación columnar + reto específico (variación de demanda) | 3.0 pts | 🟡 Incorporación en curso — §4.6; falta registrar validación efectiva |
| Calidad del informe + diagrama de arquitectura actualizado | 1.0 pt | 🟡 Diagrama actualizado en ERD-ARQUITECTURA-POLIGLOTA.md; evidencia analítica y formato final del informe pendientes |
