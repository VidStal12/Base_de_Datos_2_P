# Demostración de fallos parciales durante el checkout

Implementado el 2026-10-20 para el checkout normal (`POST /api/checkout`).
Complementa las pruebas por inyección de `backend/scripts/demo_consistencia_compra.js`
con una pausa para detener una base real desde Docker y observar la respuesta en la web.

## Configuración

Añadir o ajustar en `backend/.env` y reiniciar el backend:

```env
CHECKOUT_DEMO_ENABLED=true
CHECKOUT_DEMO_PAUSE_AT=after_commit_before_redis
CHECKOUT_DEMO_PAUSE_MS=15000
```

La espera es asíncrona, configurable entre 1 y 60000 ms. El valor predeterminado es
15000 ms y la etapa predeterminada es `after_commit_before_redis`. Solo se activa
con `CHECKOUT_DEMO_ENABLED=true`; se ignora con `NODE_ENV=production`. No hay un
parámetro HTTP para activarla. Afecta a las compras normales nuevas que lleguen a
esa etapa, por lo que conviene hacer la demostración con una sola compra a la vez.
Los reenvíos de un intento confirmado recuperan el pedido sin repetir la pausa.

Ambos puntos de pausa están fuera de la transacción MySQL: no mantienen locks
durante la espera. El log `[checkout-demo] PAUSA` incluye etapa, duración, usuario,
intento y, después del commit, el pedido; `[checkout-demo] CONTINÚA` indica el final.

## Escenario principal: Redis cae después del commit

1. Iniciar los servicios y el backend/frontend como de costumbre. Usar un comprador
   con dirección y método de pago guardados, y un carrito con stock suficiente.
2. Anotar el stock inicial en MySQL y los productos/cantidades del carrito.
3. Entrar al checkout y confirmar el pedido. Esperar en la consola del backend:

   ```text
   [checkout-demo] PAUSA {"etapa":"after_commit_before_redis", ...}
   ```

4. Durante los 15 segundos de pausa, ejecutar desde la raíz del proyecto:

   ```powershell
   docker compose stop redis
   ```

5. Mantener Redis detenido hasta recibir la respuesta. El pedido ya estaba confirmado
   en MySQL antes de la pausa. La invalidación de Redis falla, pero la respuesta
   sigue siendo un éxito (`201`), con `compra`, `pago` y:

   ```json
   {
     "advertencias": [{
       "codigo": "CARRITO_CACHE_PENDIENTE",
       "mensaje": "Tu pedido quedó confirmado. Al confirmar la compra, no pudimos actualizar el carrito. No necesitás repetir la compra. Si todavía ves los productos comprados, entrá al checkout para actualizar el carrito."
     }]
   }
   ```

6. La web abre el pedido y muestra el aviso junto con su confirmación. El carrito
   local se limpia. MySQL conserva un pedido, un pago aprobado, el descuento de
   stock y el carrito durable vacío. Los reenvíos a Mongo y Neo4j continúan.
7. Restaurar Redis:

   ```powershell
   docker compose start redis
   ```

8. Si reaparece una copia antigua del carrito, entrar al checkout para reconstruirla
   desde MySQL. Su TTL también limita su vigencia a 450 segundos sin renovación.
   Restaurar Redis por sí solo no garantiza que se haya invalidado esa copia.
9. Para demostrar idempotencia, repetir la solicitud capturada de `POST /api/checkout`
   con **el mismo intentoId y los mismos datos**. Debe responder `200`, recuperar
   el mismo pedido y no volver a descontar stock ni crear otro pago. No preparar
   una compra nueva para esta comprobación.

Los tiempos de Redis ya estaban acotados por la capa de resiliencia: timeout de
comando de 1500 ms, un reintento por solicitud y rechazo inmediato de comandos
nuevos cuando el cliente está reconectando. La pausa de demostración se suma
deliberadamente al tiempo de respuesta.

El aviso se devuelve aunque la demo esté desactivada: depende del fallo real de la
invalidación. Se intenta guardarlo en `checkout_intento.respuesta` para recuperarlo
al reenviar o consultar el intento. Si MySQL deja de responder en ese momento, el
aviso sigue en la respuesta original, pero su persistencia no está garantizada.
Ese fallo informativo no revierte ni rechaza la compra ya confirmada.

## Segundo escenario: MySQL cae antes de abrir la transacción

Cambiar esta variable y reiniciar el backend:

```env
CHECKOUT_DEMO_PAUSE_AT=before_transaction
```

1. Con todas las bases arriba, preparar el carrito y confirmar.
2. Esperar el log `[checkout-demo] PAUSA` con la etapa `before_transaction`.
3. Durante la pausa, ejecutar desde la raíz:

   ```powershell
   docker compose stop mysql
   ```

4. Al continuar, la apertura de la transacción falla. No se escriben pedido, pago,
   outbox ni cambios de inventario/carrito de esa compra. El intento preparado
   previamente sigue siendo el mismo.
5. La ruta responde `503 CHECKOUT_INCIERTO` y la interfaz comunica:

   > No pudimos verificar tu compra. Conservamos el intento: volvé a intentarlo para consultar su resultado sin duplicar el pedido.

6. Restaurar MySQL con `docker compose start mysql`, esperar a que esté sano y
   volver a confirmar **el mismo intento**. La pausa seguirá activa mientras no
   cambie la configuración; esta vez dejar que termine sin detener MySQL.

Aunque en esta etapa sabemos que todavía no se abrió la transacción, el manejo de
conexión del endpoint también cubre una caída cerca del COMMIT: en ese caso no se
puede afirmar que la compra falló. Por eso se conserva el intento y se consulta o
reenvía antes de decidir preparar otra compra. Durante una caída prolongada puede
actuar la recuperación de intentos vencidos (15 minutos); si el intento pasa a
fallido, la interfaz permitirá preparar otro después de verificar su estado.

## Evidencia para la entrega

Guardar para cada escenario:

- Captura del log de pausa/continuación y del contenedor detenido.
- Captura del mensaje visible en la web.
- Respuesta HTTP y el `intentoId` empleado (sin el token de autenticación).
- Estado MySQL antes/después: stock, pedido, pago y carrito de ese usuario.
- Reenvío del mismo intento y comprobación de que no se duplicó la compra.
- Recuperación tras iniciar el contenedor.

No confundir una prueba que lanza un error con una interrupción real del motor.
`mysql-dentro` del script anterior provoca falta de stock dentro de una transacción;
esta demo permite detener el contenedor MySQL en una etapa seleccionada.

## Verificación automatizada y límites

Ejecutar en `backend`:

```powershell
npm run test:checkout
npm run test:redis
npm run test:resiliencia
```

Verificado el 2026-10-20: 29 pruebas de checkout, 35 de carrito/ofertas y 49 de
resiliencia aprobadas (113 en total). En `frontend`, `npm run build` pasó y
`npm run lint` terminó sin errores, con advertencias preexistentes.

Las pruebas nuevas cubren caída de Redis después del commit, caída de MySQL antes
de la transacción, conservación/recuperación del aviso, reenvíos sin doble compra,
modo normal y activación/validación de la pausa. Usan dobles de las dependencias;
no constituyen evidencia de una caída real en Docker ni una verificación visual
del navegador.

La ejecución real con contenedores quedó pendiente: durante la implementación el
motor de Docker Desktop no estaba disponible (`dockerDesktopLinuxEngine` ausente).
Los pasos anteriores describen el comportamiento esperado que debe registrarse al
hacer la demostración, no una ejecución que se haya observado aquí.

Al terminar, restaurar los servicios y establecer `CHECKOUT_DEMO_ENABLED=false`
en `backend/.env`; reiniciar el backend.
