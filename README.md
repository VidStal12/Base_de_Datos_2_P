# TiendaYa

Proyecto de curso — Bases de Datos 2. Portal de comercio electrónico construido de forma incremental sobre una arquitectura políglota de bases de datos. Contexto completo, alcance por entrega y rúbricas en [IA/PRD.md](IA/PRD.md); el modelo de datos de la Fase Inicial está documentado en [IA/ERD.md](IA/ERD.md) y las decisiones de stack en [IA/ADR-001-stack-y-migraciones.md](IA/ADR-001-stack-y-migraciones.md). Para un resumen de qué se construyó y en qué estado está el proyecto, ver [IA/ESTADO-PROYECTO.md](IA/ESTADO-PROYECTO.md).

## Estado actual: Fase Inicial completa, Entrega 1 con los requerimientos técnicos implementados

Backend en Node.js (JavaScript) + Express. MySQL (Prisma) para datos transaccionales — usuarios, direcciones, pedidos, pagos, inventario. MongoDB (Mongoose) para el catálogo descriptivo — categorías, atributos variables por producto, historial de cambios (ver [IA/ADR-002](IA/ADR-002-migracion-catalogo-documental.md)). Frontend en React (Vite) + Tailwind CSS. Los 6 requerimientos técnicos de Entrega 1 (PRD §5) están implementados y verificados — ver [IA/ENTREGA-1-TRAZABILIDAD.md](IA/ENTREGA-1-TRAZABILIDAD.md) para el detalle punto por punto con referencias al código, o [IA/ESTADO-PROYECTO.md](IA/ESTADO-PROYECTO.md) para el resumen general de qué está hecho y qué falta.

## Requisitos

- Node.js 20+
- Docker Desktop (para los contenedores de MySQL y MongoDB)

## Puesta en marcha

1. **Levantar MySQL, MongoDB y Redis en Docker** (desde la raíz del repo):

   ```bash
   docker compose up -d
   ```

   MongoDB corre como *replica set* de un solo nodo (se auto-inicializa) — lo necesitan las transacciones del historial de cambios, ver [IA/ADR-003](IA/ADR-003-historial-cambios-eventos.md). Redis es para el carrito (Entrega 2, ver [IA/ENTREGA-2-PLAN.md](IA/ENTREGA-2-PLAN.md)) — sin volumen a propósito, es dato transitorio.

2. **Instalar dependencias del backend**:

   ```bash
   cd backend
   npm install
   ```

3. **Configurar variables de entorno** (`.env` no se versiona):

   ```bash
   cp .env.example .env
   ```

   Los valores por defecto ya coinciden con `docker-compose.yml`; solo hace falta ajustar `DATABASE_URL` si cambiaste las credenciales del contenedor.

4. **Aplicar el esquema**:

   - Ya existe una migración inicial versionada en `prisma/migrations/`. Para clonar el repo y aplicar tal cual está (no crea migraciones nuevas, no necesita permisos de shadow database):
     ```bash
     npm run prisma:deploy
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

Agrega un ítem y confirma el TTL de 7.5 min (450s, por inactividad — se reinicia con cada interacción, no solo al crear la clave), que agregar de más clampa contra el stock vigente, que quitar el último ítem borra la clave del hash entera, y que un checkout exitoso vacía el carrito del lado del servidor. Detalle completo en [IA/ENTREGA-2-PLAN.md §4.1](IA/ENTREGA-2-PLAN.md).

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

El carrito vive en el navegador (localStorage), no en el backend — no hay endpoints de carrito porque esa pieza se migra a Redis en Entrega 2 (ver PRD), así que no tenía sentido construir una versión relacional completa ahora. El checkout sigue pasando por el backend igual.

```bash
cd frontend
npm install
cp .env.example .env      # apunta a http://localhost:3000/api por defecto
npm run dev
```

Corre en `http://localhost:5173`. Necesita el backend (`cd backend && npm run dev`) y MySQL (`docker compose up -d`) corriendo en paralelo.

**Mi cuenta** (`/cuenta`, requiere sesión): listar, agregar y borrar direcciones y métodos de pago — los mismos formularios que aparecen embebidos en Checkout, ahora también accesibles fuera del flujo de compra. Borrar algo que ya se usó en un pedido se rechaza con un mensaje claro (`409 No se puede eliminar: ... tiene pedidos/pagos asociados`) en vez de un error de base de datos.

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
  src/
    config/prisma.js      Cliente de Prisma (MySQL)
    config/mongo.js        Conexión de Mongoose (MongoDB)
    config/redis.js         Cliente de ioredis (Redis, Entrega 2)
    models/mongo/           Esquemas de Mongoose (Categoria, Subcategoria, Producto, ProductoEvento)
    services/              Lógica de negocio (auth, checkout, catálogo, carrito, historial, sync admin)
    routes/                 Endpoints Express (incluye adminRoutes.js)
    app.js / server.js
frontend/
  src/
    api/                   Cliente HTTP hacia el backend
    context/               Auth (token/sesión) y Cart (carrito en localStorage)
    components/            Layout (Header/Footer), tarjetas de producto, UI común
    components/account/     Formularios de dirección/método de pago (compartidos: Checkout y /cuenta)
    pages/                 Una por ruta (catálogo, producto, carrito, checkout, pedidos, cuenta...)
    pages/seller/            Panel de vendedor (alta/edición de productos)
    pages/admin/             Panel de administrador (catálogo de todos los vendedores + sync)
    index.css              Paleta de colores (tokens de Tailwind) y estilos base
docker/
  mysql-init/            Scripts que corren solo al inicializar el volumen de MySQL
docker-compose.yml     Contenedores de MySQL y MongoDB para desarrollo
```
