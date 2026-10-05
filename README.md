# TiendaYa

Proyecto de curso — Bases de Datos 2. Portal de comercio electrónico construido de forma incremental sobre una arquitectura políglota de bases de datos. Contexto completo, alcance por entrega y rúbricas en [IA/PRD.md](IA/PRD.md); el modelo de datos de la Fase Inicial está documentado en [IA/ERD.md](IA/ERD.md) y las decisiones de stack en [IA/ADR-001-stack-y-migraciones.md](IA/ADR-001-stack-y-migraciones.md). Para un resumen de qué se construyó y en qué estado está el proyecto, ver [IA/ESTADO-PROYECTO.md](IA/ESTADO-PROYECTO.md).

## Estado actual: Entrega 2 — Redis, Cassandra (ventas) y Neo4j (fraude)

Backend en Node.js (JavaScript) + Express. MySQL (Prisma) para datos transaccionales — usuarios, direcciones, pedidos, pagos, inventario. MongoDB (Mongoose) para el catálogo descriptivo — categorías, atributos variables por producto, historial de cambios (ver [IA/ADR-002](IA/ADR-002-migracion-catalogo-documental.md)). Frontend en React (Vite) + Tailwind CSS. Los 6 requerimientos técnicos de Entrega 1 (PRD §5) están implementados y verificados — ver [IA/ENTREGA-1-TRAZABILIDAD.md](IA/ENTREGA-1-TRAZABILIDAD.md) para el detalle punto por punto con referencias al código, o [IA/ESTADO-PROYECTO.md](IA/ESTADO-PROYECTO.md) para el resumen general de qué está hecho y qué falta.

Entrega 2 incorpora Redis para carrito, ofertas y recomendaciones, **Cassandra** para el panel de ventas por intervalos y productos en ascenso, y **Neo4j** para detección de fraude (siete señales: reseñas coordinadas, gasto anómalo, categoría inusual, cuentas de una misma persona — mismo nombre o mismo buzón de correo —, ráfaga de gasto, autocompra y reventa de lo comprado). El PRD exige implementar al menos una familia entre grafos y columnar; el equipo terminó incorporando las dos, cada una con su propio propósito — Cassandra no reemplaza a Neo4j ni viceversa. Diseño, límites y evidencia de validación en [IA/ADR-004](IA/ADR-004-analitica-ventas-cassandra.md) (Cassandra) y [IA/PLAN-NEO4J-DETECCION-FRAUDE.md](IA/PLAN-NEO4J-DETECCION-FRAUDE.md) (Neo4j).

## Requisitos

- Node.js 20+
- Docker Desktop (para MySQL, MongoDB, Redis, Cassandra y Neo4j)

## Puesta en marcha

1. **Levantar MySQL, MongoDB, Redis, Cassandra y Neo4j en Docker** (desde la raíz del repo):

   ```bash
   docker compose up -d
   ```

   MongoDB corre como *replica set* de un solo nodo (se auto-inicializa) — lo necesitan las transacciones del historial de cambios, ver [IA/ADR-003](IA/ADR-003-historial-cambios-eventos.md). Redis conserva cachés del carrito/productos y contadores de ofertas. El carrito durable vive en MySQL; su caché se puede reconstruir. Redis sigue sin persistencia configurada: perder un contador flash puede reinicializar el cupo durante una oferta (ver la nota de límites abajo). Si Redis no arranca en Windows con un error de *permisos* de bind (no "puerto ocupado"), ver el comentario del servicio `redis` en `docker-compose.yml` — 6379 puede caer en un rango que Hyper-V/WSL2 reserva en esa máquina.

   Cassandra y Neo4j usan un nodo con volumen persistente para desarrollo: esta configuración no ofrece alta disponibilidad. Esperar a que los servicios estén listos antes de aplicar migraciones o sincronizar ventas/fraude.

2. **Instalar dependencias del backend**:

   ```bash
   cd backend
   npm install
   ```

3. **Configurar variables de entorno** (`.env` no se versiona):

   ```bash
   cp .env.example .env
   ```

   Los valores de `.env.example` corresponden a `docker-compose.yml`. Si ya existe `.env`, incorporar las variables nuevas sin reemplazar las credenciales y la configuración propia.

   | Variable | Uso |
   |---|---|
   | `CASSANDRA_CONTACT_POINTS` | Hosts de Cassandra; en desarrollo local, `localhost` |
   | `CASSANDRA_PORT` | Puerto CQL, `9042` |
   | `CASSANDRA_LOCAL_DATACENTER` | Datacenter configurado en Compose |
   | `CASSANDRA_KEYSPACE` | Keyspace de la copia analítica |
   | `VENTAS_OUTBOX_ENABLED` | Captura eventos de ventas dentro del checkout; `false` en la configuración temporal |
   | `VENTAS_SYNC_ENABLED` | Habilita el worker de ventas del backend; `false` en la configuración temporal |
   | `VENTAS_SYNC_INTERVAL_MS` | Intervalo del worker; `30000` ms por defecto |
   | `NEO4J_URI` | `bolt://localhost:7687` en desarrollo local |
   | `NEO4J_USER` | `neo4j` |
   | `NEO4J_PASSWORD` | Debe coincidir con `NEO4J_PASSWORD` (o el default `tiendaya_dev`) de `docker-compose.yml` |

4. **Aplicar el esquema**:

   - Aplicar las migraciones versionadas de `prisma/migrations/`, incluida la tabla de outbox, y generar el cliente Prisma (no crea migraciones nuevas ni necesita permisos de shadow database):
     ```bash
     npm run prisma:deploy
     npm run prisma:generate
     ```
   - Para seguir desarrollando el esquema y generar nuevas migraciones a partir de cambios en `schema.prisma`:
     ```bash
     npm run prisma:migrate
     ```
     (usa una *shadow database* temporal para calcular el diff — el usuario `tiendaya` ya tiene el permiso `CREATE, DROP` necesario, otorgado automáticamente al inicializar el contenedor por `docker/mysql-init/01-grant-shadow-db.sql`. Detalle del porqué en [ADR-001](IA/ADR-001-stack-y-migraciones.md#notas-de-implementación-2026-08-22).)

5. **Cargar datos de prueba representativos** (MySQL + Mongo, un solo paso — hasta el 2026-08-30 esto eran dos scripts separados, ver `IA/ADR-002` §3.4):

   ```bash
   npm run seed
   ```

6. **Levantar el servidor**:

   ```bash
   npm run dev
   ```

   Por defecto queda escuchando en `http://localhost:3000`. `GET /api/health` confirma que está arriba.

## Panel de ventas con Cassandra (Entrega 2)

La pantalla `/admin/ventas` y `GET /api/admin/ventas` requieren una cuenta con rol **administrador**. Muestran ingresos, unidades, evolución por día/semana/mes y productos con aumento reciente de unidades vendidas.

Se filtra por fechas inclusivas de Guatemala (UTC−6), intervalo y producto. Se permite un máximo de 90 días y se rechazan fechas futuras. El ranking usa un mínimo de 5 unidades recientes por defecto y compara con el período inmediatamente anterior de igual duración. Si no hubo ventas anteriores, el porcentaje es `null` y se muestra sin base de comparación. Si se incluye hoy, sus ventas todavía pueden estar incompletas.

Con `VENTAS_OUTBOX_ENABLED=true`, MySQL conserva la venta y registra su evento en `venta_outbox` dentro de la misma transacción del checkout. Con `VENTAS_SYNC_ENABLED=true`, un worker, cada 30 segundos por defecto, replica con reintentos a `ventas_por_dia` y `ventas_por_producto_mes`. Las claves incluyen `detalle_id`, por lo que reejecutar una inserción no duplica cantidades. Las descripciones vienen del catálogo actual de Mongo. Los importes y unidades consultados por el dashboard salen de Cassandra; su indisponibilidad se informa como error, sin sustituir la consulta financiera por MySQL.

**Pausa temporal para las pruebas de oferta flash:** `backend/.env.example` deja ambas variables en `false`. Aplicar esos valores también en `backend/.env` y reiniciar el backend. Esto omite las consultas SQL de captura en el checkout y detiene el worker; las compras, pagos e inventario siguen guardándose en MySQL. Los eventos pendientes y los datos existentes de Cassandra se conservan. El panel de ventas deja de incorporar compras nuevas mientras dure la pausa. Si Cassandra no se necesita, se puede detener únicamente su contenedor con `docker compose stop cassandra`.

Para reactivar, levantar Cassandra con `docker compose up -d cassandra`, poner ambas variables en `true`, reiniciar el backend y ejecutar `npm run ventas:historico` desde `backend/`. Este paso recupera las compras realizadas durante la pausa; activar solo el worker no crea los eventos omitidos. Si las variables no están definidas, el código conserva el comportamiento previo de captura y sincronización habilitadas.

Para incorporar compras anteriores o reconstruir la copia analítica, después de instalar dependencias, aplicar migraciones y tener las bases disponibles, desde `backend/`:

```bash
npm run ventas:historico
npm run ventas:sincronizar
```

El primer comando recorre el historial SQL de compras con pago aprobado y permite reenviarlo de forma idempotente. El segundo ejecuta una pasada de sincronización. El backend mantiene el worker periódico cuando `VENTAS_SYNC_ENABLED` está habilitado:

```bash
npm run test:ventas
npm run dev
```

`test:ventas` ejecuta pruebas aisladas, sin escribir en las bases reales. Las 17 comprobaciones pasaron; también se verificaron carga histórica, conciliación de totales MySQL/Cassandra y permisos HTTP. La evidencia y sus límites están en [IA/ADR-004 §9](IA/ADR-004-analitica-ventas-cassandra.md#9-validación-registrada--2026-09-05).

El panel comienza con los últimos siete días completos; para ver ventas de hoy, cambia **Hasta** a la fecha actual. La comparación se marca como provisional mientras el día está en curso. El mínimo de unidades afecta únicamente el ranking. Si la consulta supera 100,000 líneas entre ambos períodos, pide reducir el rango o seleccionar un producto; no presenta totales truncados.

**Semántica:** `compra_detalle` representa productos comprados por clientes, es decir, ventas del comercio. `compra.fecha` aporta el instante. Un pago aprobado confirma la venta aunque el detalle siga `pendiente`; se comprueba la existencia del pago para evitar multiplicar líneas por reintentos de cobro. `precio_final` ya es el total neto de la línea y `descuento` es el ahorro total: no se vuelve a descontar ni a multiplicar el importe por cantidad. No existen cancelaciones o reembolsos implementados; agregarlos requerirá eventos de ajuste.

Las compras sintéticas conservadas por `flash-sale-tests/` forman parte de la base de desarrollo y se incluirán al cargar su historial. Son datos de prueba, no actividad comercial real. Este panel es distinto de las recomendaciones personalizadas de `tendenciaService` y de la caché acumulada `Producto.total_vendido`.

## Detección de fraude con Neo4j (Entrega 2)

La pantalla `/admin/fraude` y `GET /api/admin/fraude` requieren rol **administrador**. Siete señales, ninguna una acusación por sí sola: **reseñas coordinadas** (cuentas distintas reseñando los mismos productos, calificación alta, ventana de tiempo corta); **gasto anómalo** (un pedido muy por encima de lo que esa misma cuenta gastó antes, como un banco vigila a sus clientes); **categoría inusual** (la primera compra en una categoría ajena, tras un historial largo); **cuentas de una misma persona** (varias cuentas que se llaman igual o usan el mismo buzón de correo — sin contar alias `+` ni los puntos de Gmail —, todas comprando; compartir buzón pesa más que compartir nombre, y el grafo guarda solo un hash del buzón, nunca el correo); **ráfaga de gasto** (muchos pedidos o mucho gasto en un solo día, aunque cada pedido parezca normal) **autocompra** (una cuenta que le compra a sí misma o a otra de su misma persona) y **reventa de lo comprado** (un vendedor que le compró un producto a otro vendedor y hoy tiene publicado y activo uno equivalente). Una señal corroborada por otra sube a confianza alta; nunca baja. Diseño completo, incluidas las correcciones reales al modelo encontradas al implementar, en [IA/PLAN-NEO4J-DETECCION-FRAUDE.md](IA/PLAN-NEO4J-DETECCION-FRAUDE.md).

**Nadie compra lo que vende:** el sistema rechaza con `403` que un vendedor compre sus propios productos, en todos los caminos (checkout, carrito, oferta flash y recomendaciones), y el frontend oculta los botones de compra de un producto propio. La autocompra entre dos cuentas distintas de una misma persona sigue siendo justo lo que detectan las señales de arriba.

**Compromiso de no reventa:** una cuenta que puede vender (rol `vendedor` o `administrador`) sí puede comprar productos de otros vendedores, pero no revenderlos. Antes de pagar — en el carrito, en la oferta flash y en las recomendaciones — ve un aviso con una casilla que tiene que marcar ("me comprometo a no revender lo que compro"; revenderlo incumple los Términos de Servicio de TiendaYa). El servidor lo exige (`400` con `codigo: COMPROMISO_NO_REVENTA` si falta) y deja la constancia en el pedido (`compra.no_reventa_aceptada_en`, visible en su detalle). Los compradores no ven el aviso. La señal de **reventa** cita esa constancia. Los Términos de Servicio están en la página pública [`/terminos`](frontend/src/pages/TerminosPage.jsx): el aviso los enlaza en una pestaña nueva (para no sacar al comprador del pedido), directo a la sección de no reventa (`/terminos#no-reventa`), y también los enlazan el detalle del pedido y el pie de página.

Compras, reseñas y productos publicados se reenvían a Neo4j de mejor esfuerzo (no outbox durable como Cassandra — una señal de fraude tarde de más no tiene el mismo costo que una venta perdida) al confirmarse en `checkout()`/`checkoutOferta()`/`resenaService.crear()` y al crear o editar un producto (`productoService`). Para incorporar datos anteriores a que ese reenvío existiera:

```bash
npm run fraude:backfill
```

Recorre todos los productos publicados, `compra_detalle` (con pago aprobado) y la colección `resenas`, reenviando con las mismas funciones que usa el camino en vivo — seguro de correr de nuevo, no duplica.

```bash
npm run verificar:fraude
```

Siembra un patrón sintético de cada señal (documentado como tal, no se presenta como hallazgo orgánico) corriendo checkout, creación de reseñas y alta de productos **reales**, no escrituras directas a Neo4j, y confirma que las siete consultas las encuentran (y que los controles negativos no). Es idempotente: re-correrlo no acumula compras ni cuentas. Los vendedores y productos de prueba que crea son sintéticos y quedan inactivos, con una excepción a propósito: la publicación del revendedor (`[PRUEBA fraude] Reloj de pared reventa`, 2 unidades) queda **activa**, porque la señal de reventa solo ve lo que "se vende hoy" y así el caso se puede ver en `/admin/fraude` (pausarla lo hace desaparecer). La única excepción a "compras reales" es la autocompra de una misma cuenta: como `checkout()` ya la rechaza, el script comprueba el rechazo y siembra un pedido histórico directo en MySQL.

```bash
npm run verificar:compraPropia
```

Prueba que cada camino de compra (checkout simple y mixto, carrito, oferta flash y recomendación) rechaza con `403` el producto propio de un vendedor y que el rechazo no deja rastro — ni pedido, ni stock descontado, ni cupo gastado en Redis. Solo hay rechazos, así que se puede correr las veces que se quiera.

```bash
npm run verificar:compromisoReventa
```

Prueba la matriz de roles contra MySQL (un comprador no tiene que aceptar nada; un vendedor y un administrador sí; solo el booleano `true` cuenta) y que cada camino de compra (checkout, oferta flash y recomendación) rechaza con `400 COMPROMISO_NO_REVENTA` a una cuenta que puede vender y no aceptó, sin dejar pedido ni gastar cupo en Redis. Solo hay rechazos, así que se puede correr las veces que se quiera; que la aceptación queda guardada en el pedido lo prueba `verificar:fraude`. Pruebas aisladas: `npm run test:compromiso`.

## Verificar el checkout transaccional

El requerimiento central de la Fase Inicial es el checkout como transacción atómica (pedido + líneas + pago + descuento de inventario). Con el servidor detenido (para no competir por las mismas filas) o corriendo, desde `backend/`:

```bash
npm run verificar:checkout
```

El script corre un checkout válido y luego uno que pide más unidades de las que hay en stock, confirmando que este segundo caso se rechaza por completo **sin** dejar el inventario parcialmente descontado.

## Verificar el carrito en Redis (Entrega 2)

```bash
npm run verificar:carrito
```

Usa una cuenta y un producto exclusivos, identificados como sintéticos (`carrito.test@example.com`, contraseña de desarrollo `Password123!`). Verifica persistencia SQL, copia propia del producto en Redis sin inventario, recuperación tras una expiración real, lectura caliente sin SQL/Mongo, revisión con datos actuales, rechazo de precio desfasado al pagar, agregados simultáneos, clamp, cantidad cero y vaciado del checkout. También prueba 15 compras flash sobre un cupo de 5 con la caché caliente. Crea y conserva pedidos sintéticos; no modifica el historial de Ana. Ejecutar una corrida a la vez. Detalle en [IA/ENTREGA-2-PLAN.md §4.1](IA/ENTREGA-2-PLAN.md).

### Cambios de carrito y caché — 2026-10-03

- **Persistencia:** MySQL conserva `carrito`, único por `(id_usuario, id_producto)` con sus FK existentes. Agregar, cambiar cantidades, quitar y vaciar se guardan primero en SQL. Las escrituras del mismo usuario se serializan mediante un bloqueo de fila. El carrito durable no tiene TTL.
- **Copia propia en Redis:** `carrito:{usuarioId}` es un hash `productoId → JSON {producto: {id, descripcion, imagen_url, estado, precio}, cantidad, disponible}`. Cada carrito contiene su información; no existe un resumen compartido. No incluye cantidad de inventario: `cantidad` es lo que pide el usuario y `disponible` es el resultado de la última revisión. La marca `_formato=3` distingue el formato anterior y permite cachear un carrito vacío. TTL de **450s por inactividad**, renovado al leer.
- **Lectura rápida:** con el hash vigente, `GET /api/carrito` usa únicamente Redis, incluso para calcular el total. **No consulta MySQL ni Mongo al abrirlo.** Si falta/venció el hash o tiene un formato anterior, recupera cantidades SQL, descripción/imagen/estado Mongo e inventario SQL por lote. Redis caído permite recuperar desde las bases, con mayor latencia. Las mutaciones SQL invalidan y reconstruyen la copia propia.
- **Actualización al entrar al checkout:** `POST /api/carrito/revisar` recupera las cantidades persistidas, consulta productos e inventarios por lote y reemplaza las copias de ese usuario en Redis. Muestra descripción, imagen y precio vigentes, sin historial ni comparaciones de precios. El stock solo se usa para decidir disponibilidad; no se copia su cantidad al carrito. Si un producto desaparece o no alcanza el stock, se conserva el artículo y se bloquea la confirmación. El carrito no reserva stock ni bloquea el acceso al checkout por una disponibilidad cacheada.
- **Edición de producto:** los carritos existentes conservan su copia hasta el checkout, una mutación o una reconstrucción tras TTL. No se recorren los carritos de otros usuarios. Si el producto tiene oferta flash, la edición invalida los datos propios de esa oferta (sube su revisión y los borra): la siguiente lectura los regenera con lo vigente.
- **Confirmación:** el frontend envía `precioEsperado`; Mongo comprueba productos activos y MySQL valida precio/stock. Un precio distinto o stock insuficiente produce **409**, sin pedido/pago ni borrado del carrito. El frontend vuelve a revisar y presenta únicamente los datos vigentes para intentar confirmar otra vez. El precio enviado nunca determina lo cobrado. Clientes antiguos que omitan ese campo pagan el precio SQL vigente. Pedido, pago, descuento condicionado de inventario y borrado del carrito SQL se confirman juntos; Redis se invalida inmediatamente después del commit.
- **Concurrencia de caché:** `carrito:{usuarioId}:revision` es un contador de control sin TTL. Toda invalidación lo incrementa y borra el hash de forma atómica. Lua solo publica una lectura si esa revisión no cambió; si hubo una mutación/checkout concurrente, vuelve a leer. Así una lectura lenta no vuelve a publicar cantidades anteriores en condiciones normales. La revisión se conserva aunque venza el hash para no reutilizar una revisión mientras haya consultas pendientes.
- **Flash con la estructura del carrito (2026-10-04):** `oferta:{productoId}:datos` es un **hash** con `_formato=1` y **todos** los datos del producto y de su oferta, un campo cada uno: id, descripción, estado, imagen principal e imágenes, atributos, subcategoría, vendedor, precio normal, resumen de reseñas, versión, configuración promocional (precio, cupo inicial y fechas), `generado_en` y `vence_en`. Lo único que no copia es la cantidad real de inventario (cambia con cada venta; su autoridad es MySQL y el cupo en vivo es otra clave). Solo existe mientras la oferta está **activa** (producto activo, oferta activada y sin vencer): sin oferta, pausada o vencida se lee directo de Mongo y no ocupa Redis. TTL **450s por inactividad**, renovado en cada lectura y **sin pasar nunca del fin de la oferta**; además, la copia no se sirve con más de **600 s** de edad aunque se siga leyendo (se regenera). `GET /api/ofertas/:id/stock` devuelve estos datos y el remanente; el checkout flash ya no necesita consultar el catálogo para mostrar el producto (imagen, vendedor y atributos incluidos). Dirección y método de pago siguen consultándose en SQL.
- **Cómo se detecta que la clave de la oferta hay que regenerarla** (el mismo método del carrito): una sola lectura atómica en Lua (`leerOferta`) trae la revisión y todos los campos del hash y de paso renueva el TTL. Con eso se regenera si **(a)** el hash no existe — venció el TTL, Redis lo desalojó o alguien lo invalidó —, **(b)** su `_formato` no es el vigente (una clave del formato anterior, que era una cadena JSON, el script la descarta en vez de fallar), **(c)** un campo no se puede leer (JSON dañado), falta alguno o el `id` es de otro producto, o **(d)** la copia es **demasiado vieja**: se generó hace más de 600 s aunque se siga leyendo — la red de seguridad de una invalidación perdida (Redis inalcanzable justo cuando alguien editó): como cada lectura renueva el TTL, sin este tope una oferta muy consultada conservaría datos viejos hasta su fin, y el precio de oferta que se cobra sale de esta copia (a diferencia del carrito, la copia de una oferta la lee todo el mundo). Regenerar es leer Mongo, armar el hash completo y publicarlo con `publicarOferta`, que **solo escribe si la revisión sigue siendo la que se leyó antes de regenerar**: cada edición del producto o de la oferta incrementa `oferta:{id}:revision` (sin TTL, como la del carrito) y borra el hash, así que una regeneración lenta que empezó antes de una edición no puede resucitar datos viejos — falla, vuelve a leer, hasta 3 intentos. Los escritores **solo invalidan, nunca publican** (regeneración perezosa), y son todos los que cambian algo de lo copiado: editar el producto, configurar o pausar la oferta, crear una reseña (cambia el resumen) y `POST /api/admin/recalcular-inventario` (cambia el precio normal; solo invalida las ofertas activas, las únicas que tienen copia). **Regenerar solo toca `datos`: el contador del cupo nunca se reinicia.**
- **Cupo flash:** `oferta:{productoId}:stock` es un contador independiente, con Lua atómico y TTL hasta el fin de la oferta. Actualizar/vencer los datos descriptivos no repone cupo; configurar una oferta activa mantiene el reinicio explícito que ya existía. La pantalla flash envía también `precioEsperado`: si cambió la promoción, se rechaza antes de gastar cupo y se muestran los datos actuales. Las compras admitidas se confirman en MySQL; si fallan, la devolución solo opera si el contador todavía existe.

**Actualizar una instalación anterior:** detener el backend, instalar dependencias y ejecutar desde `backend/` `npm run prisma:deploy`, `npm run prisma:generate` y **`npm run carrito:migrar` antes del primer arranque persistente**. Este último copia hashes históricos `productoId → cantidad` que todavía existan a SQL, sin duplicar ni sobrescribir filas. Los hashes de las versiones persistentes anteriores ya tienen respaldo SQL y se convierten al formato 3 al leer. Las antiguas claves de resumen dejan de usarse y vencen con su TTL; no se requiere borrarlas en masa. Los carritos cuyo TTL venció antes de tener persistencia no se pueden recuperar.

**Límites:** no hay transacción distribuida entre SQL, Mongo y Redis. La información de un carrito activo puede quedar desactualizada hasta entrar al checkout, porque las lecturas renuevan su TTL. La revisión no reserva inventario: se comprueba de nuevo al confirmar. Un fallo al invalidar los datos de una oferta puede conservar los previos, como máximo, 10 minutos (el tope de edad: pasado ese tiempo la lectura los descarta y regenera aunque se siga leyendo y se siga renovando el TTL), o hasta que pasen 450s sin lecturas o llegue el fin de la oferta, lo que ocurra primero; un fallo de invalidación del carrito puede conservar la copia anterior mientras se siga leyendo, hasta 450s de inactividad. Las revisiones protegen publicaciones concurrentes, pero no son durables ante pérdida total de Redis. Perder el contador flash puede volver a conceder cupo promocional, aunque SQL limite inventario real. No se midió un benchmark de latencia ni se inspeccionó visualmente el navegador en esta revisión.

Pruebas aisladas: `npm run test:redis` cubre lectura solo Redis, copias independientes sin inventario, revisión por lote, TTL, recuperación, carrito vacío, formato anterior, rechazo de precios/productos inactivos, publicaciones concurrentes, la regla de producto propio y el compromiso de no reventa en el carrito, el checkout y la oferta flash, y los datos de la oferta flash (hash con todos los datos, TTL deslizante con tope en el fin de la oferta, regeneración por expiración/formato/daño/campo ausente/otro producto/copia demasiado vieja, invalidación por edición, por una reseña nueva y por la reconciliación del inventario, carrera contra una edición y Redis caído); **30 pruebas aprobadas**. `npm run test:compromiso`: **5 aprobadas**. `npm run test:ventas`: **19 aprobadas**, incluidos ambos checkouts. `npm run verificar:ofertaCache` prueba esos mismos escenarios contra un **Redis real** (el Lua de verdad, con un producto sintético): estructura del hash, TTL deslizante y su tope, las seis señales de regeneración (incluidas una clave del formato anterior y una copia más vieja que su vida máxima), revisión, rechazo de una publicación con revisión vieja, 20 lecturas simultáneas en frío y que el cupo no se toca. `npm run verificar:carrito` comprueba esos flujos en MySQL/Mongo/Redis con datos sintéticos exclusivos: GET caliente, revisión y ráfaga flash atraviesan HTTP/Express y autenticación JWT.

**Evidencia de esta revisión, 2026-10-03:** integración real aprobada con lecturas SQL del carrito/inventario y Mongo deshabilitadas durante el GET caliente. Se comprobó recuperación tras TTL efectivo, revisión por HTTP con precio SQL vigente, rechazo de precio desfasado, mutaciones concurrentes, vaciado al confirmar y 5 ganadores de 15 intentos flash por HTTP (contador 0, inventario sintético 14). El precio flash desfasado devolvió 409 sin inicializar el contador, y pausar conservó el cupo gastado. Se conservaron los pedidos sintéticos. Build del frontend aprobado; lint sin errores y con advertencias de React existentes. Sin comprobación visual ni benchmark.

## Verificar la caché de la oferta flash contra un Redis real (Entrega 2)

```bash
npm run verificar:ofertaCache
```

Con un producto sintético (no toca la oferta real del producto #1) comprueba que los datos de una oferta activa se guardan como un hash con la estructura del carrito, que cada lectura renueva su TTL sin pasar del fin de la oferta, y que se **regeneran solos** — desde Mongo, sin reiniciar el contador del cupo — cuando la clave venció, tiene otro formato, un campo dañado o ausente, es de otro producto o es una cadena del formato anterior; que una edición sube la revisión, que publicar con una revisión vieja se rechaza y que 20 lecturas simultáneas en frío convergen en un hash válido; que reconciliar el inventario (la reconciliación real del administrador) invalida la copia de una oferta activa; y que una oferta pausada, vencida o de un producto inactivo no ocupa Redis. Deja el producto pausado y sin claves al terminar.

## Verificar la oferta flash bajo concurrencia (Entrega 2)

```bash
npm run verificar:ofertaFlash
```

Siembra una oferta de 5 unidades sobre un producto real y dispara 15 intentos de compra simultáneos, confirmando que gane exactamente el stock inicial (5), el resto se rechace, el contador en Redis termine en exactamente 0, y el inventario real en MySQL se descuente en la misma cantidad — sin sobreventa ni bloqueos a nivel de aplicación (un único script Lua atómico en Redis, ver `backend/src/config/redis.js`). Detalle completo en [IA/ENTREGA-2-PLAN.md §4.2](IA/ENTREGA-2-PLAN.md).

### Prueba reutilizable contra el endpoint HTTP real

Además de la verificación interna anterior, `flash-sale-tests/` prueba el endpoint `POST /api/ofertas/:productoId/comprar` atravesando Express, autenticación JWT, Redis, MySQL y Mongo. Usa 100 compradores sintéticos distintos, con un intento de una unidad por comprador; no llama directamente a los servicios ni usa la cuenta de Ana.

**Requisitos:** Node.js 20 o posterior, backend en `http://localhost:3000`, MySQL/MongoDB/Redis normales del proyecto levantados, migraciones aplicadas y la cuenta vendedora `luis.ramirez@example.com` creada por el seed.

La preparación y la ejecución están separadas. Desde la raíz del repositorio, primero se crean o verifican los usuarios y el producto sintético, se restaura el inventario a 100 y se reinicia el cupo de 20 unidades:

```powershell
node .\flash-sale-tests\prepare.js
```

Después se ejecuta la única prueba combinada: 20 compradores tienen el mismo instante de salida (retraso cero) y los otros 80 se incorporan en grupos de 10 con retrasos de 100, 250, 400, 600, 900, 1,200, 1,600 y 2,000 milisegundos respecto de ese instante. Las solicitudes se lanzan concurrentemente; el reporte registra el instante real de cada envío, que puede variar por la planificación del proceso y la red:

```powershell
node .\flash-sale-tests\run.js
```

`prepare.js` registra las cuentas que todavía no existan entre `flash.test.01@example.com` y `flash.test.100@example.com`, y crea una dirección y un método de pago sintéticos para cada una. También busca por descripción exacta un producto exclusivo de prueba; si no existe, crea mediante la API su categoría, subcategoría y producto usando la cuenta de Luis. No modifica el inventario ni la oferta de los productos reales del catálogo.

`run.js` comprueba que exista una preparación vigente, inicia sesión con las cuentas ya preparadas y lanza las solicitudes. **APROBADO significa ausencia de sobreventa y consistencia de inventario**, sin exigir agotar las 20 unidades de oferta ni recibir una cantidad fija de respuestas HTTP 201. Por ejemplo, 14 unidades compradas, inventario MySQL de 86 y remanente Redis de 6 aprueban aunque alguna compra haya respondido fuera de tiempo. Los timeouts, errores HTTP, disponibilidad y latencias se informan como diagnóstico y no deciden el veredicto.

El ejecutor guarda los IDs de los detalles de compra existentes antes de la ráfaga y consulta los nuevos pedidos y pagos en MySQL al finalizar. Así cuenta las compras persistidas aunque el cliente no haya recibido HTTP 201, y excluye el historial conservado. Verifica que las unidades flash no superen el cupo, que no se venda más que el inventario inicial, que el descuento de MySQL coincida con las unidades guardadas y que Redis refleje el cupo restante. También comprueba que las respuestas HTTP 201 tengan su compra persistida y que los pedidos observados tengan pago aprobado.

La sección `reconciliation` del escenario configura una ventana de hasta 30 segundos después de las respuestas HTTP, con lecturas cada 500 ms, estabilidad de al menos 2 segundos y límite de 5 segundos por lectura. Puede terminar antes cuando todas las solicitudes sin respuesta tengan una compra correspondiente y las lecturas estén estables. Si un timeout no tiene compra registrada, observa toda la ventana: **un timeout no cancela automáticamente la compra en el servidor**. El reporte indica «sin compra observada», sin afirmar una cancelación. Este veredicto cubre la ventana observada; si el servidor puede confirmar operaciones todavía más tarde, hay que ampliar `timeoutMs`. No poder leer o estabilizar las bases impide aprobar. Los valores de `thresholds` solo generan diagnósticos de rendimiento.

Una preparación se consume al iniciar la ráfaga. Para repetir la prueba o restaurar el inventario del producto a 100 unidades, hay que ejecutar nuevamente `prepare.js`; intentar correr `run.js` dos veces seguidas se rechaza con un mensaje claro. Ejecutar una corrida a la vez sobre este producto sintético.

La prueba sí crea pedidos y pagos reales para las cuentas sintéticas ganadoras. Esos pedidos se conservan entre ejecuciones, pero no afectan la validación: cada reporte compara las compras nuevas y el inventario anterior a su propia ráfaga con el estado conciliado. El historial de compras de Ana no se modifica.

Cada corrida crea una carpeta ignorada por Git bajo `flash-sale-tests/results/` con:

- `attempts.jsonl`: usuario sintético, instante programado y real, desviación de planificación, status, cuerpo y latencia de cada solicitud.
- `probes.json`: disponibilidad de `/api/health` y del stock de la oferta mientras ocurre la ráfaga.
- `reconciliation.json`: lecturas de conciliación, compras persistidas, asociación con solicitudes sin respuesta y errores de lectura.
- `summary.json`: conteos HTTP y de compras persistidas por separado, percentiles, inventario MySQL, remanente Redis, `invariants` que deciden el resultado y `diagnostics` informativos.

El comando termina con código de salida `0` si aprueba la conciliación de inventario y ausencia de sobreventa; usa `1` si detecta sobreventa, inconsistencias o no puede verificar el resultado. Los timeouts y errores de las solicitudes no provocan por sí solos una reprobación. La consola conserva el total de requests, HTTP 201, rechazos por agotamiento, errores inesperados, timeouts, latencias y sondas, y agrega las compras confirmadas en MySQL y las confirmadas sin HTTP 201.

Para verificar la lógica del veredicto y la conciliación sin escribir en las bases: `node --test flash-sale-tests/reconcile.test.js`. `flash-sale-tests/users.example.json` contiene exclusivamente credenciales y métodos de pago sintéticos de desarrollo; no se deben colocar cuentas reales en ese archivo.

## Verificar las recomendaciones por tendencia (Entrega 2)

```bash
npm run verificar:recomendaciones
```

Analiza el historial de compras real de un usuario de prueba, confirma que encuentra un producto de OTRO vendedor con atributos similares a un precio menor, y dispara 7 intentos de compra simultáneos sobre un cupo personal de 2 unidades (mismo script Lua que la oferta flash, ahora con una clave por producto+usuario en vez de una clave global) — exactamente 2 admitidos, contador en Redis en 0, inventario real descontado en 2. Detalle completo en [IA/ENTREGA-2-PLAN.md §4.5](IA/ENTREGA-2-PLAN.md).

También se puede probar vía HTTP. El checkout requiere estar autenticado — el usuario y sus direcciones/métodos de pago se resuelven del token, nunca de lo que mande el cliente en el body.

Los ejemplos de este README extraen campos de las respuestas JSON con una función `campo()` basada en Node (no en `jq`, que no viene instalado por defecto en Windows/Git Bash). Node ya es un requisito del proyecto, así que no agrega nada nuevo — definila una vez por sesión de terminal:

```bash
campo() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d)['$1'])}catch(e){console.log('')}})"; }
```

```bash
# 1. Login (el usuario de ejemplo lo crea el seed)
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"correo":"ana.gomez@example.com","contrasena":"Password123!"}' | campo token)

# 2. Listar sus direcciones y métodos de pago para obtener los IDs
curl -s http://localhost:3000/api/direcciones -H "Authorization: Bearer $TOKEN"
curl -s http://localhost:3000/api/metodos-pago -H "Authorization: Bearer $TOKEN"

# 3. Checkout usando esos IDs (deben pertenecer al usuario del token, si no se rechaza)
curl -X POST http://localhost:3000/api/checkout \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"direccionId":1,"metodoPagoId":1,"items":[{"productoId":1,"cantidad":2}]}'

# 4. Ver el historial de pedidos propio (nunca el de otro usuario, aunque se adivine el ID)
curl -s http://localhost:3000/api/compras -H "Authorization: Bearer $TOKEN"
curl -s http://localhost:3000/api/compras/1 -H "Authorization: Bearer $TOKEN"
```

(Los IDs asumen una base recién sembrada — ajustar según lo que devuelvan los listados. Si preferís `jq`, `-r .token` funciona igual de bien.)

## Catálogo

`GET /api/categorias` y `GET /api/productos` son públicos (no requieren token). Crear o editar catálogo requiere estar autenticado **y** tener rol `vendedor` o `administrador` — un `comprador` recibe `403`. La lista completa de endpoints (con cuáles requieren token/rol) está en `GET /` del servidor corriendo.

Cada producto le pertenece a un vendedor (`producto.id_vendedor`). Un `vendedor` solo puede editar sus propios productos (`403` si intenta tocar uno ajeno); un `administrador` puede editar cualquiera. No hay endpoint público para crear cuentas `vendedor`/`administrador` — el auto-registro siempre asigna `comprador` (ver [ADR-001](IA/ADR-001-stack-y-migraciones.md)); esas cuentas se crean a mano/por seed por ahora.

`?q=` busca por texto solo en `descripcion` (contains, sin acentos/typos) — para eso está `?atributos=` aparte: filtrado facetado exacto sobre los valores de atributo (`{"RAM":"16GB","Color":"Negro"}`, todos exigidos a la vez). Ninguno de los dos es el buscador de texto libre con tolerancia ortográfica que pide el PRD para Entrega 3 (Elasticsearch) — son cosas distintas que conviene no confundir.

**Pantallas de vendedor** (`frontend/src/pages/seller/`): con sesión `vendedor`/`administrador` aparece "Mi tienda" en el header → `/vendedor` lista solo los productos propios. El formulario de alta (`/vendedor/productos/nuevo`) deja crear categoría → subcategoría → atributo en el momento si no existen todavía (sin salir del formulario), con los inputs de valor de atributo generados dinámicamente según la subcategoría elegida. Al editar (`/vendedor/productos/:id/editar`) la categoría/subcategoría quedan fijas — recategorizar no está soportado, hay que publicar un producto nuevo — pero descripción, imagen, estado, precio, stock y valores de atributo sí se pueden corregir.

**Panel de administrador** (`frontend/src/pages/admin/`): con sesión `administrador` aparece "Panel admin" en el header → `/admin` lista el catálogo completo de **todos** los vendedores (filtro por categoría + búsqueda), con acceso de edición a cualquier producto — reutiliza el mismo formulario del panel de vendedor. También muestra "Productos más editados" (agregación sobre el historial de eventos, ver ADR-003 §3.4). El botón "Sincronizar con MongoDB" que existía acá se quitó el 2026-08-30 junto con las tablas relacionales que sincronizaba — ver [ADR-002 §3.4](IA/ADR-002-migracion-catalogo-documental.md#34-actualización-2026-08-30-se-borra-el-catálogo-relacional-vestigial).

Los ids de categoría/subcategoría son ObjectId de Mongo (strings), no enteros — hay que usar el que devuelva cada `POST`, no un valor fijo:

```bash
VTOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"correo":"luis.ramirez@example.com","contrasena":"Password123!"}' | campo token)

# categoría -> subcategoría -> atributo (define qué atributos aplican a esa subcategoría)
CAT_ID=$(curl -s -X POST http://localhost:3000/api/categorias -H "Authorization: Bearer $VTOKEN" -H "Content-Type: application/json" -d '{"categoria":"Hogar"}' | campo id)
SUB_ID=$(curl -s -X POST http://localhost:3000/api/categorias/$CAT_ID/subcategorias -H "Authorization: Bearer $VTOKEN" -H "Content-Type: application/json" -d '{"subcategoria":"Cocina"}' | campo id)
curl -s -X POST http://localhost:3000/api/categorias/subcategorias/$SUB_ID/atributos -H "Authorization: Bearer $VTOKEN" -H "Content-Type: application/json" -d '{"atributo":"Material"}'

# producto con inventario y valor concreto del atributo (por nombre, no por id)
curl -s -X POST http://localhost:3000/api/productos -H "Authorization: Bearer $VTOKEN" -H "Content-Type: application/json" \
  -d "{\"descripcion\":\"Sartén 26cm\",\"subcategoriaId\":\"$SUB_ID\",\"precio\":249.5,\"cantidad\":20,\"atributos\":[{\"nombre\":\"Material\",\"valor\":\"Aluminio\"}]}"

# navegar el catálogo (sin token)
curl -s "http://localhost:3000/api/productos?subcategoriaId=$SUB_ID"
curl -s http://localhost:3000/api/productos/1

# filtrar por atributo (facetado, no texto libre) — ?atributos= es un JSON
# { nombre: valor }, todos exigidos a la vez (AND)
curl -s -G "http://localhost:3000/api/productos" --data-urlencode "atributos={\"Material\":\"Aluminio\"}"

# rango de precio (filtro directo en Mongo, ver ADR-002 §3.3 — precio/cantidad
# son una copia de lectura ahí, MySQL/inventario sigue siendo la fuente
# transaccional) + orden por más vendidos (total_vendido, caché en Mongo,
# se actualiza al confirmarse una compra)
curl -s "http://localhost:3000/api/productos?precioMin=0&precioMax=100&ordenarPor=masVendidos"
```

Si `total_vendido` o `precio`/`cantidad` alguna vez se desincronizan de la realidad, `POST /api/admin/recalcular-ventas` (recalcula `total_vendido` sumando `compra_detalle` en MySQL) y `POST /api/admin/recalcular-inventario` (recalcula `precio`/`cantidad` desde `inventario` en MySQL) los reconcilian desde cero, sobrescribiendo lo que ya hay.

## Historial de cambios (Entrega 1)

Cada alta/edición de un producto agrega un evento en vez de sobrescribir — descripción, estado, atributos, imágenes, **y precio/cantidad** (cacheados desde MySQL en el momento del evento, ver [ADR-003](IA/ADR-003-historial-cambios-eventos.md#31-esquema)). Un edit de solo precio o solo stock también genera su propio evento; los descuentos de inventario del checkout, a propósito, no (eso seguiría siendo cada venta individual, no una edición de catálogo). Solo `vendedor`/`administrador` — requiere token:

```bash
VTOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"correo":"luis.ramirez@example.com","contrasena":"Password123!"}' | campo token)

# línea de tiempo completa
curl -s http://localhost:3000/api/productos/1/historial -H "Authorization: Bearer $VTOKEN"

# estado vigente en una fecha arbitraria (404 si el producto no existía todavía)
curl -s "http://localhost:3000/api/productos/1/historial?fecha=2026-08-01" -H "Authorization: Bearer $VTOKEN"
```

## Frontend

Storefront en React con el patrón de layout de Amazon (header oscuro con búsqueda, franja de categorías, grilla de productos) pero con una paleta propia basada en teoría del color: **azul** (confianza/calma — la elección estándar en apps financieras) como color principal, y **verde azulado** como acento para acciones positivas (agregar al carrito, confirmaciones) — a propósito distinto del naranja de Amazon, que comunica urgencia. Paleta completa y el porqué en `frontend/src/index.css`.

Al navegar dentro de una subcategoría (`HomePage.jsx`), aparece un sidebar de filtros por atributo (RAM, color, talla, lo que la subcategoría tenga definido) — estilo Amazon/Walmart, un checkbox por valor. Las opciones se calculan del lado del cliente a partir del catálogo completo de esa subcategoría (`calcularFacetas`), no de una llamada aparte; el filtrado en sí lo hace Mongo (`?atributos=`, ver sección Catálogo). Simplificación deliberada: las opciones no se recalculan a medida que se marcan casillas (no hay conteos tipo "128GB (3)" que se actualicen), a diferencia de un sitio real — suficiente para el tamaño de este catálogo.

El carrito persiste en MySQL y guarda su propia copia del producto sin cantidad de inventario en Redis; usa los endpoints autenticados de `/api/carrito`. `CartContext` carga la copia Redis al abrir el carrito. Al entrar al checkout se revisan los productos e inventarios por lote y se muestran los datos actuales; al confirmar se valida otra vez. La caché vence tras 450 segundos de inactividad; el carrito se recupera desde SQL y se vacía en la transacción del checkout confirmado. La versión inicial en `localStorage` quedó reemplazada en Entrega 2.

```bash
cd frontend
npm install
cp .env.example .env      # apunta a http://localhost:3000/api por defecto
npm run dev
```

Corre en `http://localhost:5173`. Necesita el backend (`npm run dev` desde `backend/`) y los servicios de Docker Compose disponibles en paralelo. El panel de ventas requiere además Cassandra y su historial sincronizado.

**Mi cuenta** (`/cuenta`, requiere sesión): listar, agregar y borrar direcciones y métodos de pago — los mismos formularios que aparecen embebidos en Checkout, ahora también accesibles fuera del flujo de compra. Borrar algo que ya se usó en un pedido se rechaza con un mensaje claro (`409 No se puede eliminar: ... tiene pedidos/pagos asociados`) en vez de un error de base de datos.

**Términos de Servicio** (`/terminos`, pública): las reglas para comprar, vender y opinar, con la versión y la fecha de actualización arriba. Describe lo que el sistema aplica o vigila de verdad — compra propia, compromiso de no reventa, reseñas solo de compradores y revisión de fraude con personas en el circuito — y no publica umbrales de las señales. Cada sección tiene su ancla (`/terminos#no-reventa`, `#resenas`…) y el texto vive en `frontend/src/pages/TerminosPage.jsx`: si cambia una regla en el backend, ahí se actualiza el texto y se sube `VERSION`.

Usuarios de prueba (creados por `npm run seed` del backend): `ana.gomez@example.com` (comprador) y `luis.ramirez@example.com` (vendedor), ambos con contraseña `Password123!`. No hay forma de crear una cuenta `vendedor`/`administrador` desde el registro público — es intencional, ver la sección Catálogo arriba.

## Estructura del repositorio

```
IA/                    Documentación de arquitectura (PRD, ERD, ADRs, estado del proyecto)
backend/
  prisma/
    schema.prisma       Esquema MySQL (usuarios, direcciones, pedidos, pagos, inventario — el catálogo vive en Mongo, ver ADR-002 §3.4)
    migrations/          DDL versionado, generado por Prisma Migrate
    seed.js               Datos de prueba representativos (MySQL + Mongo, un solo paso)
  scripts/
    verificarCheckout.js    Evidencia de atomicidad del checkout
    verificarCarrito.js      Evidencia del carrito en Redis (TTL, clamp, vaciado en checkout — Entrega 2)
    verificarOfertaFlash.js   Evidencia de la oferta flash bajo concurrencia (Entrega 2)
    verificarOfertaCache.js    Evidencia, contra un Redis real, de los datos de la oferta flash: hash con la estructura del carrito y regeneración (Entrega 2)
    verificarRecomendaciones.js  Evidencia de las recomendaciones por tendencia (Entrega 2)
    backfillNeo4j.js          Reenvía productos/compras/reseñas históricos a Neo4j (Entrega 2)
    verificarFraudeNeo4j.js   Evidencia de las siete señales de fraude, con datos sembrados (Entrega 2)
    verificarCompraPropia.js   Evidencia de que nadie compra lo que vende, en todos los caminos de compra
    verificarCompromisoReventa.js  Evidencia del compromiso de no reventa de las cuentas que pueden vender
    lib/datosPrueba.js        Cuentas, direcciones, métodos de pago y productos sintéticos compartidos por los scripts de verificación
  src/
    config/prisma.js      Cliente de Prisma (MySQL)
    config/mongo.js        Conexión de Mongoose (MongoDB)
    config/redis.js         Cliente de ioredis (Redis, Entrega 2 — incluye el script Lua compartido por la oferta flash y las recomendaciones)
    config/cassandra.js      Cliente de cassandra-driver (analítica de ventas, Entrega 2)
    config/neo4j.js           Cliente de neo4j-driver (detección de fraude, Entrega 2)
    models/mongo/           Esquemas de Mongoose (Categoria, Subcategoria, Producto, ProductoEvento, Resena)
    services/              Lógica de negocio (auth, checkout + checkoutOferta, compromiso de no reventa, catálogo, carrito, ofertas y su caché en Redis, recomendaciones, reseñas, historial, outbox y analítica de ventas, sincronización y consultas de fraude)
    routes/                 Endpoints Express (incluye adminRoutes.js — ventas y fraude —, ofertaRoutes.js, recomendacionRoutes.js)
    app.js / server.js
flash-sale-tests/
  prepare.js                Prepara usuarios, producto, inventario y oferta
  run.js                    Ejecutor HTTP parametrizado y verificador MySQL/Redis
  reconcile.js              Conciliación de compras tardías y criterios de integridad
  reconcile.test.js         Pruebas aisladas de sobreventa y conciliación
  users.example.json        Compradores sintéticos reutilizables
  scenarios/combined.json   Única ráfaga: simultáneos + grupos con retraso
  results/                  Reportes generados por corrida (ignorado por Git)
frontend/
  src/
    api/                   Cliente HTTP hacia el backend
    context/               Auth (token/sesión) y Cart (carrito en Redis, Entrega 2)
    components/            Layout (Header/Footer), tarjetas de producto, UI común
    components/account/     Formularios de dirección/método de pago (compartidos: Checkout y /cuenta)
    components/checkout/     Ventana del compromiso de no reventa, que piden las tres pantallas de compra a las cuentas que pueden vender
    pages/                 Una por ruta (catálogo, producto, carrito, checkout, pedidos, cuenta, oferta flash, recomendaciones, términos de servicio...)
    pages/seller/            Panel de vendedor (alta/edición de productos, incluida la oferta flash)
    pages/admin/             Panel de administrador (catálogo de todos los vendedores, ventas por intervalos, señales de fraude)
    index.css              Paleta de colores (tokens de Tailwind) y estilos base
docker/
  mysql-init/            Scripts que corren solo al inicializar el volumen de MySQL
docker-compose.yml     Contenedores de MySQL, MongoDB, Redis, Cassandra y Neo4j para desarrollo
```
