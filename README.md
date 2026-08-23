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

También se puede probar vía HTTP una vez cargado el seed:

```bash
curl -X POST http://localhost:3000/api/checkout \
  -H "Content-Type: application/json" \
  -d '{"usuarioId":1,"direccionId":1,"metodoPagoId":1,"items":[{"productoId":1,"cantidad":2}]}'
```

(Los IDs asumen una base recién sembrada; ajustar según lo que devuelva `npm run seed`.)

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
