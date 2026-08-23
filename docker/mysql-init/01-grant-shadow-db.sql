-- Se ejecuta solo la primera vez que el contenedor inicializa su volumen de datos.
--
-- El usuario de la app (creado por las variables MYSQL_USER/MYSQL_PASSWORD de la
-- imagen oficial) solo recibe privilegios sobre su propia base (`tiendaya`.*).
-- Prisma Migrate necesita además crear y borrar una "shadow database" temporal
-- para calcular el diff de cada migración (`prisma migrate dev`), lo que requiere
-- CREATE/DROP a nivel global. Sin este grant, la migración falla con el error
-- P3014 ("Prisma Migrate could not create the shadow database").
-- Ver IA/ADR-001-stack-y-migraciones.md, notas de implementación.
GRANT CREATE, DROP ON *.* TO 'tiendaya'@'%';
FLUSH PRIVILEGES;
