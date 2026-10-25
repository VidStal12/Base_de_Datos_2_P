# ADR-007 — Control de acceso: lista blanca en la API y cuentas de servicio en Redis y MongoDB (Entrega Final)

**Fecha:** 2026-10-23
**Estado:** Implementado y verificado para la API, Redis y MongoDB, **más la pantalla de permisos `/admin/permisos`** (2026-10-25, §9). Elasticsearch, Cassandra, Neo4j y MySQL quedan como trabajo siguiente (§8).

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
| **C. Motor de políticas configurable** (Casbin, CASL, OPA, OpenFGA, Keycloak AuthZ) | Reglas editables en caliente, pantalla de permisos | Para tres roles son un servicio o una dependencia más; la tabla propia es proporcional. **Se hizo con una tabla propia y una pantalla (§9)**, sin motor externo |
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
- ~~La pantalla `/admin/permisos` con una política editable (`acl_regla`)~~: hecha, ver §9. Falta que el catedrático opine el 2026-10-26 si esto era lo esperado.
- Límite de intentos de login y registro, y quién puede crear categorías ([PLAN §4.1](PLAN-ENTREGA-FINAL.md), filas 5 y 6).
- mTLS, Vault, cifrado en reposo.

## 9. La pantalla de permisos (`/admin/permisos`)

> Se pidió «una interfaz visual» para el control de acceso. El catedrático había aceptado que la API con JWT y roles basta (§1), así que esto es el extra: **ver y ajustar quién puede qué, sin tocar el código**, con las mismas garantías de la lista blanca.

### 9.1 Qué se tomó de las consolas de permisos reales

Se abrieron las páginas de seis referencias y se copió de cada una lo que encaja con tres roles y un administrador (no se copió su tamaño):

| Referencia | Lo que se aplicó |
|---|---|
| **Kubernetes RBAC** ([documentación](https://kubernetes.io/docs/reference/access-authn-authz/rbac/)) | Los permisos son *aditivos* («no hay reglas de negar»): lo que no se concede, se niega. Un usuario solo puede crear o editar un rol si ya tiene todos los permisos que contiene (o el verbo `escalate`): **quien administra permisos no puede concederse más de lo que tiene** → las rutas de esta pantalla son *fijas*, no se pueden dar a otro rol. Los roles por defecto se reparan solos al arrancar → «restaurar» vuelve a lo que declara el código |
| **`kubectl auth can-i`** ([referencia](https://kubectl.docs.kubernetes.io/references/kubectl/auth)) | Una pregunta, una respuesta: sí o no |
| **Simulador de políticas de AWS IAM** ([guía](https://docs.aws.eu/IAM/latest/UsingPolicySimulatorGuide/)) | Se elige quién (usuario o rol) y qué acción; el resultado es permitido o denegado y se despliega **qué sentencia decidió**. La guía advierte que el simulador puede diferir de lo real → acá es *la misma función* que usa el middleware (`politicaAccesoService.decidir`), y una prueba lo compara |
| **Roles personalizados de GitHub** ([documentación](https://docs.github.com/en/enterprise-cloud@latest/organizations/managing-peoples-access-to-your-organization-with-roles/about-custom-organization-roles)) | Un rol se arma sobre una base y suma permisos; roles y permisos son aditivos. *Crear roles* es un permiso aparte de *asignarlos*. Acá: un rol nuevo parte de un comprador y recibe, una por una, rutas de la matriz |
| **Registro de auditoría de GitHub** ([documentación](https://docs.github.com/en/organizations/keeping-your-organization-secure/managing-security-settings-for-your-organization/reviewing-the-audit-log-for-your-organization)) | Quién actuó, a quién afectó, qué acción y cuándo; se filtra por quién, por tipo y por fecha, y se exporta a CSV. La documentación no dice si es inmutable; acá sí lo es (§9.4) |
| **Roles y permisos de Auth0** ([documentación](https://auth0.com/docs/manage-users/access-control/configure-core-rbac/roles/add-permissions-to-roles)) | Los permisos se agrupan en roles y los roles se asignan a las cuentas, desde la misma consola |
| **OWASP Authorization Cheat Sheet** ([hoja](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)) | Negar por defecto, mínimo privilegio, comprobar en **cada** petición y de forma centralizada, **registrar los accesos denegados**, y *separar la administración de la política de su aplicación* (la pantalla edita; el middleware decide). Advierte del «role sprawl» y prefiere ABAC/ReBAC cuando hace falta granularidad fina o multi-inquilino: con tres roles de sistema y rutas, RBAC alcanza; si crece, es lo que se reabre |

### 9.2 Cómo está hecho

- **La base sigue siendo el código.** `politicaRutas.js` declara cada ruta por roles como **editable** (13: el panel de ventas, fraude, las suspensiones, el mantenimiento, las estadísticas de ediciones y crear categorías) o **fija** con el motivo (14): publicar, editar y ver el historial dependen del dueño del producto y del compromiso de no reventa, que el servicio liga a *vendedor* y *administrador*; y las 10 de esta misma pantalla. Una prueba exige que toda ruta por roles sea una cosa o la otra.
- **La tabla guarda solo diferencias** (`acl_regla`: rol, ruta, permitido, quién, cuándo). Sin fila vale el código, así que una ruta nueva funciona desde el primer día y «restaurar» es borrar filas. Una fila de una ruta fija, o del administrador, **no cuenta ni aunque alguien la meta a mano en MySQL**: se comprueba al decidir, no solo al escribir.
- **El administrador conserva todo.** Su columna está bloqueada; así nadie puede quedarse sin acceso a esta pantalla.
- **`requireRole` consulta la política.** Sigue recibiendo la lista que declara el código, pero la decisión la toma `politicaAccesoService.permite` con (a) el **rol de hoy** de la cuenta —el token dura 2 h; un administrador degradado pierde las rutas en segundos, no al vencer— y (b) las reglas, leídas de MySQL a lo sumo cada 5 s por proceso e invalidadas al instante en el proceso que escribe. La clave con que se consulta (`GET /api/admin/ventas`) sale de cómo se montó el router, y una prueba exige que sea exactamente la de la lista blanca (encontró, en su primera corrida, que `router.post('/')` producía una barra de más).
- **Todo o nada.** Un lote de cambios se valida entero antes de escribir nada y se aplica en una transacción; un cambio inválido (ruta fija, rol inexistente, repetido, el administrador) rechaza el lote completo.
- **Cuentas y roles.** Se crean y borran roles (los tres del sistema no se borran, ni uno con cuentas) y se cambia el rol de una cuenta, con tres límites: **nadie cambia su propio rol**, siempre queda al menos un administrador y el nombre de un rol es estricto.
- **La interfaz** no decide nada: `/api/auth/me` devuelve las rutas por roles que la cuenta puede usar hoy, y el panel, el menú y las rutas del frontend ofrecen solo eso (`RequirePermiso`). Un rol `auditor` con *ver fraude* ve un panel con un único botón; la API sigue siendo quien decide en cada petición.

### 9.3 Qué se ve

Cuatro pestañas: **Permisos** (una matriz rol × acción, agrupada por módulo, con tres estados visibles —código, cambiado por un administrador, sin guardar—, un resumen antes de guardar que avisa lo que *quita*, y «restaurar» por fila o completo), **Simulador** (rol o cuenta × acción, con el motivo y la lista de todo lo que ese rol puede hacer), **Cuentas y roles** y **Auditoría**.

### 9.4 Auditoría

Cada cambio de permisos, de rol de una cuenta, de creación o borrado de un rol, cada «restaurar» y cada acceso denegado por `requireRole` se escribe en la colección `auditoria_acceso` de MongoDB, a la que el servidor web solo puede **leer e insertar** (la base lo impide: se comprobó con `update`, `delete` y `drop` contra el servidor real). De quien actuó se guarda solo el número y el rol; el nombre y el correo se resuelven al leer. Las denegaciones repetidas (misma cuenta y ruta) se anotan una vez por minuto y vencen a los 90 días (índice TTL parcial: lo ejecuta el servidor, sin permiso de borrar); los cambios se guardan siempre. El CSV neutraliza las celdas que empiezan como fórmula. Es de mejor esfuerzo: si Mongo está apagado el cambio de permisos se aplica igual (revocar un acceso no puede esperar) y la respuesta dice `auditado: false`; MySQL conserva al menos quién y cuándo (`acl_regla.actualizado_por`).

### 9.5 Evidencia

- `npm run test:permisos`: **103 pruebas** (la decisión y sus precedencias; la copia de 5 s; MySQL apagado, colgado y arranque en frío; la matriz; el lote todo o nada; restaurar; el simulador contra la decisión real; cuentas y roles con sus límites; la auditoría, el CSV y los filtros; las rutas HTTP; `requireRole`; y las funciones de la interfaz). `npm run test:acceso` (61) suma la lista blanca con las claves y la coherencia editable/fija, y el rol de Mongo con la auditoría append-only. La suite completa del backend: 506 de 506.
- **68 mutaciones deliberadas** sobre estas protecciones (quitar el tope por vendedor, dejar pasar un rol inexistente, que una regla toque al administrador, que una ruta fija obedezca una fila, no invalidar la copia, quitar el 403 `ACL_DENEGADO`, dejar entrar si la política falla…): todas las detecta alguna prueba.
- `npm run verificar:permisos` contra el backend y las bases reales: **32 comprobaciones, 0 fallas** —concede y revoca una ruta con efecto inmediato, crea un rol que recibe una sola ruta y la pierde al instante al cambiarle el rol a la cuenta con el mismo token, intenta lo prohibido, y revisa la auditoría y el CSV—, y deja todo como estaba. `npm run verificar:acceso` suma 4 comprobaciones del servidor de MongoDB: la colección de auditoría solo con lectura y alta, y que un registro no se modifica, no se borra y la colección no se tira.
- En el navegador: matriz con cambios sin guardar, resumen, aplicar y restaurar; crear un rol, asignarlo y ver que esa cuenta entra solo a lo concedido (las demás secciones responden «Acceso restringido»); el simulador; la auditoría. Sin errores en la consola y sin desborde horizontal a 375 px.

### 9.6 Límites y costos que se aceptan

- **Con MySQL apagado en un arranque en frío** rige lo que declara el código: una revocación hecha desde la pantalla no se aplica hasta que MySQL vuelva (con una copia previa se conserva la última política conocida). Un acceso concedido tampoco.
- **Con varios procesos del backend** un cambio llega a los demás en ≤ 5 s (no hay invalidación entre procesos; un solo proceso es el caso de este proyecto).
- **El rol de hoy** lo usan las rutas por roles. El resto del código sigue leyendo el rol del token (p. ej. que un administrador vea los productos inactivos en el listado público): un administrador degradado los vería hasta 2 h más. No toca nada que pida un rol.
- **Un rol creado nunca recibe rutas fijas**: publicar y editar productos exigen el compromiso de no reventa y el dueño, que el servicio reconoce solo para vendedor y administrador.
- **Es RBAC con roles planos.** Si el catálogo de acciones o de roles creciera, OWASP recomienda pasar a atributos o relaciones (§9.1); es la decisión que se reabriría.
