-- Consolida las posibles filas repetidas anteriores a usar el carrito SQL.
CREATE TEMPORARY TABLE carrito_consolidado AS
SELECT MIN(id) AS id, SUM(cantidad) AS cantidad
FROM carrito GROUP BY id_usuario, id_producto;

UPDATE carrito c JOIN carrito_consolidado consolidado ON consolidado.id = c.id
SET c.cantidad = consolidado.cantidad;

DELETE c FROM carrito c LEFT JOIN carrito_consolidado consolidado ON consolidado.id = c.id
WHERE consolidado.id IS NULL;

DROP TEMPORARY TABLE carrito_consolidado;
CREATE UNIQUE INDEX carrito_id_usuario_id_producto_key ON carrito(id_usuario, id_producto);
