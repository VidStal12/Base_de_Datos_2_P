# TiendaYa

Proyecto de curso — Bases de Datos 2. Portal de comercio electrónico construido de forma incremental sobre una arquitectura políglota de bases de datos. Contexto completo, alcance por entrega y rúbricas en [IA/PRD.md](IA/PRD.md); el modelo de datos de la Fase Inicial está documentado en [IA/ERD.md](IA/ERD.md) y las decisiones de stack en [IA/ADR-001-stack-y-migraciones.md](IA/ADR-001-stack-y-migraciones.md).

## Estado actual: Fase Inicial

Backend en Node.js (JavaScript) + Express, MySQL en contenedor Docker, ORM/migraciones con Prisma.

## Requisitos

- Node.js 20+
- Docker Desktop (para el contenedor de MySQL)

## Puesta en marcha

1. **Levantar MySQL en Docker** (desde la raíz del repo):

   ```bash
   docker compose up -d
   ```

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

5. **Cargar datos de prueba representativos**:

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
```

(Requiere `jq`; si no lo tenés, copiá el `token` del JSON de login a mano. Los IDs asumen una base recién sembrada — ajustar según lo que devuelvan los listados.)

## Catálogo

`GET /api/categorias` y `GET /api/productos` son públicos (no requieren token). Crear o editar catálogo requiere estar autenticado **y** tener rol `vendedor` o `administrador` — un `comprador` recibe `403`. La lista completa de endpoints (con cuáles requieren token/rol) está en `GET /` del servidor corriendo.

```bash
VTOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"correo":"luis.ramirez@example.com","contrasena":"Password123!"}' | jq -r .token)

# categoría -> subcategoría -> atributo (define qué atributos aplican a esa subcategoría)
curl -s -X POST http://localhost:3000/api/categorias -H "Authorization: Bearer $VTOKEN" -H "Content-Type: application/json" -d '{"categoria":"Hogar"}'
curl -s -X POST http://localhost:3000/api/categorias/1/subcategorias -H "Authorization: Bearer $VTOKEN" -H "Content-Type: application/json" -d '{"subcategoria":"Cocina"}'
curl -s -X POST http://localhost:3000/api/categorias/subcategorias/1/atributos -H "Authorization: Bearer $VTOKEN" -H "Content-Type: application/json" -d '{"atributo":"Material"}'

# producto con inventario y valor concreto del atributo
curl -s -X POST http://localhost:3000/api/productos -H "Authorization: Bearer $VTOKEN" -H "Content-Type: application/json" \
  -d '{"descripcion":"Sartén 26cm","subcategoriaId":1,"precio":249.5,"cantidad":20,"atributos":[{"id_atributo_categoria":1,"valor":"Aluminio"}]}'

# navegar el catálogo (sin token)
curl -s "http://localhost:3000/api/productos?subcategoriaId=1"
curl -s http://localhost:3000/api/productos/1
```

## Estructura del repositorio

```
IA/                    Documentación de arquitectura (PRD, ERD, ADRs)
backend/
  prisma/
    schema.prisma       Esquema (fuente de verdad del modelo de datos)
    migrations/          DDL versionado, generado por Prisma Migrate
    seed.js               Datos de prueba representativos
  scripts/
    verificarCheckout.js  Evidencia de atomicidad del checkout
  src/
    config/prisma.js      Cliente de Prisma (adaptador MySQL)
    services/              Lógica de negocio (auth, checkout)
    routes/                 Endpoints Express
    app.js / server.js
docker/
  mysql-init/            Scripts que corren solo al inicializar el volumen de MySQL
docker-compose.yml     Contenedor de MySQL para desarrollo
```
