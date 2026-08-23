-- `prisma migrate dev` no pudo generar esto de forma no interactiva: cualquier
-- constraint que "podría fallar si hay duplicados" (aunque ya se verificó que no
-- los hay) dispara un prompt de confirmación que no tiene sentido en un shell
-- no interactivo, y el CLI se niega a continuar en vez de asumir una respuesta.
-- Se escribió a mano y se aplicó con `prisma migrate deploy` (no interactivo).

-- CreateIndex
CREATE UNIQUE INDEX `atributo_producto_id_producto_id_atributo_categoria_key` ON `atributo_producto`(`id_producto`, `id_atributo_categoria`);
