-- Modelo de lectura para ventas: cada fila representa un detalle ya pagado.
-- No se copian usuarios, direcciones ni instrumentos de pago a Cassandra.
-- El backend reutiliza este archivo y sustituye el keyspace/datacenter con su
-- configuración. También puede ejecutarse con cqlsh para los valores locales.
CREATE KEYSPACE IF NOT EXISTS tiendaya_analytics
WITH replication = {'class': 'NetworkTopologyStrategy', 'datacenter1': 1};

-- Una partición por día permite leer intervalos acotados sin ALLOW FILTERING.
-- fecha_venta + detalle_id identifica la línea: repetir un INSERT la reemplaza
-- y nunca suma dos veces las unidades, a diferencia de utilizar counters.
CREATE TABLE IF NOT EXISTS tiendaya_analytics.ventas_por_dia (
  dia date,
  fecha_venta timestamp,
  detalle_id int,
  compra_id int,
  producto_id int,
  vendedor_id int,
  cantidad int,
  importe decimal,
  descuento decimal,
  PRIMARY KEY ((dia), fecha_venta, detalle_id)
) WITH CLUSTERING ORDER BY (fecha_venta ASC, detalle_id ASC);

-- La segunda proyección responde filtros por producto sin recorrer ventas de
-- otros productos. El mes acota el tamaño de cada partición; es su primer día.
CREATE TABLE IF NOT EXISTS tiendaya_analytics.ventas_por_producto_mes (
  producto_id int,
  mes date,
  fecha_venta timestamp,
  detalle_id int,
  compra_id int,
  vendedor_id int,
  cantidad int,
  importe decimal,
  descuento decimal,
  PRIMARY KEY ((producto_id, mes), fecha_venta, detalle_id)
) WITH CLUSTERING ORDER BY (fecha_venta ASC, detalle_id ASC);
