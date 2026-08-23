-- Prisma generó esta migración marcándola como "no ejecutable" porque agrega una
-- columna NOT NULL a una tabla con filas existentes. Se edita a mano siguiendo el
-- patrón estándar para este caso: agregar nullable, rellenar, y recién ahí exigir NOT NULL.
--
-- El backfill usa el vendedor sembrado por el seed (Luis, id_usuario=2) como dueño
-- de los productos creados antes de que existiera esta columna.

-- AlterTable (nullable por ahora)
ALTER TABLE `producto` ADD COLUMN `id_vendedor` INTEGER NULL;

-- Backfill de filas existentes
UPDATE `producto` SET `id_vendedor` = 2 WHERE `id_vendedor` IS NULL;

-- Ahora sí, exigir NOT NULL
ALTER TABLE `producto` MODIFY COLUMN `id_vendedor` INTEGER NOT NULL;

-- AddForeignKey
ALTER TABLE `producto` ADD CONSTRAINT `producto_id_vendedor_fkey` FOREIGN KEY (`id_vendedor`) REFERENCES `usuarios`(`id_usuario`) ON DELETE RESTRICT ON UPDATE CASCADE;
