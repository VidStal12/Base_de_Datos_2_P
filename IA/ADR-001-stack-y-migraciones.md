# ADR-001 — Stack tecnológico y estrategia de migraciones (Fase Inicial)

**Fecha:** 2026-08-22
**Estado:** Stack confirmado por el equipo · herramienta de ORM/migraciones recomendada, pendiente de ratificar

---

## Contexto

Para la Fase Inicial el equipo definió:

- **Backend:** Node.js con JavaScript (sin TypeScript)
- **Frontend:** React
- **Base relacional:** MySQL, ejecutado en un contenedor Docker
- **Acceso a datos:** un ORM (decisión ya tomada por el equipo; queda por elegir cuál)

El PRD exige (§5, Fase Inicial) un esquema normalizado en 3FN con **DDL versionado en el repositorio** y un **checkout implementado como transacción atómica** (pedido + líneas + pago + descuento de inventario). Al vivir MySQL en un contenedor, el equipo necesita evolucionar el esquema (crear/alterar tablas) de forma reproducible — sin ejecutar `ALTER TABLE` a mano dentro del contenedor — y que ese historial de cambios quede versionado junto con el código.

## Alternativas consideradas

| Opción | Migraciones | Encaja con JS puro | Infraestructura extra | Notas |
|---|---|---|---|---|
| **Prisma** (`prisma migrate`) | Autogeneradas: Prisma calcula el diff entre `schema.prisma` y la base, y genera el SQL versionado en `/prisma/migrations` | Sí — el cliente funciona en JS plano (se pierde autocompletado de tipos, no funcionalidad) | Requiere una "shadow database" para calcular diffs en desarrollo; con un contenedor propio y usuario con permisos de administración se crea y destruye sola | Mejor documentación/DX del momento; casi no se escribe SQL a mano |
| **Sequelize** (+ `sequelize-cli`) | Se escriben a mano (`queryInterface.createTable`, etc.), versionadas como archivos JS con `up`/`down` | Sí — es el ORM "nativo" de JS en Node desde hace más de una década | Ninguna | Incluye *seeders* de fábrica (encaja con "datos de prueba representativos" del PRD); API de transacciones simple |
| **Knex.js + Objection.js** | Knex maneja migraciones/seeds (JS); Objection aporta el modelo ORM encima | Sí | Ninguna | Dos librerías separadas que integrar; más control, más configuración manual |
| **TypeORM** | CLI de migraciones, pero el modelo de entidades está pensado para decoradores de TypeScript | Incómodo en JS puro (hay que usar `EntitySchema` en vez de decoradores) | Ninguna | Descartado: el equipo eligió explícitamente JavaScript, no TypeScript |
| **Drizzle ORM** | `drizzle-kit` genera SQL versionado a partir del esquema | Funciona en JS, pero su ventaja principal (inferencia de tipos) es sobre TypeScript | Ninguna | Muy joven para apoyarse en un proyecto de curso; comunidad/documentación menor que Prisma o Sequelize |
| **SQL crudo sin ORM** (línea base) | Migraciones manuales con algún runner (p. ej. `db-migrate`) o scripts `.sql` numerados a mano | Sí | Ninguna | Contradice la decisión ya tomada de usar un ORM; se incluye solo como referencia de "no cambiar la práctica actual" |

## Decisión

Se recomienda **Prisma** (`@prisma/client` + `prisma migrate`) como ORM y herramienta de migraciones para la Fase Inicial, con **Sequelize + sequelize-cli** como alternativa igualmente válida si el equipo prefiere escribir cada migración a mano en vez de generarla por diff.

## Justificación

- **Es, literalmente, lo que se describió necesitar:** una herramienta que "haga las migraciones sin tener que cambiar la estructura a mano" — eso es `prisma migrate dev`: se edita `schema.prisma` (un archivo declarativo, único punto de verdad) y Prisma calcula y genera el SQL de la migración; no se escribe `ALTER TABLE` manualmente.
- **El archivo de migración resultante es SQL plano**, versionado en `/prisma/migrations`, lo que satisface de forma literal el requisito del PRD de "DDL versionado" — es DDL real y legible, no una capa intermedia.
- **El contenedor es propio, sin restricciones de permisos:** la "shadow database" que Prisma necesita para calcular diffs en desarrollo se crea y destruye sola cuando el usuario de MySQL tiene permisos de administración — el caso típico de un contenedor propio en `docker-compose` con usuario root. La fricción que esa pieza añade en entornos gestionados (bases compartidas en la nube, sin permisos de CREATE DATABASE) no aplica aquí.
- **Funciona sin TypeScript:** el cliente generado se importa y usa igual en JS plano; se pierde autocompletado de tipos, no funcionalidad.
- **Transacciones:** `prisma.$transaction([...])` cubre directamente el checkout atómico (pedido + líneas + pago + descuento de inventario) exigido en la Fase Inicial.

Si el equipo prefiere no depender de un motor de diff automático y quiere control línea por línea sobre cada cambio de esquema (o ya tiene experiencia previa con Sequelize), **Sequelize + sequelize-cli** es la alternativa recomendada: incluye *seeders* versionados de fábrica (relevante para "datos de prueba representativos"), transacciones igual de directas (`sequelize.transaction()`), y una década de tutoriales específicos para exactamente esta combinación (Node + MySQL + Docker).

No se recomienda TypeORM (fricción con JS puro) ni Drizzle (comunidad/madurez todavía menor para apoyar un proyecto de curso con plazos fijos).

## Consecuencias

**Beneficios:**
- Historial de cambios de esquema versionado y reproducible junto al código (el log de `/migrations` documenta la evolución del modelo).
- No se requiere ejecutar comandos manuales dentro del contenedor de MySQL para cambiar la estructura.
- Ambas opciones recomendadas soportan transacciones atómicas nativas para el flujo de checkout.

**Limitaciones asumidas:**
- Con Prisma, el equipo debe revisar el SQL autogenerado antes de aplicarlo — `prisma migrate dev` puede proponer una migración destructiva si detecta un cambio ambiguo (p. ej. interpretar el renombrado de una columna como "borrar columna + crear columna nueva").
- Con Sequelize, cada cambio de esquema exige escribir a mano el par `up`/`down`, lo que es más trabajo manual pero da control total.
- Ninguna de las dos opciones fue probada aún contra el contenedor real de MySQL del equipo; se recomienda validar con una migración simple (p. ej. crear `usuarios`) antes de construir el esquema completo del PRD.

**Pendiente:**
- Que el equipo ratifique Prisma vs. Sequelize.
- Definir el framework HTTP del backend (Express, Fastify, etc.), que todavía no se ha especificado.
