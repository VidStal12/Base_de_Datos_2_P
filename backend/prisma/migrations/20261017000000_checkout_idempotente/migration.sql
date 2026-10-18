ALTER TABLE `usuarios` ADD COLUMN `carrito_version` INTEGER NOT NULL DEFAULT 0;

CREATE TABLE `checkout_intento` (
  `id` VARCHAR(36) NOT NULL,
  `id_usuario` INTEGER NOT NULL,
  `ambito` VARCHAR(160) NOT NULL,
  `version_carrito` INTEGER NULL,
  `items` JSON NULL,
  `datos_hash` VARCHAR(64) NULL,
  `reserva` JSON NULL,
  `estado` VARCHAR(16) NOT NULL DEFAULT 'pendiente',
  `compra_id` INTEGER NULL,
  `respuesta` JSON NULL,
  `error` JSON NULL,
  `compensado` BOOLEAN NOT NULL DEFAULT false,
  `creado_en` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `actualizado_en` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `checkout_intento_compra_id_key` (`compra_id`),
  INDEX `checkout_intento_id_usuario_ambito_idx` (`id_usuario`, `ambito`),
  INDEX `checkout_intento_estado_actualizado_en_idx` (`estado`, `actualizado_en`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `checkout_sesion` (
  `id_usuario` INTEGER NOT NULL,
  `ambito` VARCHAR(160) NOT NULL,
  `intento_id` VARCHAR(36) NOT NULL,
  PRIMARY KEY (`id_usuario`, `ambito`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
