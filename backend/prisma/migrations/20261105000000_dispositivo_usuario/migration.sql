-- Dispositivos desde los que cada cuenta inició sesión o se registró (ver dispositivoService.js e
-- IA/PLAN-NEO4J-DETECCION-FRAUDE.md §22). Es el registro durable del que se reconstruye el grafo de fraude
-- (`npm run fraude:backfill`) y reemplaza al nombre como vínculo entre cuentas: dos personas pueden llamarse
-- igual, pero compartir el mismo navegador es otra cosa.
-- Solo se guardan SHA-256: del identificador aleatorio que genera el navegador (dispositivo_hash) y de rasgos
-- gruesos del equipo (perfil_hash); nunca el identificador en claro.

-- CreateTable
CREATE TABLE `dispositivo_usuario` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `id_usuario` INTEGER NOT NULL,
    `dispositivo_hash` CHAR(64) NOT NULL,
    `perfil_hash` CHAR(64) NULL,
    `etiqueta` VARCHAR(60) NULL,
    `primera_vez` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `ultima_vez` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `inicios` INTEGER NOT NULL DEFAULT 1,

    INDEX `dispositivo_usuario_dispositivo_hash_idx`(`dispositivo_hash`),
    INDEX `dispositivo_usuario_perfil_hash_idx`(`perfil_hash`),
    UNIQUE INDEX `dispositivo_usuario_id_usuario_dispositivo_hash_key`(`id_usuario`, `dispositivo_hash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `dispositivo_usuario` ADD CONSTRAINT `dispositivo_usuario_id_usuario_fkey` FOREIGN KEY (`id_usuario`) REFERENCES `usuarios`(`id_usuario`) ON DELETE CASCADE ON UPDATE CASCADE;
