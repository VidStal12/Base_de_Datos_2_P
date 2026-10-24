# ADR-007 — Control de acceso: lista blanca en la API y cuentas de servicio en Redis y MongoDB (Entrega Final)

**Fecha:** 2026-10-23
**Estado:** Implementado y verificado para la API, Redis y MongoDB. Elasticsearch, Cassandra, Neo4j y MySQL quedan como trabajo siguiente (§8).

> Cubre el ítem «Control de acceso en un componente NoSQL» de la Entrega Final (4 pts): autenticación y autorización explícitas, permisos acotados por servicio y **evidencia de que quien no tiene permiso no puede operar fuera de su alcance**. Plan y estimaciones en [PLAN-ENTREGA-FINAL.md](PLAN-ENTREGA-FINAL.md) §4.

---

## 1. Contexto

Antes de esta entrega, de los componentes NoSQL solo Neo4j pedía una contraseña (una sola, fija y compartida). Redis, MongoDB, Cassandra y Elasticsearch aceptaban a cualquiera que llegara al puerto, y Redis y MongoDB estaban publicados en todas las interfaces. Dentro del backend, todos los módulos compartían una única conexión por base: un bug en el carrito podía borrar una suspensión de cuenta o el historial de cambios.

La nota de voz del catedrático (2026-10-21) pidió algo más concreto que «un rol»: un mecanismo, configurable por rol, para que nadie vea lo que no le corresponde **aunque alguien encuentre un bug**, con la API como intermediaria. Se aceptó que el JWT y los roles que ya existen pueden manejar esa parte.

La revisión de las rutas (OWASP API Top 10) encontró cuatro huecos reales, todos «una ruta sin el chequeo que debía tener»: el historial de un producto lo leía cualquier vendedor, las reseñas públicas devolvían el id y el nombre completo del autor, las estadísticas de edición no pedían sesión y la salud pública mostraba el texto crudo de los drivers. Se corrigieron antes de lo demás ([PLAN-ENTREGA-FINAL.md §4.1](PLAN-ENTREGA-FINAL.md)).

## 2. Principio: lista blanca (negar por defecto)

Se parte de «nada permitido» y se anota lo que sí. Una lista negra falla abierta: lo que se olvida anotar queda permitido, y así nacieron los huecos de §1. Las reglas de negar existen solo como red de seguridad o excepción (las suspensiones y los límites suaves de cuentas, que ya existían, son la lista negra por usuario).

## 3. Alternativas consideradas

| Opción | Qué da | Por qué no basta o no se eligió |
|---|---|---|
| **A. Solo roles en la API (lo que había)** | `requireRole` por ruta | Cada ruta nueva es abierta hasta que alguien recuerda protegerla. Y si se encuentra un bug, la API tiene permiso para todo en las bases |
| **B. Cuentas de servicio por módulo en las bases** | Un bug o una credencial filtrada de un módulo no toca los datos de otro; el historial puede ser *append-only* por garantía de la base | Es la lectura literal del PRD («permisos acotados por servicio») |
| **C. Motor de políticas configurable** (Casbin, CASL, OPA, OpenFGA, Keycloak AuthZ) | Reglas editables en caliente, pantalla de permisos | Para tres roles son un servicio o una dependencia más; la tabla propia es proporcional. Queda como «ideal» opcional ([PLAN §4.1](PLAN-ENTREGA-FINAL.md)), pendiente de la respuesta del catedrático |
| **D. Solo aislar la red** (publicar en 127.0.0.1) | Reduce quién llega | No limita lo que hace el backend ni quien ya llegó |

## 4. Decisión

**A + B + una política declarada y probada, todo con la regla del §2.**

### 4.1 API: la lista de rutas es la lista blanca
`backend/src/config/politicaRutas.js` declara las 53 rutas del backend con su acceso (8 públicas, 4 con sesión opcional, 24 con sesión, 17 por roles; 8 comprueban además el dueño del recurso). `tests/accesoRutas.test.js` carga el `app.js` real, recorre su router en el orden en que Express lo ejecuta y falla si una ruta no está declarada, si una declarada ya no existe, o si el acceso que la ruta exige de verdad (leído de las etiquetas de `requireAuth`, `requireRole` y `optionalAuth`) no es el declarado. Después prueba por HTTP, con los manejadores de negocio reemplazados por un centinela para no tocar ninguna base, que toda ruta con sesión responde 401 sin token y que **cada rol que no figura en la lista de una ruta recibe 403**.

### 4.2 Redis: una cuenta por módulo, y `default` apagado
Nueve cuentas ([`redisCuentas.js`](../backend/src/config/redisCuentas.js)), cada una `-@all` + sus comandos + sus familias de llaves:

| Cuenta | La usa | Puede |
|---|---|---|
| `rd_candados_r` | revisión de sesión, control de pedidos, paneles | leer `bloqueo:*` y `restriccion:*` (`PTTL`, `SCAN`) |
| `rd_candados_w` | servicio de suspensión | escribir esas mismas llaves |
| `rd_carrito` | `cartService` | `carrito:*` |
| `rd_ofertas` | ofertas flash, reservas del checkout | `oferta:*`, `checkout:reserva:*` |
| `rd_cupos` | tope de pedidos por hora, intentos de contraseña | `limite:pedidos:*`, `reauth:intentos:*` |
| `rd_recomendaciones` | `tendenciaService` | `recomendaciones:*`, `oferta-recomendada:*` |
| `rd_actividad` | actividad reciente de la búsqueda | `actividad:*` |
| `rd_salud` | `GET /api/health/componentes` | solo `PING` |
| `rd_admin` | scripts de mantenimiento; el servidor web nunca | todo |

Cada familia de llaves se **escribe** desde una sola cuenta (una prueba lo exige, y otra comprueba que cada servicio que usa Redis figure en la cuenta con la que entra). La lista salió de leer el código servicio por servicio y se confirmó ejecutando los flujos reales con `ACL LOG` abierto, que quedó vacío. La matriz que el plan había derivado antes omitía la familia `oferta-recomendada:*` y no preveía una cuenta aparte para la salud.

### 4.3 MongoDB: autenticación, un rol de aplicación y un historial *append-only*
El servidor web entra como `mg_app` con el rol `app_tiendaya` ([`mongoCuentas.js`](../backend/src/config/mongoCuentas.js)): `find`, `insert` y `update` en `productos`, `categorias`, `subcategorias` y `resenas`, **sin `remove`**; en `producto_eventos` solo `find` e `insert`, más las acciones de esquema que Mongoose usa al cargar un modelo (`createIndex`, `createCollection`, `listIndexes`). Un evento del historial no se puede modificar ni borrar ni siquiera con un bug o una inyección en la aplicación: lo impide la base, no una convención del código. `mg_admin` (root) es para mantenimiento.

### 4.4 Un rechazo de credenciales no es una caída
La degradación elegante de la Entrega 3 asumía «error de base = caída». Con autenticación eso deja de ser cierto, y tratar un rechazo como «se sigue sin ella» deja la aplicación funcionando a medias sin que nadie sepa por qué, o apaga controles de seguridad en silencio. Por eso:

- `esErrorDeAcceso(err)` reconoce el rechazo de cada base (`WRONGPASS`, `NOAUTH`, `NOPERM`, «ACL failure in script»; Mongo `Unauthorized` y `AuthenticationFailed`) y `componenteCaido` lo excluye.
- El cliente recibe `500 CREDENCIAL_RECHAZADA` con un mensaje genérico (nunca la cuenta, el comando ni la llave); el servidor escribe una línea por cuenta cada 15 s.
- Un cerrojo detiene el bucle de reintentos tras el primer rechazo y a los 30 s prueba una vez más, así que corregir el `.env` o el ACL no exige reiniciar el backend.
- Fallan **cerrado**: la revisión de suspensión en cada petición autenticada, los límites suaves, el tope de pedidos por hora y el contador de intentos de contraseña. Lo que es solo una caché degrada a MySQL con aviso.

## 5. Hallazgos de implementación

- **El archivo de ACL de Redis no admite comentarios** (cada línea debe empezar con `user`), y las contraseñas pueden ir como hash SHA-256 (`#…`): `users.acl` no contiene ningún secreto que sirva para entrar.
- **ioredis 6** abre la conexión con `HELLO … AUTH`, `INFO` (ready check) y `CLIENT SETINFO`. Una cuenta de servicio no tiene los dos últimos, y el rechazo ensuciaba el `ACL LOG`: se desactivan (`enableReadyCheck: false`, `disableClientInfo: true`).
- **Los scripts Lua corren con los permisos de quien los llama**: cada `redis.call` se comprueba contra la cuenta, así que `EVAL` no es una puerta de escape (probado: un script que lee una llave ajena responde «ACL failure in script»). Por eso los comandos de los scripts (`TIME`, `HSET`, `DECRBY`…) forman parte de la lista de cada cuenta.
- **`SCAN` lista los nombres de todas las llaves** y los ACL no pueden filtrarlo. Solo `rd_candados_r` lo tiene (lo necesitan el panel de suspensiones y el ocultado de vendedores suspendidos).
- **MongoDB con replica set y autenticación necesita `--keyFile`**, y un archivo montado desde Windows tiene permisos abiertos que Mongo rechaza: el contenedor lo copia a `/tmp`, le pone `chmod 400` y el dueño `mongodb`. Probado con un volumen ya inicializado (los datos y el replica set se conservan) y con uno nuevo (el *healthcheck* inicia el replica set y los usuarios se crean por la *localhost exception*).
- **`ping` de Mongo no pide autenticación**: con la cuenta de servicio rechazada la salud decía «ok» mientras el catálogo respondía 500. La comprobación hace además una lectura con la cuenta de la aplicación.
- **Mongoose 9 con `mg_app`:** los cinco modelos cargan (`init()`), y `updateOne` / `deleteOne` sobre un evento responden `Unauthorized` también vía Mongoose.

## 6. Evidencia

- `npm run test:acceso`: pruebas aisladas de la lista blanca de rutas (6), de las cuentas y errores de Redis (25) y de Mongo (14), más las 14 de los huecos de la API. Las protecciones se comprobaron **deshaciéndolas**: 15 mutaciones de rutas, 29 de Redis y 18 de Mongo, todas detectadas.
- `npm run verificar:acceso` contra los contenedores reales: **88 comprobaciones, 0 fallas** (70 de Redis, 18 de Mongo), con las denegaciones en `ACL LOG`. Para Mongo compara los privilegios de `mg_app` en el servidor con los declarados.
- El backend real y sus flujos (sesión, carrito, actividad, pedidos, recomendaciones, administración) contra un Redis con ACL: `ACL LOG` **vacío**, es decir, ningún permiso faltante. Los scripts de verificación existentes (ofertas, bloqueos, carrito, compra propia, compromiso de no reventa, idempotencia, búsqueda) pasan con las cuentas.
- Fallas provocadas con el backend corriendo: contraseña rechazada (500 `CREDENCIAL_RECHAZADA`, una línea en el log, recuperación en 28 s sin reiniciar), comando quitado de una cuenta dentro de un script (el pedido falla cerrado y se recupera al devolver el permiso), cuenta del carrito rechazada (el carrito se sirve desde MySQL y el log nombra la cuenta).

## 7. Consecuencias

- (+) Un bug o una credencial filtrada de un módulo ya no toca los datos de otro; el historial de cambios es *append-only* por garantía de la base; una ruta nueva no puede quedar abierta por olvido.
- (+) Redis y MongoDB se publican solo en `127.0.0.1`.
- (−) Más piezas de arranque: antes de `docker compose up` hay que correr `npm run seguridad:inicializar` (idempotente), y la primera vez `npm run seguridad:mongo`. Está en el README.
- (−) La caché de Redis se vacía al recrear el contenedor (nunca tuvo volumen) y los scripts que necesitan borrar en Mongo piden `conectar('admin')` de forma explícita.
- (−) Quien controle el proceso del backend tiene todas las contraseñas de su `.env`: las cuentas por módulo acotan un bug o una credencial filtrada de un módulo, no un servidor comprometido.

## 8. Fuera de alcance / pendiente

- Elasticsearch (seguridad de Basic: usuarios, roles y API keys sí; DLS/FLS son de pago), Cassandra (`PasswordAuthenticator` + `CassandraAuthorizer`), Neo4j (Community no tiene roles: solo autenticación, límite que se declara en la retrospectiva) y MySQL (`GRANT` mínimos).
- La pantalla `/admin/permisos` con una política editable (`acl_regla`): «ideal» del plan, pendiente de lo que responda el catedrático el 2026-10-26.
- Límite de intentos de login y registro, y quién puede crear categorías ([PLAN §4.1](PLAN-ENTREGA-FINAL.md), filas 5 y 6).
- mTLS, Vault, cifrado en reposo.
