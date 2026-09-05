-- Guarda el envío pendiente dentro de la misma transacción MySQL del checkout.
-- Los importes del payload son strings decimales, sin conversión a flotantes.
CREATE TABLE `venta_outbox` (
    `detalle_id` INTEGER NOT NULL,
    `payload` JSON NOT NULL,
    `creado_en` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `procesado_en` DATETIME(3) NULL,
    `intentos` INTEGER NOT NULL DEFAULT 0,
    `proximo_intento` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `ultimo_error` TEXT NULL,

    INDEX `venta_outbox_procesado_en_proximo_intento_detalle_id_idx` (`procesado_en`, `proximo_intento`, `detalle_id`),
    PRIMARY KEY (`detalle_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
