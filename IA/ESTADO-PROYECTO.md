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
| — (extra, no pedido por el PRD todavía) | Auth completa, CRUD de catálogo, pedidos, panel de vendedor, frontend | ✅ Completo (ver §3) |
| Entrega 1 | Migración de productos a base documental (MongoDB) + historial de cambios por eventos | ⬜ No iniciada |
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

---

## 5. Limitaciones conocidas (decisiones explícitas, no descuidos)

- **El carrito es solo de navegador** (`localStorage`), no hay endpoints de carrito en el backend. Es intencional: el PRD migra el carrito a Redis en Entrega 2, y a diferencia del catálogo (que sí necesita datos relacionales como fuente para el ETL de Entrega 1), el carrito no tiene ese mismo argumento — construir una versión relacional completa ahora era trabajo que se iba a tirar.
- **No hay forma de crear cuentas `vendedor`/`administrador`** desde el registro público — es a propósito (evita que cualquiera se autoasigne un rol con privilegios). Por ahora esas cuentas se crean a mano o por el seed.
- **No se puede recategorizar un producto** ni editar/borrar categorías, subcategorías o atributos ya creados.
- **No hay panel de administrador** que vea pedidos o catálogo de todos los vendedores a la vez (el dashboard de vendedor solo muestra lo propio).
- **Sin suite de tests automatizados** (Jest o similar) — toda la verificación en esta sesión fue manual/scripteada (`verificar:checkout`, pruebas por HTTP y por navegador).

---

## 6. Próximos pasos acordados

1. Cerrar los huecos de §5 que se consideren necesarios antes de seguir (a decidir).
2. Función de **ETL** que exporte el catálogo relacional actual hacia una base documental (MongoDB), como preparación directa para Entrega 1.
3. A partir de ahí, seguir el roadmap del PRD: Entrega 1 (migración documental + historial de cambios) → Entrega 2 (Redis + grafos/columnar) → Entrega 3 (búsqueda + consistencia distribuida) → Entrega Final (vectorial + seguridad).

---

## 7. Cómo correr todo esto

Instrucciones completas y actualizadas en el [README.md](../README.md) de la raíz del repositorio (requisitos, puesta en marcha, variables de entorno, usuarios de prueba, estructura de carpetas).
