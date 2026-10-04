-- Constancia del compromiso de no reventa (ver compromisoService.js).
-- Nullable a propósito: los pedidos existentes — y todos los de cuentas que no
-- venden — no tienen compromiso, y no hay forma de reconstruir uno que nunca
-- se pidió. NO se rellena con la fecha del pedido: eso fabricaría una
-- aceptación que el usuario jamás dio.

-- AlterTable
ALTER TABLE `compra` ADD COLUMN `no_reventa_aceptada_en` DATETIME(3) NULL;
