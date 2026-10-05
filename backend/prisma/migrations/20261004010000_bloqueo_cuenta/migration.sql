-- Casos de suspensión temporal de cuentas por fraude de confianza alta (ver
-- bloqueoService.js). Registro durable: el bloqueo que se hace cumplir vive en
-- Redis con TTL y esta tabla permite reconstruirlo y auditar quién decidió qué.
-- (id_usuario, huella) único: un hallazgo suspende a una cuenta una sola vez.

-- CreateTable
CREATE TABLE `bloqueo_cuenta` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `id_usuario` INTEGER NOT NULL,
    `huella` VARCHAR(160) NOT NULL,
    `senal` VARCHAR(40) NOT NULL,
    `origen` VARCHAR(12) NOT NULL DEFAULT 'automatico',
    `motivo` TEXT NOT NULL,
    `evidencia` JSON NULL,
    `estado` VARCHAR(12) NOT NULL DEFAULT 'activo',
    `creado_en` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expira_en` DATETIME(3) NOT NULL,
    `revisado_por` INTEGER NULL,
    `revisado_en` DATETIME(3) NULL,
    `nota_revision` VARCHAR(500) NULL,

    INDEX `bloqueo_cuenta_estado_expira_en_idx`(`estado`, `expira_en`),
    UNIQUE INDEX `bloqueo_cuenta_id_usuario_huella_key`(`id_usuario`, `huella`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `bloqueo_cuenta` ADD CONSTRAINT `bloqueo_cuenta_id_usuario_fkey` FOREIGN KEY (`id_usuario`) REFERENCES `usuarios`(`id_usuario`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `bloqueo_cuenta` ADD CONSTRAINT `bloqueo_cuenta_revisado_por_fkey` FOREIGN KEY (`revisado_por`) REFERENCES `usuarios`(`id_usuario`) ON DELETE SET NULL ON UPDATE CASCADE;
