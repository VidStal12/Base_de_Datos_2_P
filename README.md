# TiendaYa

Proyecto de curso — Bases de Datos 2. Portal de comercio electrónico construido de forma incremental sobre una arquitectura políglota de bases de datos. Contexto completo, alcance por entrega y rúbricas en [IA/PRD.md](IA/PRD.md); el modelo de datos de la Fase Inicial está documentado en [IA/ERD.md](IA/ERD.md) y las decisiones de stack en [IA/ADR-001-stack-y-migraciones.md](IA/ADR-001-stack-y-migraciones.md). Para un resumen de qué se construyó y en qué estado está el proyecto, ver [IA/ESTADO-PROYECTO.md](IA/ESTADO-PROYECTO.md).

## Estado actual: Fase Inicial completa, Entrega 1 en curso

Backend en Node.js (JavaScript) + Express. MySQL (Prisma) para datos transaccionales — usuarios, direcciones, pedidos, pagos, inventario. MongoDB (Mongoose) para el catálogo descriptivo — categorías, atributos variables por producto, historial de cambios (ver [IA/ADR-002](IA/ADR-002-migracion-catalogo-documental.md)). Frontend en React (Vite) + Tailwind CSS. Detalle de qué está hecho y qué falta en [IA/ESTADO-PROYECTO.md](IA/ESTADO-PROYECTO.md).

## Requisitos

- Node.js 20+
- Docker Desktop (para los contenedores de MySQL y MongoDB)

## Puesta en marcha

1. **Levantar MySQL y MongoDB en Docker** (desde la raíz del repo):

   ```bash
   docker compose up -d
   ```

   MongoDB corre como *replica set* de un solo nodo (se auto-inicializa) — lo necesitan las transacciones del historial de cambios, ver [IA/ADR-003](IA/ADR-003-historial-cambios-eventos.md).

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

5. **Cargar datos de prueba representativos** (MySQL):

   ```bash
   npm run seed
   ```

6. **Migrar el catálogo a MongoDB** (lee de MySQL, escribe en Mongo — reproducible, se puede correr de nuevo las veces que haga falta):

   ```bash
   node scripts/etlCatalogoAMongo.js
   ```

7. **Levantar el servidor**:

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

También se puede probar vía HTTP. El checkout requiere estar autenticado — el usuario y sus direcciones/métodos de pago se resuelven del token, nunca de lo que mande el cliente en el body:

```bash
# 1. Login (el usuario de ejemplo lo crea el seed)
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"correo":"ana.gomez@example.com","contrasena":"Password123!"}' | jq -r .token)

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

(Requiere `jq`; si no lo tenés, copiá el `token` del JSON de login a mano. Los IDs asumen una base recién sembrada — ajustar según lo que devuelvan los listados.)

## Catálogo

`GET /api/categorias` y `GET /api/productos` son públicos (no requieren token). Crear o editar catálogo requiere estar autenticado **y** tener rol `vendedor` o `administrador` — un `comprador` recibe `403`. La lista completa de endpoints (con cuáles requieren token/rol) está en `GET /` del servidor corriendo.

Cada producto le pertenece a un vendedor (`producto.id_vendedor`). Un `vendedor` solo puede editar sus propios productos (`403` si intenta tocar uno ajeno); un `administrador` puede editar cualquiera. No hay endpoint público para crear cuentas `vendedor`/`administrador` — el auto-registro siempre asigna `comprador` (ver [ADR-001](IA/ADR-001-stack-y-migraciones.md)); esas cuentas se crean a mano/por seed por ahora.

**Pantallas de vendedor** (`frontend/src/pages/seller/`): con sesión `vendedor`/`administrador` aparece "Mi tienda" en el header → `/vendedor` lista solo los productos propios. El formulario de alta (`/vendedor/productos/nuevo`) deja crear categoría → subcategoría → atributo en el momento si no existen todavía (sin salir del formulario), con los inputs de valor de atributo generados dinámicamente según la subcategoría elegida. Al editar (`/vendedor/productos/:id/editar`) la categoría/subcategoría quedan fijas — recategorizar no está soportado, hay que publicar un producto nuevo — pero descripción, imagen, estado, precio, stock y valores de atributo sí se pueden corregir.

Los ids de categoría/subcategoría son ObjectId de Mongo (strings), no enteros — hay que usar el que devuelva cada `POST`, no un valor fijo:

```bash
VTOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"correo":"luis.ramirez@example.com","contrasena":"Password123!"}' | jq -r .token)

# categoría -> subcategoría -> atributo (define qué atributos aplican a esa subcategoría)
CAT_ID=$(curl -s -X POST http://localhost:3000/api/categorias -H "Authorization: Bearer $VTOKEN" -H "Content-Type: application/json" -d '{"categoria":"Hogar"}' | jq -r .id)
SUB_ID=$(curl -s -X POST http://localhost:3000/api/categorias/$CAT_ID/subcategorias -H "Authorization: Bearer $VTOKEN" -H "Content-Type: application/json" -d '{"subcategoria":"Cocina"}' | jq -r .id)
curl -s -X POST http://localhost:3000/api/categorias/subcategorias/$SUB_ID/atributos -H "Authorization: Bearer $VTOKEN" -H "Content-Type: application/json" -d '{"atributo":"Material"}'

# producto con inventario y valor concreto del atributo (por nombre, no por id)
curl -s -X POST http://localhost:3000/api/productos -H "Authorization: Bearer $VTOKEN" -H "Content-Type: application/json" \
  -d "{\"descripcion\":\"Sartén 26cm\",\"subcategoriaId\":\"$SUB_ID\",\"precio\":249.5,\"cantidad\":20,\"atributos\":[{\"nombre\":\"Material\",\"valor\":\"Aluminio\"}]}"

# navegar el catálogo (sin token)
curl -s "http://localhost:3000/api/productos?subcategoriaId=$SUB_ID"
curl -s http://localhost:3000/api/productos/1
```

## Historial de cambios (Entrega 1)

Cada alta/edición del contenido descriptivo de un producto (descripción, estado, atributos, imágenes — **no** precio/stock, que no se versionan, ver [ADR-002](IA/ADR-002-migracion-catalogo-documental.md#32-actualización-2026-08-23-por-qué-preciocantidad-no-migran)) agrega un evento en vez de sobrescribir. `GET /api/productos/:id/historial` es público:

```bash
# línea de tiempo completa
curl -s http://localhost:3000/api/productos/1/historial

# estado vigente en una fecha arbitraria (404 si el producto no existía todavía)
curl -s "http://localhost:3000/api/productos/1/historial?fecha=2026-08-01"
```

## Frontend

Storefront en React con el patrón de layout de Amazon (header oscuro con búsqueda, franja de categorías, grilla de productos) pero con una paleta propia basada en teoría del color: **azul** (confianza/calma — la elección estándar en apps financieras) como color principal, y **verde azulado** como acento para acciones positivas (agregar al carrito, confirmaciones) — a propósito distinto del naranja de Amazon, que comunica urgencia. Paleta completa y el porqué en `frontend/src/index.css`.

El carrito vive en el navegador (localStorage), no en el backend — no hay endpoints de carrito porque esa pieza se migra a Redis en Entrega 2 (ver PRD), así que no tenía sentido construir una versión relacional completa ahora. El checkout sigue pasando por el backend igual.

```bash
cd frontend
npm install
cp .env.example .env      # apunta a http://localhost:3000/api por defecto
npm run dev
```

Corre en `http://localhost:5173`. Necesita el backend (`cd backend && npm run dev`) y MySQL (`docker compose up -d`) corriendo en paralelo.

Usuarios de prueba (creados por `npm run seed` del backend): `ana.gomez@example.com` (comprador) y `luis.ramirez@example.com` (vendedor), ambos con contraseña `Password123!`. No hay forma de crear una cuenta `vendedor`/`administrador` desde el registro público — es intencional, ver la sección Catálogo arriba.

## Estructura del repositorio

```
IA/                    Documentación de arquitectura (PRD, ERD, ADRs, estado del proyecto)
backend/
  prisma/
    schema.prisma       Esquema MySQL (usuarios, direcciones, pedidos, pagos, inventario)
    migrations/          DDL versionado, generado por Prisma Migrate
    seed.js               Datos de prueba representativos (MySQL)
  scripts/
    verificarCheckout.js    Evidencia de atomicidad del checkout
    etlCatalogoAMongo.js     ETL relacional -> documental del catálogo (ver ADR-002)
  src/
    config/prisma.js      Cliente de Prisma (MySQL)
    config/mongo.js        Conexión de Mongoose (MongoDB)
    models/mongo/           Esquemas de Mongoose (Categoria, Subcategoria, Producto, ProductoEvento)
    services/              Lógica de negocio (auth, checkout, catálogo, historial)
    routes/                 Endpoints Express
    app.js / server.js
frontend/
  src/
    api/                   Cliente HTTP hacia el backend
    context/               Auth (token/sesión) y Cart (carrito en localStorage)
    components/            Layout (Header/Footer), tarjetas de producto, UI común
    pages/                 Una por ruta (catálogo, producto, carrito, checkout, pedidos...)
    pages/seller/            Panel de vendedor (alta/edición de productos)
    index.css              Paleta de colores (tokens de Tailwind) y estilos base
docker/
  mysql-init/            Scripts que corren solo al inicializar el volumen de MySQL
docker-compose.yml     Contenedores de MySQL y MongoDB para desarrollo
```
