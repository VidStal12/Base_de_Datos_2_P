-- Escrita a mano y aplicada con `prisma migrate deploy` (no interactivo) —
-- mismo motivo que 20260823022413_atributo_producto_unique: un DROP TABLE es
-- exactamente el tipo de cambio "irreversible" que dispara un prompt de
-- confirmación en `prisma migrate dev` que no tiene sentido en un shell no
-- interactivo.
--
-- Borra el catálogo relacional que quedó vestigial tras la migración a
-- MongoDB de Entrega 1 (ver IA/ADR-002): categoria, subcategoria,
-- atributo_categoria, atributo_producto, categoria_producto, y las columnas
-- descripcion/imagen_url/estado de producto. Ningún código vivo las leía ni
-- las escribía (categoriaService.js ya estaba 100% contra Mongo; el último
-- escritor de las columnas de producto se sacó de productoService.js el
-- 2026-08-29) — mantenerlas era inercia, no necesidad. producto en sí NO se
-- borra: sigue siendo el ancla de FK de inventario/compra_detalle/carrito.
--
-- Orden de DROP: las tablas que referencian a otras van primero
-- (atributo_producto/categoria_producto → atributo_categoria/subcategoria →
-- categoria), para no violar sus propias foreign keys al borrarlas.

-- DropForeignKey (implícito en el DROP TABLE de abajo, MySQL las borra junto
-- con la tabla que las declara)

-- DropTable
DROP TABLE `atributo_producto`;

-- DropTable
DROP TABLE `categoria_producto`;

-- DropTable
DROP TABLE `atributo_categoria`;

-- DropTable
DROP TABLE `subcategoria`;

-- DropTable
DROP TABLE `categoria`;

-- AlterTable
ALTER TABLE `producto` DROP COLUMN `descripcion`, DROP COLUMN `imagen_url`, DROP COLUMN `estado`;
