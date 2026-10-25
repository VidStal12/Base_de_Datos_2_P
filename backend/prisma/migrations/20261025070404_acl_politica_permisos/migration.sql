-- Permisos de la API editables desde /admin/permisos (IA/ADR-007 §9). La política base vive en el
-- código (config/politicaRutas.js); esta tabla guarda solo las DIFERENCIAS por rol y ruta, con quién
-- las cambió y cuándo. Borrar un rol borra sus reglas; borrar al autor deja la regla (autor NULL).

-- CreateTable
CREATE TABLE `acl_regla` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `rol_id` INTEGER NOT NULL,
    `ruta` VARCHAR(200) NOT NULL,
    `permitido` BOOLEAN NOT NULL,
    `actualizado_por` INTEGER NULL,
    `actualizado_en` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `acl_regla_ruta_idx`(`ruta`),
    UNIQUE INDEX `acl_regla_rol_id_ruta_key`(`rol_id`, `ruta`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `acl_regla` ADD CONSTRAINT `acl_regla_rol_id_fkey` FOREIGN KEY (`rol_id`) REFERENCES `rol_usuario`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `acl_regla` ADD CONSTRAINT `acl_regla_actualizado_por_fkey` FOREIGN KEY (`actualizado_por`) REFERENCES `usuarios`(`id_usuario`) ON DELETE SET NULL ON UPDATE CASCADE;
