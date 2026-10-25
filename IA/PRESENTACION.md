# Guía de la presentación — TiendaYa (Entrega Final)

**Fecha:** 2026-10-25 · **Formato previsto:** 20 minutos y 7 de preguntas (se confirma con el catedrático el lunes 2026-10-26) · **Estado:** guía para el equipo. Lo que falta lo hace el equipo: las diapositivas finales, los videos de respaldo, los ensayos y el pre-mortem (sección 9). Los diagramas ya están exportados en [`img/`](img/).

## 1. La tesis

> **Seis bases, cada una con una pregunta propia; y cada copia, la garantía que su retraso justifica** ([ENTREGA-3 §3](ENTREGA-3-CONSISTENCIA.md)).

Se dice al empezar y se repite al cerrar. La presentación es una pirámide: la tesis; tres decisiones sustentadas con un número y tres replanteadas; tres demostraciones; y lo que se haría hoy. Cada diapositiva es una **afirmación** (el título) con su **evidencia** (el cuerpo), no un tema.

## 2. Mapa a la rúbrica (20 puntos)

| Criterio | Pts | Dónde se ve | Evidencia |
|---|---|---|---|
| Recomendación semántica | 5 | diapositiva 7 y demostración 2 | [ADR-006](ADR-006-recomendacion-semantica-vectorial.md); `npm run verificar:similares` |
| Control de acceso en un componente NoSQL | 4 | diapositivas 8 y 9, demostración 3 | [ADR-007](ADR-007-control-de-acceso.md); `npm run verificar:acceso` (92 comprobaciones), `verificar:permisos` (32) |
| Diagrama de arquitectura final | 3 | diapositivas 2, 3 y 5; respaldo con V3 y V4 | [ARQUITECTURA-FINAL](ARQUITECTURA-FINAL.md); `npm run test:arquitectura` |
| Retrospectiva | 4 | diapositivas 10 a 14 | [RETROSPECTIVA](RETROSPECTIVA.md) |
| Presentación: claridad y sustentar decisiones | 4 | todas, y el banco de preguntas | sección 7 |

## 3. Tiempos y reparto (20 minutos)

| Minuto | Diapositivas | Contenido | Quién |
|---|---|---|---|
| 0:00–4:30 | 1–3 | la tesis, V1 y V2a | A |
| 4:30–7:30 | 4 | **Demostración 1** — degradación | B |
| 7:30–10:00 | 5–7 | V2b, búsqueda y vectores — **Demostración 2** | C |
| 10:00–12:30 | 8–9 | control de acceso — **Demostración 3** | B |
| 12:30–15:30 | 10–12 | tres decisiones con número | A |
| 15:30–20:00 | 13–14 | lo que se replantea, la v2 y el mapa a la rúbrica | C |

Con dos integrantes: A = arquitectura, decisiones y retrospectiva; B = demostraciones, vectores y acceso. Con tres, A, B y C se asignan en el equipo. **Todos responden todo**: el historial de git concentra 59 de 72 commits en una cuenta y el jurado puede preguntarle a cualquiera sobre cualquier parte.

## 4. Las 14 diapositivas

| # | Título (la afirmación) | Evidencia en pantalla | Fuente | Qué se dice |
|---|---|---|---|---|
| 1 | Seis bases, cada una con una pregunta propia; cada copia, la garantía que su retraso justifica | la frase y la leyenda A/B/C/S/T/F/O en una línea | [ENTREGA-3 §3](ENTREGA-3-CONSISTENCIA.md) | «No es una colección de tecnologías: es una regla para decidir cuánto cuesta equivocarse.» |
| 2 | Tres almacenes guardan la verdad y tres guardan copias que se reconstruyen | V1 ([PNG](img/V1-contenedores.png)) | [ARQUITECTURA-FINAL §2](ARQUITECTURA-FINAL.md) | «MySQL, Mongo y el cupo de Redis son verdad; Elasticsearch, Cassandra y Neo4j se reconstruyen con un script.» |
| 3 | Cada flecha lleva su garantía: el pedido es una transacción y la venta del panel, un outbox | V2a ([PNG](img/V2a-escrituras-y-sincronizacion.png)) | [ARQUITECTURA-FINAL §3 y §7](ARQUITECTURA-FINAL.md) | «Una venta nunca se pierde ni se duplica en el panel; la señal de fraude puede llegar tarde, por eso es de mejor esfuerzo.» |
| 4 | Con cuatro de seis bases apagadas, el comprador sigue comprando | los tiempos del ensayo (sección 5) | [ENTREGA-3 §7](ENTREGA-3-CONSISTENCIA.md); ensayo del 2026-10-25 | demostración 1 |
| 5 | Cuando cae el almacén principal de una lectura, otro la sirve | V2b ([PNG](img/V2b-lecturas-con-respaldo.png)) | [ARQUITECTURA-FINAL §4](ARQUITECTURA-FINAL.md) | «Elasticsearch y Mongo se respaldan entre sí; los paneles no tienen respaldo porque son copias.» |
| 6 | La búsqueda perdona «camiceta» y conserva las facetas | captura de la búsqueda con el error y de las facetas | [PLAN-ES](PLAN-ELASTICSEARCH-BUSQUEDA.md); `npm run verificar:busqueda` | demostración 2 (primera parte) |
| 7 | Los parecidos salen por significado, con 91,2 % de precisión@5 contra 71,1 %, sin un séptimo almacén | la tabla de [ADR-006 §4](ADR-006-recomendacion-semantica-vectorial.md): 6 de 14 consultas coloquiales contra 0 de 14; el umbral 0,90 | [ADR-006](ADR-006-recomendacion-semantica-vectorial.md) | «Y lo que no sabemos: la etiqueta se cuela en el texto —con solo el título baja a 64,7 %— y falta el juicio humano.» |
| 8 | Se niega por defecto: 64 rutas declaradas y una prueba que falla si falta una | la lista blanca, los cuatro huecos cerrados y las nueve cuentas de Redis | [ADR-007 §1–§4](ADR-007-control-de-acceso.md) | «Una ruta nueva no puede quedar abierta por olvido.» |
| 9 | Quien no tiene permiso no puede, en ninguna capa | los resultados de la demostración 3 | [ADR-007 §6](ADR-007-control-de-acceso.md) | demostración 3 |
| 10 | Decisión 1: los pagos se quedan en MySQL, 4,20 contra 2,70 | la matriz, la saga 2,1× más lenta y los 4 447 reintentos | [ADR-005](ADR-005-evaluacion-nosql-pagos.md) | «Lo propusimos migrar y lo medimos: 128 verificaciones sin fallas.» |
| 11 | Decisión 2: una fila de outbox en la transacción no cuesta nada medible y no pierde ventas | 12,5 contra 12,8 ms de p50; la venta que esperó en la demostración 1 y llegó sola | [ADR-004 §5](ADR-004-analitica-ventas-cassandra.md), [ADR-005 E6](ADR-005-evaluacion-nosql-pagos.md) | «El criterio no es “todo con outbox”: es qué tan caro es que llegue tarde.» |
| 12 | Decisión 3: el tiempo de espera va en el cliente, 73 s contra 1,5 s | la tabla de clientes antes y ahora | [ENTREGA-3 §4 y §7.4](ENTREGA-3-CONSISTENCIA.md) | «Descubrimos que no cumplíamos la degradación: lo midimos apagando contenedores de verdad.» |
| 13 | Tres cosas que cambiaríamos y una que hay que admitir | las filas 2, 3, 9 y 14 de la [retrospectiva](RETROSPECTIVA.md) | [RETROSPECTIVA §4](RETROSPECTIVA.md) | «Mongo corre como replica set para una transacción que no escribimos: es la fila 2.» |
| 14 | Si empezáramos hoy: el mismo criterio con menos almacenes y una salida para cada uno | la tabla v2 y el mapa a la rúbrica | [RETROSPECTIVA §7](RETROSPECTIVA.md) | cierre: la tesis otra vez |

**Respaldo (8):** V3 ([PNG](img/V3-despliegue-y-seguridad.png)); V4 ([PNG](img/V4-secuencia-del-checkout.png)); la tabla del umbral de [ADR-006 §3.6](ADR-006-recomendacion-semantica-vectorial.md); las cuentas de Redis y los permisos de Mongo ([ADR-007 §4](ADR-007-control-de-acceso.md)); la tabla de concurrencia de [ADR-005 §6.5](ADR-005-evaluacion-nosql-pagos.md); los incidentes y la deuda técnica ([RETROSPECTIVA §5 y §6](RETROSPECTIVA.md)); las métricas (72 commits, 520 pruebas, 6 contenedores).

**Las diapositivas armadas a partir de esta guía** (portada, las 14 de arriba, una de preguntas y 11 de respaldo) muestran V1, V2a y V2b como tarjetas, matriz y tabla, que se leen desde el fondo del salón; los diagramas completos de IA/img/ van como respaldo, y cada diapositiva lleva en las notas del orador lo que se dice, el minuto y la fuente.

## 5. Demostración 1 — degradación (3 minutos)

**Ensayada el 2026-10-25** contra el backend y los contenedores reales (un comprador de prueba compró un producto sintético `[PRUEBA…]`):

| Paso | Resultado | Tiempo |
|---|---|---|
| `docker stop` de Redis, Elasticsearch, Neo4j y Cassandra | `GET /api/health/componentes` pasa a «degradado» con los cuatro caídos | 1,9 s |
| Catálogo, ficha, búsqueda básica y relacionados | 200 | 0,0–0,1 s |
| Iniciar sesión | 200 | 0,3 s |
| Agregar al carrito (se arma desde MySQL) | 201 | 0,7 s |
| Preparar el pedido y **confirmarlo** | 200 y **201** | 0,5 s y **1,5 s** |
| Reenviar el mismo intento | **200**, el mismo pedido | 0,0 s |
| Paneles de ventas y de fraude | 503 inmediato (son copias) | 0,0 s |
| `docker start` de los cuatro, sin reiniciar el backend | sanos a los 41 s; salud «completo» a los 44 s | — |
| La venta que esperó en el outbox llega al panel | a los 72 s del `start` (≈ 30 s después de que Cassandra responde: el intervalo del worker) | — |

**Pasos en vivo**

1. Con todo arriba: `curl http://localhost:3000/api/health/componentes` con el token de administrador (muestra los milisegundos de cada almacén).
2. `docker stop tiendaya-redis tiendaya-elasticsearch tiendaya-neo4j tiendaya-cassandra` — **solo esos cuatro**; en esta máquina hay otros dos proyectos (`postgres_ezpass` y `redis_ezpass`) que no se tocan.
3. En el navegador aparece la franja amarilla («Algunos servicios no están disponibles en este momento»), como máximo a los 10 s: la interfaz consulta cada 10 s, el estado cambia en ~2 s.
4. Buscar «camiceta» (búsqueda básica), abrir una ficha (los relacionados salen de «la misma subcategoría»), agregar al carrito y **confirmar el pedido**.
5. Abrir los paneles de ventas y de fraude: 503, a propósito.
6. `docker start` de los mismos cuatro. Sin reiniciar nada, todo vuelve y la venta aparece sola en el panel.

**Qué decir:** «No simulamos nada: apagamos contenedores reales. Lo que no responde son copias; lo que mueve dinero sigue en pie.»
**Antes de empezar:** el backend arrancado hace más de 10 s (el primer chequeo puede marcar un almacén como no listo); `VENTAS_SYNC_ENABLED` y `VENTAS_OUTBOX_ENABLED` no deben ser `false` en `backend/.env` (si lo son, el panel no se alimenta, ver [ARQUITECTURA-FINAL §9](ARQUITECTURA-FINAL.md)); un comprador propio con dirección y método de pago (no Ana ni Luis).
**Plan B:** un video de 90 s; sin Docker, `npm run test:resiliencia` (90 pruebas).
**Diferencia con lo documentado:** [ENTREGA-3 §7.2](ENTREGA-3-CONSISTENCIA.md) mide la compra en 1,1 s (2026-10-20); hoy son 1,5 s, ya con las cuentas de Redis, el intento idempotente y los vectores. Se dice el número de hoy.

## 6. Demostraciones 2 y 3

### Demostración 2 — búsqueda y productos parecidos (2,5 minutos)

1. En la tienda, escribir «camiceta» (con el error): salen las camisetas y las sugerencias, y las facetas (talla, color) siguen.
2. Abrir una camiseta: la sección «Productos relacionados» muestra hasta 6 por significado (sin repetidos, un vendedor ocupa a lo sumo la mitad y lo agotado va al final). `GET /api/productos/1/relacionados` responde `modo: "semantico"`.
3. `docker stop tiendaya-elasticsearch` y recargar la ficha: aparece «Misma subcategoría: …» y la franja amarilla; la tienda sigue. `docker start tiendaya-elasticsearch`.
4. La diapositiva 7: 91,2 % contra 71,1 %, 6 de 14 consultas coloquiales contra 0, y los límites que el propio ADR declara.

**Comprobado hoy en vivo:** la búsqueda con «camiceta» devuelve las camisetas y los relacionados del producto 1 salen con `modo: "semantico"`.
**Plan B:** capturas, y `npm run verificar:similares` y `npm run verificar:busqueda` (imprimen las tablas).
**No hacer en vivo:** crear o editar un producto (carga el modelo de embeddings: +400 MB en un equipo con poca memoria libre).

### Demostración 3 — acceso denegado (2,5 minutos)

1. **API:** con la sesión de un comprador, `GET /api/admin/fraude` responde **403** con `codigo: ACL_DENEGADO`; sin sesión, **401**.
2. **Pantalla `/admin/permisos`** (como administrador): la matriz rol por acción, el simulador («¿puede el comprador usar `GET /api/admin/fraude`?» → no) y la auditoría, donde aparece la denegación del paso 1.
3. **Datos:** `docker exec tiendaya-redis redis-cli GET carrito:1` responde `NOAUTH Authentication required.`; después `npm run verificar:acceso` hace **92 comprobaciones en ~5 s** contra los contenedores reales: cada denegación es real (Redis `NOPERM`; Mongo «not authorized» al borrar un evento del historial, borrar la auditoría, crear un usuario o leer otra base).

**Comprobado hoy en vivo:** el 403 con `ACL_DENEGADO`, el 401, el `NOAUTH`, el `GET /api/admin/permisos` del administrador (200) y las 92 comprobaciones sin fallas.
**No abrir `.env` en pantalla.** **Plan B:** un video y la salida guardada de `verificar:acceso`.

## 7. Banco de preguntas difíciles

| Pregunta | Respuesta corta | Evidencia |
|---|---|---|
| ¿Por qué MySQL y no PostgreSQL con pgvector? | El PRD lo admite y el checkout se midió en MySQL; PostgreSQL uniría lo relacional y lo vectorial y se reconsideraría, pero cambiarlo hoy excede el plazo | [ADR-005](ADR-005-evaluacion-nosql-pagos.md); [RETRO fila 1](RETROSPECTIVA.md) |
| ¿Cassandra para ~109 productos? | No por volumen: es la familia columnar del PRD y sostiene el outbox; hoy viviría en MySQL y la retrospectiva la replantea | [ADR-004 §2](ADR-004-analitica-ventas-cassandra.md); [RETRO fila 6](RETROSPECTIVA.md) |
| ¿Y si cae Redis en plena oferta flash? | Las ofertas se ocultan con 503 y mensaje; el stock real lo protege MySQL; los topes y bloqueos fallan abiertos para no cerrar el sitio | [ENTREGA-3 §7.2 y §7.6](ENTREGA-3-CONSISTENCIA.md) |
| ¿Cómo evitan la sobreventa? | `UPDATE … WHERE cantidad >= n` dentro de la transacción (`checkoutService.js`), no la copia de Mongo; 400 compradores sobre 30 unidades venden exactamente 30 | `checkoutService.js`; [ADR-005 §6.5](ADR-005-evaluacion-nosql-pagos.md) |
| ¿Cómo saben que las recomendaciones son buenas? | Precisión@5 de 91,2 % con la subcategoría como etiqueta y 6 de 14 consultas coloquiales; el límite: la etiqueta está en el texto (64,7 % solo con el título) y el juicio humano no se hizo | [ADR-006 §3.2, §4 y §5](ADR-006-recomendacion-semantica-vectorial.md) |
| ¿Por qué Elasticsearch para los vectores y no pgvector? | 0 contenedores nuevos, filtros dentro de la consulta kNN y el catedrático nombró Elastic; pgvector queda de plan B | [ADR-006 §2](ADR-006-recomendacion-semantica-vectorial.md) |
| ¿Qué pasa si falta el modelo de embeddings? | La tienda funciona igual: los relacionados salen de la misma subcategoría; el modelo solo hace falta al crear o editar un producto y al reconstruir el índice | [ADR-006 §3.3 y §3.5](ADR-006-recomendacion-semantica-vectorial.md) |
| ¿Por qué es seguro el control de acceso? | Dos capas: la API (lista blanca de 64 rutas, rol de hoy leído de MySQL) y los datos (nueve cuentas de Redis y dos de Mongo con el mínimo privilegio); y los límites se dicen: cuatro de seis almacenes sin cuentas por servicio | [ADR-007](ADR-007-control-de-acceso.md) |
| ¿Quién puede cambiar permisos y cómo se audita? | Solo el administrador; ni el administrador ni las rutas «fijas» se pueden quitar; nadie cambia su propio rol; siempre queda un administrador; cada cambio y cada 403 se registra en una colección de Mongo de solo alta | [ADR-007 §9.2 y §9.4](ADR-007-control-de-acceso.md) |
| ¿Y el token de un administrador degradado? | `requireRole` lee el rol de hoy de MySQL (copia de ≤ 5 s); el código que aún lee el rol del token tarda hasta 2 h | [ADR-007 §9.6](ADR-007-control-de-acceso.md) |
| ¿Por qué falla abierto si cae Redis, pero cerrado si rechaza la credencial? | Una caída cuesta más si cierra el sitio; una credencial rechazada es un error de configuración que no debe pasar en silencio | [ADR-007 §4.4](ADR-007-control-de-acceso.md) |
| ¿Seis bases para 109 productos? | Por volumen no; por patrón de acceso y objetivo del curso; la v2 trae un criterio de salida por almacén | [PRD §2](PRD.md); [RETRO fila 15 y §7](RETROSPECTIVA.md) |
| ¿Por qué no migraron los pagos a NoSQL? | Se midió: saga 2,1× más lenta, lecturas 2,5×, 4 447 reintentos de Mongo y una matriz de 4,20 contra 2,70 | [ADR-005](ADR-005-evaluacion-nosql-pagos.md) |
| ¿Y si se pierde la respuesta del COMMIT? | `checkout_intento` con UUID, bloqueo del usuario y respuesta guardada: reenviar da 200 con el mismo pedido; si se pierde la conexión al confirmar, 503 `CHECKOUT_INCIERTO` y reenviar consulta el resultado sin duplicar | [CHECKOUT-IDEMPOTENCIA](CHECKOUT-IDEMPOTENCIA.md); [V4](ARQUITECTURA-FINAL.md) |
| ¿Se pierden ventas si cae Cassandra? | No: el outbox va en la misma transacción, con reintentos e inserciones idempotentes; en el ensayo una venta esperó y llegó sola. Ojo: `.env.example` trae el outbox apagado | [ADR-004 §5](ADR-004-analitica-ventas-cassandra.md); [ARQUITECTURA-FINAL §9](ARQUITECTURA-FINAL.md) |
| ¿Para qué un replica set de un nodo si no usan transacciones? | Se reconoce: ADR-003 las previó y el código no las usa; es la fila 2 de la retrospectiva, con una propuesta (ADR-008) | [RETRO fila 2](RETROSPECTIVA.md); [ENTREGA-3 §4](ENTREGA-3-CONSISTENCIA.md) |
| ¿Qué pasa si se cae MongoDB? | El catálogo y la ficha salen del índice (sin reseñas, ofertas ni historial), el checkout sigue y la copia de stock se repara sola en ≤ 15 s | [ENTREGA-3 §7.2](ENTREGA-3-CONSISTENCIA.md) |
| ¿Cuánto tarda en notarse una caída? | 1,9 s en el ensayo del 2026-10-25; la interfaz consulta cada 10 s | sección 5 |
| ¿Y las contraseñas por defecto del repositorio? | Son de desarrollo (`rootpass`/`tiendaya` de MySQL, `tiendaya_dev` de Neo4j, el `JWT_SECRET` de ejemplo); es lo primero que cambia una puesta en producción | [ARQUITECTURA-FINAL §9](ARQUITECTURA-FINAL.md) |
| ¿Cómo garantizan que el diagrama es correcto? | Una prueba compara el inventario con el código (14 pruebas; detecta las 24 mutaciones con que se probó) y los cinco diagramas renderizan sin errores | [ARQUITECTURA-FINAL](ARQUITECTURA-FINAL.md) |
| ¿Qué cambiarían? | Copiar a Mongo solo lo lento, un outbox genérico, tiempos de espera en el cliente desde el primer día; el vector dentro de un almacén existente ya se hizo | [RETROSPECTIVA §1](RETROSPECTIVA.md) |

## 8. Preparación de la sala

- **15 minutos antes:** `docker compose up -d` (Cassandra tarda hasta 60 s); `docker ps` con los seis `tiendaya-*` en `healthy`.
- **Backend y frontend** arrancados más de 10 s antes (`npm run dev` en `backend/` y en `frontend/`).
- **Modelo y vectores:** `npm run modelo:verificar`; `npm run busqueda:backfill` hecho; `GET /api/productos/1/relacionados` debe responder `modo: "semantico"`.
- **`backend/.env`:** `VENTAS_SYNC_ENABLED` y `VENTAS_OUTBOX_ENABLED` distintos de `false`.
- **Cuentas de demo propias:** un comprador con dirección y método de pago, y un administrador. No usar Ana ni Luis (bajo vigilancia: piden contraseña en cada pedido). El barrido de fraude corre cada 60 s y puede suspender cuentas sintéticas.
- **No correr antes** `verificar:ofertaFlash` (vacía el stock del producto #1) ni crear o editar productos en vivo.
- **Tras traer cambios de otra persona:** `npm run prisma:deploy && npm run prisma:generate` y reiniciar el backend; con el control de acceso, `npm run seguridad:inicializar`, `docker compose up -d` y `npm run seguridad:mongo`.
- **Una segunda laptop** con el stack arriba, todo local y **sin internet** (el modelo de embeddings es local).
- **No abrir `.env` en pantalla**; las diapositivas exportadas a PDF; un video de respaldo de 90 s por demostración.
- **Prueba técnica en el aula** si se puede: HDMI, resolución, `docker ps`.

## 9. Lo que falta (del equipo)

1. Las diapositivas: este guion tiene los títulos-afirmación, la evidencia y las fuentes; los diagramas están exportados en [`img/`](img/).
2. Tres videos de 90 s, uno por demostración.
3. **Ensayo 1** cronometrado, **pre-mortem** («salió mal: ¿por qué?») y **ensayo 2** de a lo sumo 18 minutos:

| Ensayo | Fecha | Duración | Qué falló | Qué se cambió |
|---|---|---|---|---|
| 1 (cronometrado) | | | | |
| 2 (≤ 18 min) | | | | |

**Riesgos que el pre-mortem debe cubrir:** un contenedor que no queda sano a tiempo (Cassandra); una cuenta de demo suspendida por el barrido; se acaba el tiempo (recortar la diapositiva 12 y el respaldo); una pregunta sobre las transacciones de Mongo (la respuesta está en el banco); el modelo de embeddings que no carga por falta de memoria (no crear productos en vivo).

4. Confirmar con el catedrático (lunes 2026-10-26): el formato y la duración, y si la pantalla de permisos era lo esperado.

**Efectos del ensayo del 2026-10-25 en la base de desarrollo:** una cuenta `ensayo.demo@example.com` con su dirección y método de pago, y una compra (#322) de una unidad del producto sintético #120; después se corrió `npm run fraude:backfill` para llevar la compra al grafo.
