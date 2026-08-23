-- Se ejecuta solo la primera vez que el contenedor inicializa su volumen de datos.
--
-- El usuario de la app (creado por las variables MYSQL_USER/MYSQL_PASSWORD de la
-- imagen oficial) solo recibe privilegios sobre su propia base (`tiendaya`.*).
-- Prisma Migrate necesita además crear, poblar (migraciones con backfill vía UPDATE)
-- y borrar una "shadow database" temporal para calcular el diff y validar el
-- historial de cada migración (`prisma migrate dev`). Sin estos grants falla con:
--   P3014 al crear la shadow db (falta CREATE/DROP)
--   P3006/1142 "ALTER command denied" al re-aplicar migraciones con ALTER TABLE ahí
--   P3006/1142 "UPDATE command denied" si alguna migración incluye backfill de datos
--
-- CREATE/DROP quedan a nivel global porque la shadow database todavía no existe
-- en el momento en que hace falta el permiso (no se le puede otorgar un privilegio
-- "dentro" de una base que aún no fue creada). El resto de privilegios (DDL + DML)
-- se limita únicamente a bases que calcen con el patrón de nombre que usa Prisma
-- para la shadow database — no a nivel global — para no darle a este usuario poder
-- sobre bases de datos no relacionadas.
-- Ver IA/ADR-001-stack-y-migraciones.md, notas de implementación.
GRANT CREATE, DROP ON *.* TO 'tiendaya'@'%';
GRANT ALL PRIVILEGES ON `prisma_migrate_shadow_db_%`.* TO 'tiendaya'@'%';
FLUSH PRIVILEGES;
