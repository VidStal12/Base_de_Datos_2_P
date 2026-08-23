# Estado del proyecto — TiendaYa

> Última actualización: 2026-08-23. Este documento resume qué se construyó, qué se decidió y qué falta, para que cualquiera (o una sesión futura) pueda retomar el proyecto sin releer todo el historial. El detalle técnico de cada decisión vive en [ERD.md](ERD.md) y [ADR-001-stack-y-migraciones.md](ADR-001-stack-y-migraciones.md); acá se resume y se enlaza.

---

## 1. Resumen ejecutivo

La **Fase Inicial** del PRD está completa y verificada de punta a punta: esquema relacional normalizado, ERD documentado, checkout como transacción atómica, DDL versionado y datos de prueba. Sobre esa base ya se construyó bastante más de lo mínimo: backend completo (auth, catálogo con atributos variables por categoría, pedidos) y un frontend funcional (tienda + panel de vendedor).

**No se empezó** la migración a MongoDB de Entrega 1 (el catálogo sigue 100% relacional) ni ninguna pieza de Entregas 2/3/Final. El plan acordado es: terminar el backend/frontend relacional → función de ETL hacia MongoDB después (ver §6).

---

## 2. Estado por entrega del PRD

| Entrega | Alcance | Estado |
|---|---|---|
| Fase Inicial | Esquema 3FN + ERD + checkout atómico + DDL versionado | ✅ Completo y verificado |
| — (extra, no pedido por el PRD todavía) | Auth completa, CRUD de catálogo, pedidos, panel de vendedor, panel de administrador, frontend | ✅ Completo (ver §3) |
| Entrega 1 | Migración de productos a base documental (MongoDB) + historial de cambios por eventos | 🟡 Los 6 requerimientos técnicos del PRD están implementados y verificados (5/6 puntos de la rúbrica, ver §3.5); solo falta "calidad del informe" (0.5 pt), que depende de confirmar el formato esperado, no de código. Reseñas/imágenes como feature son opcionales — el PRD solo exige la decisión embed/reference, ya documentada |
| Entrega 2 | Carrito en Redis + oferta de inventario limitado + grafos/columnar | ⬜ No iniciada (el carrito actual es solo de navegador, ver §5) |
| Entrega 3 | Motor de búsqueda + consistencia distribuida del checkout | ⬜ No iniciada |
| Entrega Final | Búsqueda vectorial + control de acceso NoSQL + retrospectiva | ⬜ No iniciada |

**Pendientes del PRD (§9) que siguen sin resolver:** nombres del equipo, enlace al repositorio, decisión preliminar grafos vs. columnar (Entrega 2), estrategia preliminar de consistencia distribuida, cronograma interno del equipo. Ninguno de estos se completó en esta sesión porque no dependen de código — hace falta que el equipo los defina.

---

## 3. Qué se construyó

### 3.1 Backend — núcleo de la Fase Inicial

- **Esquema relacional** (`backend/prisma/schema.prisma`): 15 entidades — usuarios, rol_usuario, direcciones, metodo_pago, categoria, subcategoria, producto, inventario, atributo_categoria, atributo_producto, categoria_producto, carrito, compra, pago, compra_detalle. Basado en la Página 1 del ERD original, confirmada como base (ver [ERD.md](ERD.md) §0).
- **4 migraciones versionadas** en `backend/prisma/migrations/`: esquema inicial, `id_vendedor` en producto, `cantidad` en compra_detalle, restricción unique en atributo_producto.
- **MySQL en Docker** (`docker-compose.yml` + `docker/mysql-init/`), con el grant de permisos que necesita Prisma Migrate para su shadow database.
- **`prisma/seed.js`**: datos de prueba representativos (roles, usuarios, categorías → subcategorías → atributos, productos con inventario y valores de atributo).
- **Checkout atómico** (`src/services/checkoutService.js`): pedido + líneas + pago + descuento de inventario en una única transacción de Prisma. Verificado con `npm run verificar:checkout` (compra válida + intento de sobreventa rechazado sin dejar el inventario a medio actualizar) y por HTTP real.

### 3.2 Backend — funcionalidad agregada sobre la base

| Área | Qué incluye |
|---|---|
| **Auth** (`authService.js`, `middleware/auth.js`) | Registro (valida formato de correo, contraseña ≥8 caracteres, siempre asigna rol `comprador`), login (JWT con rol incluido), `GET /api/auth/me`. Middlewares `requireAuth` y `requireRole`. |
| **Direcciones / métodos de pago** | CRUD propio del usuario autenticado. La tarjeta nunca se guarda completa — solo `token_pasarela` + últimos 4 dígitos + marca (ver ERD.md 1.4.2). |
| **Catálogo** (`categoriaService.js`, `productoService.js`) | Categoría → subcategoría → atributo (navegación pública, alta restringida a `vendedor`/`administrador`). Productos: listado con filtros (`categoriaId`, `subcategoriaId`, `q` de texto simple, `vendedorId`), detalle, alta y edición (un `vendedor` solo edita lo suyo, `administrador` edita cualquier producto). |
| **Checkout** | Valida que la dirección y el método de pago pertenezcan a quien paga, y que las cantidades sean enteros positivos (antes una cantidad negativa pasaba la validación de stock y *sumaba* inventario en vez de restarlo). |
| **Pedidos** (`compraService.js`) | Historial propio (`GET /api/compras`) y detalle (`GET /api/compras/:id`), nunca el de otro usuario. |

### 3.3 Frontend — tienda (`frontend/`)

React (JS) + Vite + React Router + Tailwind CSS v4. Layout inspirado en Amazon (header oscuro, buscador prominente, grilla de productos) con una paleta propia basada en teoría del color — azul para confianza/calma como color principal, verde azulado como acento de acción positiva, deliberadamente distinta del naranja de Amazon (que comunica urgencia). Paleta y justificación en `frontend/src/index.css`.

Páginas: catálogo con búsqueda/filtro por categoría (incluye un menú desplegable de categorías pegado a la barra de búsqueda), detalle de producto, carrito (vive en `localStorage`, no en el backend — ver §5), login/registro, checkout (selección o alta de dirección/método de pago), historial y detalle de pedidos. Responsive verificado en mobile/tablet/desktop sin desbordes horizontales.

### 3.4 Frontend — panel de vendedor (`frontend/src/pages/seller/`)

Visible solo para cuentas `vendedor`/`administrador` (link "Mi tienda" en el header). Dashboard con los productos propios; formulario de alta/edición que permite crear categoría → subcategoría → atributo sobre la marcha si todavía no existen, con los campos de valor de atributo generados dinámicamente según la subcategoría elegida. Al editar, la categoría queda fija (recategorizar no está soportado — hay que publicar un producto nuevo).

### 3.5 Entrega 1 — implementación (MongoDB)

Modelo dividido (ver [ADR-002 §3.2](ADR-002-migracion-catalogo-documental.md#32-actualización-2026-08-23-por-qué-preciocantidad-no-migran)): `categoria`, `subcategoria` y el contenido descriptivo de `producto` (descripción, estado, atributos, imágenes) viven en MongoDB; `precio`/`cantidad` se quedan en `inventario` (MySQL) sin tocar, para no romper la atomicidad del checkout.

- **MongoDB**: contenedor en `docker-compose.yml` como replica set de un nodo (`rs0`) — se auto-inicializa vía el healthcheck. Mongoose como ODM (misma naturaleza de decisión que Prisma vs. Sequelize).
- **ETL** (`backend/scripts/etlCatalogoAMongo.js`): migra `categoria`/`subcategoria`/`producto` a Mongo, reproducible (limpia las colecciones destino antes de escribir). Corrido y verificado contra los datos reales del proyecto.
- **`categoriaService.js` y `productoService.js`** reescritos contra Mongo, combinando con `inventario` (MySQL) en las lecturas. El contrato de API se mantuvo lo más parecido posible al anterior; lo que cambió de forma (atributos, ids de categoría, vendedor) obligó a actualizar `ProductDetailPage`, `SellerDashboardPage` y `SellerProductFormPage` en el frontend.
- **Historial de cambios por eventos** (`ProductoEvento`, ver [ADR-003](ADR-003-historial-cambios-eventos.md)): cada alta/edición descriptiva agrega un evento con snapshot completo, nunca sobrescribe. `GET /api/productos/:id/historial?fecha=` reconstruye el estado vigente en cualquier fecha.
- **Índice compuesto** `{producto_id, fecha}` sobre `producto_eventos` — confirmado creado, no solo declarado.
- **Agregación** de ediciones por producto sobre la misma colección — corrida y verificada.

**Verificado en vivo, no asumido:** ETL corrido con los 5 productos reales del proyecto; catálogo, filtros (categoría/subcategoría/texto/vendedor) y detalle probados contra el resultado; un producto editado dos veces y la reconstrucción por fecha devolvió efectivamente el estado *anterior* a cada edición (no solo el actual); alta de producto nuevo probada de punta a punta por la UI (React → Express → MySQL + Mongo + evento inicial); y — lo más importante — **`verificar:checkout` se corrió de nuevo después de todo esto y sigue pasando sin cambios**, confirmando que la migración no afectó la atomicidad del checkout de la Fase Inicial.

**Rúbrica de Entrega 1 (ver PRD §5), estado real:**

| Criterio | Peso | Estado |
|---|---|---|
| Diseño y normalización del modelo relacional base | 0.5 pt | ✅ Completo |
| Diagnóstico del problema y justificación de la migración | 0.75 pt | ✅ Escrito (ADR-002) |
| Decisión embed/reference debidamente argumentada | 1.0 pt | ✅ Escrito (ADR-002 §6) |
| Implementación funcional del catálogo (índice + agregación) | 1.0 pt | ✅ Implementado y verificado |
| Historial de cambios + consulta de reconstrucción por fecha | 1.25 pt | ✅ Implementado y verificado |
| Calidad del informe y del repositorio | 0.5 pt | ⚠️ Sin resolver — no se sabe si hace falta un documento de entrega separado (ver §6) |

**Lo que falta de Entrega 1:** reseñas e imágenes como features nuevas (el modelo ya está decidido en ADR-002 §6.1/§6.2, no implementado); resolver la pregunta del formato del informe.

### 3.6 Panel de administrador (`frontend/src/pages/admin/`, `backend/src/routes/adminRoutes.js`)

Visible solo para `administrador` (link "Panel admin" en el header, ruta `/admin`). Muestra el catálogo completo de **todos** los vendedores (no solo lo propio, a diferencia de `/vendedor`), con filtro por categoría y búsqueda por descripción. Reutiliza el mismo formulario de alta/edición del panel de vendedor (`SellerProductFormPage`) — ya soportaba que un `administrador` editara cualquier producto (`productoService.verificarPermiso`), solo faltaba una pantalla que listara todo para llegar ahí; el único cambio al formulario fue hacer que el redirect después de guardar vuelva a `/admin` o `/vendedor` según desde dónde se entró.

**Botón "Sincronizar con MongoDB":** agrega a Mongo lo que exista en MySQL y todavía no tenga documento (categorías, subcategorías, productos) — **no** es el script `scripts/etlCatalogoAMongo.js` expuesto tal cual. Ese script hace `deleteMany()` sobre las colecciones antes de escribir, así que reconstruye todo desde cero y borra el historial de eventos acumulado; exponerlo como botón de administrador habría sido un riesgo real de pérdida de datos cada vez que alguien lo tocara, no solo en el primer uso. En su lugar, `backend/src/services/catalogoSyncService.js` implementa una sincronización aditiva (nunca borra, nunca pisa un documento ya existente) — pensada específicamente para el caso que ya se dio una vez en este proyecto: un producto creado directamente vía la API (Mongo) que nunca tuvo fila en la tabla relacional `categoria_producto`, o un producto cargado directo en MySQL que todavía no llegó a Mongo. `POST /api/admin/sync-catalogo`, protegido con `requireRole('administrador')` (los demás roles reciben 403). Verificado: idempotente (correrlo dos veces seguidas da todo en cero la segunda vez) y probado insertando un producto de prueba directo en MySQL, confirmando que la sincronización lo agrega sin tocar nada más.

---

## 4. Problemas reales encontrados y resueltos

Esta lista importa porque casi todos se descubrieron construyendo (no leyendo el diagrama), y cada uno se corrigió en el momento en vez de quedar como deuda:

- **Faltaba la entidad `pago`** — el modelo original no separaba "instrumento guardado" de "cobro real". Agregada.
- **CVV y número de tarjeta en `decimal`** — corregido a token de pasarela + últimos 4 dígitos (nunca se guarda el número completo ni el CVV).
- **`atributo_producto` sin campo `valor`** — no se podía registrar, por ejemplo, que el color de un producto es "Rojo". Agregado.
- **`producto` sin dueño** — cualquier `vendedor` podía editar el catálogo de cualquier otro. Se agregó `id_vendedor` con permisos aplicados (y migración con backfill sobre los datos ya existentes).
- **`compra_detalle` sin `cantidad`** — se guardaba el total de la línea pero no las unidades compradas; el historial de pedidos no podía mostrar "2 × Camiseta". Agregado (detectado recién al construir esa pantalla).
- **Auto-registro con rol elegible por el cliente** — permitía autoasignarse `administrador`. Corregido: el registro siempre fuerza `comprador`.
- **Checkout sin validar dueño de dirección/método de pago** — un usuario autenticado podía usar la dirección o tarjeta de otro (IDOR). Corregido.
- **Checkout sin validar cantidades positivas** — una cantidad negativa pasaba la validación de stock y *aumentaba* el inventario en vez de restarlo. Corregido.
- **`token_pasarela` se devolvía en el listado de métodos de pago** — sin necesidad, ya que el cliente nunca debería volver a leerlo. Ocultado.
- **Buscador del frontend sin soporte en el backend** — se construyó la barra de búsqueda antes de que `GET /api/productos` supiera filtrar por texto. Se agregó un filtro simple (no es el buscador de texto libre con tolerancia ortográfica que pide el PRD para Entrega 3 — eso sigue pendiente).
- **Permisos de la shadow database de Prisma (3 rondas)** — cada migración nueva exponía un permiso que faltaba (crear/borrar la base, después `ALTER`, después `UPDATE` para un backfill). Se resolvió con un único grant bien acotado en vez de seguir ampliando permisos globales uno por uno. Detalle en [ADR-001](ADR-001-stack-y-migraciones.md#notas-de-implementación-2026-08-22).
- **CLI de Prisma no interactivo bloqueando migraciones "riesgosas"** — pasó dos veces (backfill de `id_vendedor`, restricción unique de `atributo_producto`), incluso ya habiendo verificado que el cambio era seguro. Sin flag para forzarlo; la solución fue escribir la migración a mano y aplicarla con `prisma migrate deploy`.
- **La migración a Mongo, tal como estaba diseñada originalmente, iba a romper la atomicidad del checkout** — mover `precio`/`cantidad` a Mongo (como decía la primera versión de ADR-002) hubiera dejado el descuento de inventario y la creación del pedido en dos bases distintas sin transacción conjunta. Se detectó al planificar la implementación, antes de escribir código, y se resolvió con el modelo dividido (§3.2 de ADR-002): precio/cantidad se quedan en MySQL, checkout no se toca.
- **Las transacciones multi-documento de Mongo necesitan un replica set**, incluso de un solo nodo — un `mongod` standalone no las soporta. Configurado en `docker-compose.yml` con auto-inicialización vía healthcheck.
- **Un MongoDB nativo de Windows, instalado fuera de este proyecto, competía por el puerto 27017** con el contenedor de Docker — Compass, `mongosh` y cualquier cliente conectando a `localhost:27017` hablaban con el Mongo equivocado (vacío), silenciosamente. Se diagnosticó mal al principio (se pensó que era algo específico de PowerShell) hasta que se revisó el puerto en detalle. Corregido moviendo el contenedor al puerto 27018, adentro y afuera. Detalle completo, incluyendo el diagnóstico incorrecto inicial, en [ADR-002 §8](ADR-002-migracion-catalogo-documental.md#8-notas-de-implementación-2026-08-23).

---

## 5. Limitaciones conocidas (decisiones explícitas, no descuidos)

- **El carrito es solo de navegador** (`localStorage`), no hay endpoints de carrito en el backend. Es intencional: el PRD migra el carrito a Redis en Entrega 2, y a diferencia del catálogo (que sí necesita datos relacionales como fuente para el ETL de Entrega 1), el carrito no tiene ese mismo argumento — construir una versión relacional completa ahora era trabajo que se iba a tirar.
- **No hay forma de crear cuentas `vendedor`/`administrador`** desde el registro público — es a propósito (evita que cualquiera se autoasigne un rol con privilegios). Por ahora esas cuentas se crean a mano o por el seed.
- **No se puede recategorizar un producto** ni editar/borrar categorías, subcategorías o atributos ya creados.
- **El panel de administrador (§3.6) cubre catálogo, no pedidos** — un `administrador` ya puede ver y editar el catálogo de todos los vendedores, pero no hay todavía una vista que liste los pedidos de todos los usuarios (`GET /api/compras` sigue devolviendo solo los del usuario autenticado, sin excepción para `administrador`).
- **Sin suite de tests automatizados** (Jest o similar) — toda la verificación en esta sesión fue manual/scripteada (`verificar:checkout`, pruebas por HTTP y por navegador).
- **Crear/editar un producto escribe en MySQL y Mongo sin una transacción conjunta** — cada base queda consistente *dentro de sí misma*, pero no hay garantía atómica entre ambas. `crear()` intenta una compensación de mejor esfuerzo (si falla el paso de Mongo, se borra la fila de MySQL ya creada), pero no es una solución completa — esa es explícitamente tarea de Entrega 3. Ver [ADR-002 §5](ADR-002-migracion-catalogo-documental.md).
- **`producto.descripcion`/`imagen_url`/`estado` siguen existiendo en MySQL** aunque Mongo ya es la fuente de verdad — se mantienen en sync en cada edición para no dejarlos desactualizados, pero son columnas vestigiales. Dropearlas (junto con `categoria`, `subcategoria`, `atributo_categoria`, `atributo_producto`, `categoria_producto`, ya sin uso) es una limpieza deliberadamente pospuesta, no un olvido — ver ADR-002 §7.

---

## 6. Próximos pasos acordados

De los 5 puntos de Entrega 1, quedan pendientes:

1. **Reseñas de producto** — colección `resenas` + `resenas_resumen` cacheado en el producto (modelo ya decidido en ADR-002 §6.1, no implementado).
2. **Imágenes múltiples** — el modelo ya soporta un array de imágenes (`producto.imagenes`), pero no hay UI para cargar más de una por producto; el formulario de vendedor sigue pidiendo una sola URL.
3. **Resolver qué formato de "informe" espera el curso** — no es algo que se pueda resolver escribiendo código, hace falta confirmar con el profesor/la consigna.
4. **Limpieza pospuesta** (no bloqueante): dropear las columnas/tablas relacionales que quedaron sin uso tras la migración (ver §5).

Después de Entrega 1, seguir el roadmap del PRD: Entrega 2 (Redis + grafos/columnar) → Entrega 3 (búsqueda + consistencia distribuida) → Entrega Final (vectorial + seguridad).
5. Construir reseñas e imágenes como features nuevas, sobre el modelo ya decidido en ADR-002.
6. Al menos un índice compuesto + una consulta de agregación reales en Mongo, mapeados a un patrón de consulta del sistema (requerimiento explícito del PRD).
7. Después de Entrega 1, seguir el roadmap: Entrega 2 (Redis + grafos/columnar) → Entrega 3 (búsqueda + consistencia distribuida) → Entrega Final (vectorial + seguridad).

---

## 7. Cómo correr todo esto

Instrucciones completas y actualizadas en el [README.md](../README.md) de la raíz del repositorio (requisitos, puesta en marcha, variables de entorno, usuarios de prueba, estructura de carpetas).
