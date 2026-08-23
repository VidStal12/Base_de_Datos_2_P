-- Mismo patrón de 3 pasos que la migración anterior (add_producto_vendedor):
-- agregar nullable, rellenar, exigir NOT NULL. Las filas existentes son todas
-- de pruebas de desarrollo, así que se backfillean con 1 — no hay forma
-- confiable de reconstruir la cantidad real (el precio del producto pudo haber
-- cambiado desde que se generó cada compra_detalle de prueba).

-- AlterTable (nullable por ahora)
ALTER TABLE `compra_detalle` ADD COLUMN `cantidad` INTEGER NULL;

-- Backfill de filas existentes
UPDATE `compra_detalle` SET `cantidad` = 1 WHERE `cantidad` IS NULL;

-- Ahora sí, exigir NOT NULL
ALTER TABLE `compra_detalle` MODIFY COLUMN `cantidad` INTEGER NOT NULL;
