# Entrega 1 — Trazabilidad requisito → código

**Fecha:** 2026-08-23

Este documento mapea cada punto que pide el PRD para Entrega 1 ([IA/PRD.md](PRD.md), sección "🟢 Entrega 1 — Base Documental") contra el código real que lo resuelve, con archivo y línea. El objetivo es que se pueda verificar cada ítem sin tener que releer todo el proyecto — y que si algo se mueve o se borra, este documento quede desactualizado de forma visible (una referencia rota es más fácil de detectar que una afirmación sin prueba).

Para el resumen general de estado (qué está hecho, qué falta, problemas encontrados) ver [ESTADO-PROYECTO.md](ESTADO-PROYECTO.md). Para el porqué de cada decisión de diseño ver [ADR-002](ADR-002-migracion-catalogo-documental.md) (migración a documental, embed/reference) y [ADR-003](ADR-003-historial-cambios-eventos.md) (historial de eventos).

---

## 1. Funcionalidades

### 1.1 Catálogo con filtros por categoría

> "Catálogo con filtros por categoría (atributos relevantes por tipo de producto)"

- **Filtro backend:** [`productoService.listar()`](../backend/src/services/productoService.js) — `backend/src/services/productoService.js:77-114`. Acepta `categoriaId`, `subcategoriaId`, `q` (texto en descripción), `vendedorId`, `atributos`, `precioMin`/`precioMax`, `ordenarPor` (ver §2.2 y más abajo); resuelve categoría → subcategorías vía `Subcategoria.find()` cuando el filtro es por categoría completa (líneas 83-86).
- **Ruta:** `GET /api/productos` — `backend/src/routes/productoRoutes.js:7-10` (pública, sin token).
- **UI:** [`HomePage.jsx`](../frontend/src/pages/HomePage.jsx) lee `q`/`categoriaId`/`subcategoriaId` de la URL (líneas 8-11) y los pasa tal cual a `productosApi.listar()` (línea 22). El menú de categorías con el que se filtra es [`CategoryMenu.jsx`](../frontend/src/components/layout/CategoryMenu.jsx), enganchado a la barra de búsqueda en `Header.jsx:54-55`.
- **Atributos relevantes por tipo de producto:** cada producto expone `atributos: [{nombre, valor}]` (definidos por su subcategoría, ver 1.2) — se ven en `ProductDetailPage.jsx` y en el listado vía `ProductCard.jsx`.

### 1.2 Panel administrativo: formulario adaptable por categoría

> "Panel administrativo: formulario adaptable por categoría al crear/editar productos"

- **Definición de atributos por subcategoría:** `Subcategoria.atributos_definidos: [String]` — `backend/src/models/mongo/Subcategoria.js:8`. Se arma vía `POST /api/categorias/subcategorias/:id/atributos` → `categoriaService.crearAtributo()` (`backend/src/services/categoriaService.js:41-52`).
- **Formulario que se adapta solo:** [`SellerProductFormPage.jsx`](../frontend/src/pages/seller/SellerProductFormPage.jsx) calcula `atributosDisponibles` a partir de la subcategoría elegida (línea 94) y renderiza un `<Field>` por cada atributo dinámicamente (líneas 288-295) — cambiar la subcategoría cambia los campos del formulario sin tocar código. También permite crear categoría → subcategoría → atributo sobre la marcha sin salir del formulario (`InlineCreate`, línea 9, usado en líneas 257/276/296).
- **Dos paneles usan el mismo formulario:** vendedor (`/vendedor/productos/nuevo|:id/editar`, solo lo propio) y administrador (`/admin/productos/nuevo|:id/editar`, cualquier producto) — mismo componente, distinto listado de origen (`SellerDashboardPage.jsx` vs. [`AdminDashboardPage.jsx`](../frontend/src/pages/admin/AdminDashboardPage.jsx)). El permiso real se valida server-side en `productoService.verificarPermiso()` (`backend/src/services/productoService.js:200-213`), no en el frontend.

### 1.3 Vista de detalle de producto

> "Vista de detalle de producto"

- **Backend:** `GET /api/productos/:id` — `backend/src/routes/productoRoutes.js:20-27` → `productoService.obtener()` (`productoService.js:104-111`), lee el documento de Mongo, que desde el 2026-08-29 ya incluye precio/cantidad como copia de lectura (ver ADR-002 §3.3) — ya no hay una lectura cruzada a MySQL en este camino.
- **Frontend:** [`ProductDetailPage.jsx`](../frontend/src/pages/ProductDetailPage.jsx) — trae el producto por id (líneas 20-25), muestra descripción, atributos, vendedor, precio/stock y permite agregar al carrito.

### 1.4 Consulta del estado histórico en una fecha arbitraria

> "Consulta del estado histórico de un producto en una fecha arbitraria"

Ver detalle completo en §2.5 (es el mismo requerimiento técnico, no una feature aparte). Endpoint: `GET /api/productos/:id/historial?fecha=AAAA-MM-DD`.

---

## 2. Requerimientos técnicos

### 2.1 Migración documentada y reproducible: relacional → documental

> "Migración documentada y reproducible de productos: modelo relacional → base documental"

- **Diagnóstico y justificación:** [ADR-002 §1](ADR-002-migracion-catalogo-documental.md#1-diagnóstico-contexto) (por qué el modelo EAV relacional no alcanza) y [§3.2](ADR-002-migracion-catalogo-documental.md#32-actualización-2026-08-23-por-qué-preciocantidad-no-migran) (qué migra y qué no, y por qué).
- **Script de migración (bootstrap, reproducible) — histórico:** hasta el 2026-08-30, `backend/scripts/etlCatalogoAMongo.js` leía `categoria`/`subcategoria`/`producto` de MySQL vía Prisma, limpiaba y reescribía las colecciones Mongo destino; `catalogoSyncService.sincronizarFaltantes()` (expuesta en `POST /api/admin/sync-catalogo`) hacía lo mismo de forma aditiva para un catálogo ya en uso. Ambos se borraron junto con las tablas relacionales que migraban/sincronizaban (ver [ADR-002 §3.4](ADR-002-migracion-catalogo-documental.md#34-actualización-2026-08-30-se-borra-el-catálogo-relacional-vestigial)) — sin `categoria`/`subcategoria`/`atributo_*` en MySQL, no queda nada de qué hacer ETL. `prisma/seed.js` absorbió ese trabajo: puebla MySQL y Mongo en un solo paso.
- **Verificación (en su momento):** ambos scripts se corrieron y verificaron contra los datos reales del proyecto antes de que las tablas relacionales se borraran — confirmado vía `GET /api/productos` que el resultado coincidía con el origen relacional. La migración en sí (el requerimiento del PRD) ya estaba satisfecha independientemente de que las herramientas que la hicieron posible ya no existan.

### 2.2 Decisión embed vs. reference (reseñas, imágenes, vendedor)

> "Decisión embed vs. reference fundamentada para: reseñas de producto, imágenes asociadas, relación producto–vendedor (criterios: frecuencia de acceso conjunto, volumen de datos, tasa de cambio)"

Las tres decisiones están en [ADR-002 §6](ADR-002-migracion-catalogo-documental.md#6-decisiones-de-modelado-embed-vs-reference), cada una con los tres criterios que pide el PRD:

| Relación | Decisión | Dónde | Código |
|---|---|---|---|
| Reseñas de producto | **Reference**, con resumen embebido (`resenas_resumen`) | ADR-002 §6.1 (link arriba, ir a "Reseñas de producto") | Campo ya modelado: `Producto.js:26-29` (`resenas_resumen: {promedio, cantidad}`). La colección `resenas` en sí es feature nueva, no implementada — el PRD solo exige la decisión argumentada, no la feature funcionando (ver ESTADO-PROYECTO.md §3.5/§6). |
| Imágenes asociadas | **Embed** (array en el propio documento) | ADR-002 §6.2 (link arriba, ir a "Imágenes asociadas") | `Producto.js:4-7,25` (`imagenes: [{url, alt, orden, principal}]`). Implementado y en uso — `productoService.construirImagenes()` (`productoService.js:126-128`), consumido por `ProductDetailPage.jsx` y `ProductCard.jsx`. Límite conocido: el formulario de vendedor/admin solo carga una imagen por producto (el modelo soporta más). |
| Relación producto–vendedor | **Reference**, con caché de solo lectura (`vendedor_nombre`) | ADR-002 §6.3 (link arriba, ir a "Relación producto–vendedor") | `Producto.js:20-23` (`vendedor_id` + `vendedor_nombre`). Es la referencia cruzada real hacia MySQL — ver 2.6. |

### 2.3 Índice compuesto mapeado a un patrón de consulta real

> "Al menos un índice compuesto mapeado a un patrón de consulta real"

- **Código:** `productoEventoSchema.index({ producto_id: 1, fecha: -1 })` — `backend/src/models/mongo/ProductoEvento.js:18`.
- **Patrón de consulta que lo justifica:** exactamente la reconstrucción por fecha de 2.5 (`ProductoEvento.findOne({producto_id, fecha: {$lte: fecha}}).sort({fecha: -1})` — filtra por `producto_id` y ordena por `fecha` descendente, que es lo que el índice compuesto acelera directamente). Diseño explicado en [ADR-003 §3.4](ADR-003-historial-cambios-eventos.md#34-índice-y-agregación-requerimientos-técnicos-de-entrega-1-no-solo-de-este-adr).
- **Verificación:** confirmado creado en Mongo (no solo declarado en el schema) vía `db.producto_eventos.getIndexes()`.

### 2.4 Consulta de agregación

> "Al menos una consulta de agregación usando el framework de la base documental"

- **Código:** `productoService.estadisticasEdiciones()` — `backend/src/services/productoService.js:330-355`. Pipeline `$match` (opcional, por fecha) → `$group` (total de eventos, última edición y versión actual por `producto_id`) → `$sort` → `$project`.
- **Endpoint:** `GET /api/productos/estadisticas/ediciones` (`?desde=AAAA-MM-DD` opcional) — `backend/src/routes/productoRoutes.js:14-17`. Registrada **antes** de `/:id` a propósito, para que Express no interprete `estadisticas` como un id.
- **Patrón de consulta real:** "qué productos se editan más" — insumo directo para un panel de actividad de vendedor/administrador. Diseño sugerido en [ADR-003 §3.4](ADR-003-historial-cambios-eventos.md#34-índice-y-agregación-requerimientos-técnicos-de-entrega-1-no-solo-de-este-adr).
- **Frontend:** widget "Productos más editados" en [`AdminDashboardPage.jsx`](../frontend/src/pages/admin/AdminDashboardPage.jsx) (`EstadisticasEdicionesWidget`) — selector de período (todo/7/30 días) más una lista ordenada por total de eventos, cada fila linkeando a editar ese producto. Llama a `productosApi.estadisticasEdiciones()` (`frontend/src/api/productos.js:14-15`).
- **Verificación:** probado contra datos reales — devuelve conteos correctos por producto, el filtro `?desde=` probado con una fecha futura (da `[]`) y con la fecha de hoy (da todo, porque todos los eventos son de hoy), y confirmado en el navegador que cambiar el período en el widget dispara la petición con el `?desde=` correcto (revisado en Network, no solo asumido por el resultado visual).

### 2.5 Historial de cambios por eventos + reconstrucción por fecha

> "Historial de cambios por eventos: cada modificación agrega un evento (sin sobrescribir); consulta de reconstrucción del estado en fecha arbitraria"

- **Modelo append-only:** [`ProductoEvento.js`](../backend/src/models/mongo/ProductoEvento.js) — cada documento es un snapshot completo (no un delta, ver [ADR-003 §3.1](ADR-003-historial-cambios-eventos.md#31-esquema)), nunca se actualiza ni se borra.
- **Escritura:** cada alta agrega un evento `tipo: 'creacion'` (`productoService.crear()`, líneas 172-186); cada edición agrega `tipo: 'edicion'` con `campos_modificados` y el snapshot completo post-cambio (`productoService.actualizar()`, líneas 284-298). **Desde 2026-08-26, precio/cantidad también generan evento** — un edit de *solo* precio o *solo* cantidad ya no requiere un cambio descriptivo para versionarse (revisión sobre el planteo original de [ADR-003 §3.1](ADR-003-historial-cambios-eventos.md#31-esquema), ver la actualización fechada ahí). Cada snapshot incluye `inventario: {precio, cantidad}` capturado de MySQL en el momento exacto del evento — un valor cacheado y congelado, no un campo que se mantenga sincronizado después. A propósito **no** cubre los descuentos de inventario del checkout: eso seguiría siendo cada venta, y el historial de catálogo dejaría de tener sentido si registrara cada compra individual.
- **Reconstrucción por fecha:** `productoService.historialEnFecha()` — `productoService.js:313-317`: busca el evento más reciente con `fecha <= fecha_pedida`, si no hay ninguno el producto "no existía todavía" (404). `historialCompleto()` (líneas 319-321) da la línea de tiempo completa.
- **Endpoint:** `GET /api/productos/:id/historial` (línea de tiempo) y `GET /api/productos/:id/historial?fecha=` (snapshot en esa fecha) — `backend/src/routes/productoRoutes.js:34-47`. **Restringido a `vendedor`/`administrador`** (antes era público) — desde que expone precio histórico y patrones de stock, información de negocio que un comprador no debería poder curiosear.
- **Frontend:** `HistorialSection`, componente compartido en [`frontend/src/components/product/HistorialSection.jsx`](../frontend/src/components/product/HistorialSection.jsx) (líneas 76-206) — línea de tiempo completa (tipo, versión, fecha, quién editó, campos modificados, precio/stock del momento), cada entrada clickeable (`verVersion()`, líneas 122-127), más un formulario de fecha que llama a `productosApi.historialEnFecha()` (`frontend/src/api/productos.js:13`). Ambos caminos muestran el resultado con `SnapshotPreviewCard` (líneas 18-69) — una mini-tarjeta con el mismo lenguaje visual que `ProductCard.jsx` del catálogo normal (imagen, precio, badge de stock), pero de solo lectura a propósito (sin botón de comprar, ver comentario en el código). Clickear una entrada de la línea de tiempo no pide nada nuevo al backend (el snapshot ya vino con `historialCompleto()`) — a propósito, porque el buscador de fecha solo tiene granularidad de día y no puede distinguir dos ediciones del mismo día, mientras que clickear una versión específica sí.
- **Dos consumidores del mismo componente, cada uno resuelve el permiso a su manera:** [`ProductDetailPage.jsx`](../frontend/src/pages/ProductDetailPage.jsx) lo monta solo si `usuario.rol.tipo_rol` es `vendedor`/`administrador` (un `comprador` o un visitante anónimo no lo ve) — necesario porque esa página es pública y cualquiera puede llegar a ella. `SellerDashboardPage.jsx` lo monta sin re-chequear el rol: la ruta `/vendedor` ya está detrás de `RequireRole` en `App.jsx`, así que quien llega ahí ya tiene permiso — chequearlo dos veces sería redundante. En ambos casos, si alguien igual intentara llamar al endpoint sin el rol correcto, el backend lo rechaza de todas formas (no es solo un filtro visual). Antes de todo esto el requerimiento solo era verificable por curl — no tenía superficie en la app real.
- **Verificación:** un producto editado dos veces (ver historial real de "Taza ceramica", `producto_id=4`, 3 eventos) y la reconstrucción por fecha devolvió efectivamente el estado *anterior* a cada edición, no solo el vigente — confirmado tanto por API como visualmente en `/productos/4`.

### 2.6 Mecanismo de referencia cruzada (relacional → documental)

> "Documentación del mecanismo de referencia cruzada: líneas de pedido (relacionales) → productos (documentales), sin exigir integridad referencial garantizada en esta etapa"

- **Documentado en:** [ADR-002 §6](ADR-002-migracion-catalogo-documental.md#6-decisiones-de-modelado-embed-vs-reference), subsección 6.3 (líneas 178-196 del ADR) — con el modelo dividido (§3.2), `producto`/`inventario` **no se movieron** de MySQL, así que `compra_detalle.id_producto` sigue siendo una FK real de MySQL a MySQL, sin cruce de bases. Las dos referencias cruzadas reales nacen del lado Mongo apuntando hacia MySQL:
  - `Producto.producto_id` (Mongo, `Producto.js:30`) → `producto.id` (MySQL) — es lo que conecta el documento con su fila `producto`/`inventario`. `Producto.inventario.precio`/`cantidad` (Mongo, `Producto.js:38` — anidado desde el 2026-08-30, ver ADR-002 §3.6) son una copia de lectura reenviada desde `inventario` (MySQL, la única fuente transaccional) en cada escritura — ver [ADR-002 §3.3](ADR-002-migracion-catalogo-documental.md#33-actualización-2026-08-29-copia-de-lectura-de-preciocantidad-en-mongo); el reenvío vive en `productoService.actualizar()`/`crear()` y `checkoutService.js`, ya no en una lectura cruzada al servir el catálogo.
  - `Producto.vendedor_id` (Mongo, `Producto.js:36`) → `usuarios.id_usuario` (MySQL) — con `vendedor_nombre` como caché de lectura para no tener que resolverlo en cada consulta.
- **Sin integridad garantizada, a propósito:** si se borrara un usuario o un producto por fuera del flujo normal, quedaría una referencia huérfana — mitigación documentada es desactivar, no borrar (no hay endpoint de borrado físico de ninguno de los dos). Consistente con lo que pide el PRD para esta etapa.

---

## 3. Entregable

> "Informe: modelo relacional base + diagnóstico + decisión documental justificada + evidencia de funcionamiento. Repositorio: script de migración + código del catálogo."

- **Modelo relacional base:** [ERD.md](ERD.md) + `backend/prisma/schema.prisma`.
- **Diagnóstico + decisión documental justificada:** [ADR-002](ADR-002-migracion-catalogo-documental.md) completo.
- **Evidencia de funcionamiento:** este documento (§1-2) + [ESTADO-PROYECTO.md §3.5](ESTADO-PROYECTO.md) (qué se corrió y verificó, no solo qué se escribió).
- **Script de migración (histórico, ver arriba):** `backend/scripts/etlCatalogoAMongo.js` y `catalogoSyncService.sincronizarFaltantes()` ya no existen — su trabajo lo absorbió `backend/prisma/seed.js` (ver [ADR-002 §3.4](ADR-002-migracion-catalogo-documental.md#34-actualización-2026-08-30-se-borra-el-catálogo-relacional-vestigial)).
- **Código del catálogo:** `backend/src/services/{categoriaService,productoService}.js`, `backend/src/models/mongo/`, `backend/src/routes/{categoriaRoutes,productoRoutes}.js`, todo el frontend en `frontend/src/pages/` (`HomePage`, `ProductDetailPage`, `pages/seller/`, `pages/admin/`).
- **"Calidad del informe y del repositorio" (0.5 pt):** sigue sin resolver si el curso espera un documento de entrega separado (PDF u otro formato) además de lo que ya está en `IA/` — depende de la consigna del curso, no de código. Ver [ESTADO-PROYECTO.md §6](ESTADO-PROYECTO.md).

---

## 4. Resumen — rúbrica (PRD §5, 5 pts)

| Criterio | Peso | Estado | Sección de este documento |
|---|---|---|---|
| Diseño y normalización del modelo relacional base | 0.5 pt | ✅ | — (ver [ERD.md](ERD.md)) |
| Diagnóstico del problema y justificación de la migración | 0.75 pt | ✅ | §2.1 |
| Decisión embed/reference debidamente argumentada | 1.0 pt | ✅ | §2.2 |
| Implementación funcional del catálogo (índice + agregación) | 1.0 pt | ✅ | §2.3, §2.4 |
| Historial de cambios + consulta de reconstrucción por fecha | 1.25 pt | ✅ | §2.5 |
| Calidad del informe y del repositorio | 0.5 pt | ⚠️ | §3 |

**4.5 de 5 puntos verificables en código.** El único pendiente (calidad del informe) es una pregunta de formato para el curso, no una tarea de implementación.
