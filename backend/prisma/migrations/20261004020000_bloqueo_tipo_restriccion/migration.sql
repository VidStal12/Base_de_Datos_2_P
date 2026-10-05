-- Respuesta escalonada (ver bloqueoService.js): además de la suspensión (hallazgo
-- de confianza alta) hay una restricción suave (hallazgo «posible»). Las filas que
-- ya existen son todas suspensiones, que es el valor por omisión de la columna.

-- AlterTable
ALTER TABLE `bloqueo_cuenta` ADD COLUMN `tipo` VARCHAR(12) NOT NULL DEFAULT 'suspension';

-- El único pasa a incluir el tipo: un hallazgo «posible» y, más tarde, el mismo
-- hallazgo corroborado como «alta» son dos casos distintos de la misma cuenta.
-- El índice nuevo se crea ANTES de quitar el viejo: la clave foránea sobre
-- id_usuario necesita un índice que empiece por esa columna en todo momento.
CREATE UNIQUE INDEX `bloqueo_cuenta_id_usuario_huella_tipo_key` ON `bloqueo_cuenta`(`id_usuario`, `huella`, `tipo`);

-- DropIndex
DROP INDEX `bloqueo_cuenta_id_usuario_huella_key` ON `bloqueo_cuenta`;
