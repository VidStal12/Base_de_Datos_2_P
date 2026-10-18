# Checkout normal y flash: compras idempotentes

Implementado y verificado el 2026-10-17.

## El problema y la protección anterior

MySQL puede confirmar un pedido y vaciar su carrito, pero perderse la respuesta antes de llegar al navegador. La interfaz conserva entonces los productos en memoria. Antes de este cambio, reenviar esos productos podía crear otro pedido porque el checkout no comprobaba que siguieran en el carrito.

El frontend ya deshabilitaba el botón mientras confirmaba e intentaba refrescar el carrito ante errores. Eso reduce el doble clic, pero no resuelve respuestas perdidas, dos ventanas ni solicitudes que ya están en camino. Un bloqueo de filas o un descuento atómico evita sobreventa, pero no distingue dos compras intencionales de un reenvío accidental.

## Identificar la intención antes de confirmar

`checkoutIntentoService.js` prepara un UUID durable en MySQL. Las rutas HTTP de compra normal y flash requieren `intentoId`; omitirlo no permite usar el camino anterior. Los scripts internos que llaman directamente a los servicios sin intento conservan su comportamiento previo, útil para pruebas de inventario y reglas de negocio; no están protegidos contra reenvíos de compra.

- **Normal:** `POST /api/checkout/intentos` devuelve el intento asociado al usuario y a `usuarios.carrito_version`. Contiene un snapshot de productos, cantidades y precios esperados. Agregar, eliminar, vaciar o cambiar cantidades incrementa la versión dentro de la misma transacción y con el mismo bloqueo del usuario. Confirmar comprueba esa versión bajo el bloqueo. Dos ventanas que preparan la misma versión reciben el mismo UUID.
- **Flash:** `POST /api/ofertas/:productoId/intentos` devuelve el intento activo del usuario para esa revisión de la promoción. Reabrir una promoción ya comprada muestra el pedido anterior y una opción explícita para preparar otra compra. La renovación envía `anteriorIntentoId`: dos ventanas que renuevan a la vez reciben el mismo intento nuevo.
- **Consultar:** `GET /api/checkout/intentos/:id` devuelve estado y pedido asociado únicamente al propietario. Consultar una compra confirmada no depende del carrito, MongoDB ni del cupo restante.
- **Revisar/cancelar:** `POST /api/checkout/intentos/:id/cancelar` comprueba el estado con el bloqueo transaccional antes de cerrar un pendiente. Si se confirmó mientras se solicitaba revisar, devuelve el estado completado y la interfaz abre ese pedido.

`sessionStorage` conserva el identificador tras una recarga. La sesión de MySQL, no el almacenamiento del navegador, comparte el UUID entre ventanas. Si no se puede consultar el estado por una caída de red/MySQL, no se crea otra compra automáticamente.

Una huella de los datos impide usar un intento confirmado o una reserva ya vinculada con otra dirección, método de pago, cantidad, precio esperado o aceptación del compromiso. No se guarda la contraseña. Una compra adicional intencional requiere un intento nuevo.

## Confirmación atómica en MySQL

La transacción bloquea al usuario, vuelve a leer el intento y verifica su estado. Si ya está completado, devuelve la respuesta almacenada. Si está fallido, no lo vuelve a ejecutar.

Para un intento pendiente, la misma transacción descuenta inventario, crea pedido/detalles/pago y guarda `estado = completado`, `compra_id` y la respuesta JSON. En el checkout normal también vacía el carrito e incrementa su versión.

Si el proceso cae antes del COMMIT, se revierten esos cambios. Si cae después, el pedido y el resultado del intento ya existen juntos. El reenvío devuelve ese resultado sin ejecutar de nuevo los incrementos de MongoDB ni el envío a Neo4j. La primera confirmación responde 201; recuperar el resultado responde 200 y no consume otro pedido de la cuota por hora.

## Reserva y compensación flash

Antes de tocar Redis se persiste en MySQL el plan de reserva: identificador, cantidad, precio promocional, vencimiento y clave del cupo. La clave es `oferta:{id}:stock:{revision}` en promociones configuradas desde este cambio; las ofertas anteriores sin revisión conservan su clave antigua hasta reconfigurarse.

El script Lua `reservarOfertaIdempotente` comprueba/descuenta cupo y registra `checkout:reserva:{intentoId}` en una sola ejecución. Una segunda llamada con esa reserva no descuenta otra vez. La reserva se mantiene hasta un día después del fin de la oferta; el contador vence al terminar la promoción.

Si falla la compra, se vuelve a adquirir el bloqueo de MySQL antes de compensar. Si el COMMIT sí ocurrió, se devuelve el pedido y no se devuelve cupo. Si no ocurrió, se marca el intento fallido y se intenta la devolución. `devolverReservaOferta` devuelve cada reserva una sola vez, conserva una marca de cancelación para llamadas retrasadas y no recrea un contador vencido. La clave por revisión evita que una devolución antigua modifique una promoción reconfigurada.

Si MySQL no permite resolver el resultado, se conserva el intento y la reserva; no se compensa a ciegas. Si Redis falla durante la devolución, MySQL conserva `compensado = false` para recuperarla.

El worker del backend revisa cada 30 segundos las compensaciones pendientes y los intentos que llevan 15 minutos pendientes. Antes de cancelar un intento abandonado vuelve a comprobar su estado y antigüedad bajo el mismo bloqueo: no compensa una compra que otra transacción todavía pueda confirmar. Un intento cerrado permite preparar otro explícitamente.

## Límites de la garantía

- La idempotencia protege un mismo intento, no prohíbe comprar dos veces el mismo producto con intenciones distintas.
- La identidad y el pedido confirmado son durables en MySQL. Una caída de MySQL impide confirmar/consultar hasta su recuperación.
- Redis sigue siendo el almacén transitorio del cupo. Perder sus datos puede reinicializar el cupo promocional; esto no agrega persistencia ni alta disponibilidad a Redis. MySQL sigue limitando el inventario real.
- Las copias de catálogo de MongoDB y el grafo de Neo4j siguen siendo de mejor esfuerzo. La idempotencia de la compra no agrega una cola de entrega para esos destinos; el recálculo del catálogo y el backfill del grafo siguen siendo sus mecanismos de reparación.
- El pago sigue siendo un registro aprobado dentro de MySQL, sin cobro externo. Una futura pasarela necesitará su propia clave de idempotencia.

## Verificación

Desde `backend/`:

```sh
npm run prisma:generate
npm run prisma:deploy
npm run test:checkout
npm run verificar:idempotencia
```

La prueba de integración usa Express/JWT y las bases locales reales. Crea cuentas y producto sintéticos propios y limpia sus pedidos, intentos, producto y claves al finalizar. No detiene contenedores ni toca carritos o pedidos preexistentes.

Evidencia observada:

| Escenario | Resultado |
|---|---|
| Dos preparaciones normales y dos confirmaciones simultáneas | Un UUID, un pedido, un descuento |
| Cambiar el carrito con una pantalla anterior abierta | 409 `CHECKOUT_CARRITO_CAMBIO` |
| COMMIT real confirmado con respuesta simulada como perdida | Primera respuesta 503; reenvío 200 con el pedido existente |
| Dos preparaciones/confirmaciones flash simultáneas | Un pedido y un solo cupo consumido |
| Stock MySQL insuficiente después de reservar cupo | Intento fallido; devolución sin duplicación al repetirla |
| Interrupción después de reservar Redis y antes de comprar | Reanudar no descuenta otro cupo |
| Diez reservas y devoluciones simultáneas con el Lua real | Un descuento y una devolución |
| Datos diferentes o consulta desde otra cuenta | Rechazo sin crear otro pedido |

Las pruebas aisladas también cubren rollback antes del COMMIT, compensación pendiente con Redis caído, recuperación por el worker, protección de las rutas HTTP y conservación del intento en el navegador cuando no hay conexión.
