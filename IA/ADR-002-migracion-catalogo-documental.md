# ADR-002 — Migración del catálogo a base documental (Entrega 1)

**Fecha:** 2026-08-23
**Estado:** Implementado (ETL, servicios contra Mongo, historial de eventos, conectividad verificada) — ver §8 para las notas de implementación

> Cubre dos de los requerimientos de Entrega 1 (PRD §5): el diagnóstico/justificación de la migración (0.75 pt) y la decisión embed/reference para reseñas, imágenes y relación producto–vendedor (1.0 pt). La implementación (ETL, código del catálogo contra Mongo, historial de eventos) es trabajo aparte — ver §7 y el futuro ADR del historial de cambios.

---

## 1. Diagnóstico (contexto)

### 1.1 El catálogo actual fuerza un patrón EAV para poder tener atributos distintos por categoría

El modelo relacional no tiene forma de que "camiseta" tenga columnas `talla`/`color` y "smartphone" tenga `almacenamiento`/`color` sin, o bien una tabla con decenas de columnas casi todas `NULL` según la categoría, o bien Entity-Attribute-Value. Se eligió EAV (`categoria` → `subcategoria` → `atributo_categoria` define qué atributos aplica cada subcategoría, `atributo_producto` guarda el valor concreto por producto — ver [ERD.md](ERD.md) §1.1).

Esto funciona, pero tiene un costo medible en el código actual. Para armar el detalle de **un** producto (`productoService.obtener`, `backend/src/services/productoService.js`), Prisma tiene que tocar seis tablas:

```js
prisma.producto.findUnique({
  where: { id },
  include: {
    inventario: true,
    vendedor: { select: { id_usuario, nombres, apellidos } },
    categoria_productos: { include: { subcategoria: true } },
    atributos_producto: { include: { atributo_categoria: true } },
  },
});
```

`producto`, `inventario`, `usuarios`, `categoria_producto`, `subcategoria`, `atributo_producto`, `atributo_categoria` — siete tablas para renderizar una vista de detalle. Cada atributo nuevo que un vendedor quiera agregar a un producto (algo que ya construimos como flujo de uso normal en el panel de vendedor) es una fila más en `atributo_producto`, nunca una columna nueva — lo cual es justamente la señal de que el dato es naturalmente **un documento con forma variable**, no una fila con esquema fijo.

### 1.2 El modelo actual no puede preservar historial — es un problema de diseño, no de que falte una tabla

`productoService.actualizar()` hace `UPDATE` directo sobre `producto`, `inventario` y `upsert` sobre `atributo_producto`: el valor anterior se pierde en el momento en que se guarda el nuevo. Entrega 1 pide lo contrario — que cada modificación agregue un evento sin sobrescribir, y una consulta que reconstruya el estado del producto en una fecha arbitraria.

Esto **sí sería implementable en relacional** (una tabla `producto_eventos` con snapshots), pero es incómodo por la misma razón que el punto 1.1: el "estado de un producto" no es una fila, es una fila de `producto` + su fila de `inventario` + N filas de `atributo_producto` variables. Versionar eso de forma atómica y consistente en relacional implica versionar varias tablas a la vez y reconstruir el join en cada fecha consultada. En un modelo documental, un producto **es** un documento — versionar un documento completo (snapshot completo por evento) es el caso de uso más directo que existe para una base documental.

---

## 2. Alternativas consideradas

| Opción | Resuelve atributos variables | Resuelve historial | Costo/complejidad |
|---|---|---|---|
| **A. No cambiar** (seguir 100% relacional; EAV + tabla `producto_eventos` para historial) | Ya lo resuelve, a costa de más joins | Técnicamente posible, pero versionar 3 tablas a la vez de forma atómica y consistente es incómodo (ver §1.2) | Bajo a corto plazo, crece con cada atributo/feature nueva |
| **B. Relacional con columna `JSON`** (MySQL soporta tipo `JSON` nativo desde 5.7) — `producto.atributos` como JSON en vez de EAV | Sí, sin joins extra | No resuelve el historial por sí sola (mismo problema que A) | Medio — pierde la capacidad de indexar/consultar atributos individuales con la misma eficiencia que columnas o que los índices de Mongo sobre campos de documento |
| **C. Migrar a base documental (MongoDB)** — opción de referencia del PRD | Sí, de forma nativa (cada producto es un documento con su propia forma) | Sí — versionar un documento completo por evento es el patrón estándar | Medio — nueva base de datos, nuevo driver/ODM, migración con ETL, y hay que documentar la referencia cruzada con lo que sigue relacional |

**Se descarta A** porque no ataca el problema real (el modelo de datos, no solo la falta de una tabla de eventos) y porque el propio PRD pide demostrar criterio migrando donde corresponde, no evitar la migración por comodidad.

**Se descarta B** porque resuelve la mitad del problema (atributos) pero no la otra mitad (historial), y porque el PRD específicamente pide evaluar una base documental para este caso — quedarse en MySQL con JSON sería, en la práctica, reimplementar a mano un subconjunto peor de lo que Mongo ya da.

---

## 3. Decisión

Migrar a MongoDB la parte **descriptiva** del catálogo: `categoria`, `subcategoria` (con las definiciones de atributo embebidas — ver §3.1) y los campos variables de `producto` (descripción, estado, atributos, imágenes — ver §6). Reseñas e imágenes nacen documentales directamente (son features nuevas, no había nada que migrar).

`precio` y `cantidad` **no migran** — se quedan en `inventario` (MySQL), sin tocar. Igual que `usuarios`, `rol_usuario`, `direcciones`, `metodo_pago`, `carrito`, `compra`, `pago`, `compra_detalle`. Ver §3.2 para el porqué — es una revisión sobre el planteo original de este documento.

### 3.1 Simplificación que trae el modelo documental

`categoria` y `subcategoria` sí quedan como dos colecciones separadas (no una sola, aunque una versión anterior de este documento las había aplanado en una) — aplanarlas obligaría a actualizar el nombre de la categoría en cada subcategoría que la referencia si algún día cambia, el mismo problema de desnormalización que el modelo relacional ya evita:

```json
// colección "categorias"
{ "_id": "ObjectId(...)", "categoria": "Ropa" }

// colección "subcategorias"
{
  "_id": "ObjectId(...)",
  "categoria_id": "ObjectId(...)",
  "subcategoria": "Camisetas",
  "atributos_definidos": ["Talla", "Color"]
}
```

Lo que sí se simplifica de verdad es que ya no hace falta una tabla de definición de atributos aparte (`atributo_categoria`) — queda embebida como plantilla dentro de la subcategoría (arriba), y el producto guarda directamente nombre + valor:

```json
// colección "productos"
{
  "_id": "ObjectId(...)",
  "producto_id": 1,
  "descripcion": "Camiseta básica de algodón",
  "estado": "activo",
  "subcategoria_id": "ObjectId(...)",
  "vendedor_id": 2,
  "vendedor_nombre": "Luis Ramírez",
  "atributos": [
    { "nombre": "Talla", "valor": "M" },
    { "nombre": "Color", "valor": "Azul" }
  ],
  "imagenes": [{ "url": "...", "alt": "...", "orden": 1, "principal": true }],
  "resenas_resumen": { "promedio": 0, "cantidad": 0 },
  "version": 1
}
```

`producto_id` es el mismo entero de `producto.id` en MySQL — no un ObjectId nuevo. Es lo que conecta este documento con su fila `producto`/`inventario` (ver §3.2).

Esto reemplaza los siete joins de §1.1 por una lectura de documento + una lectura a `inventario` (MySQL) para precio/cantidad — sigue siendo una simplificación real, aunque no elimina por completo la consulta relacional (ver §3.2).

### 3.2 Actualización (2026-08-23): por qué precio/cantidad no migran

La versión original de este ADR incluía `precio`/`cantidad` en el documento de Mongo. Se revisó al planificar la implementación: el checkout atómico (Fase Inicial, ya construido y probado) descuenta `inventario.cantidad` dentro de la misma transacción de Prisma que crea `compra`/`compra_detalle`/`pago`. Si `inventario` se hubiera movido a Mongo, esa transacción dejaría de poder ser una sola operación atómica — pasaría a ser una escritura en Mongo y otra en MySQL sin ninguna garantía conjunta, exactamente el problema de "checkout con múltiples componentes de persistencia" que el PRD asigna explícitamente a **Entrega 3** (con su propio documento de estrategia de consistencia), no a Entrega 1.

Además, el diagnóstico de este mismo documento (§1) nunca fue sobre precio/cantidad — es sobre atributos heterogéneos por categoría y sobre historial de cambios descriptivos. Mover precio/cantidad a Mongo no resolvía ningún problema diagnosticado; solo agregaba riesgo.

**Consecuencia práctica:** el detalle de un producto ahora se arma con una lectura a Mongo (descripción/atributos/imágenes) + una lectura a MySQL (`inventario`, por `producto_id`) — dos lecturas independientes, no una transacción distribuida, porque no hay ninguna escritura conjunta que deba ser atómica entre ambas para *leer* un producto. Escribir (crear/editar) sí toca las dos bases, pero cada una se mantiene consistente *dentro de sí misma* por separado — ver la implementación en `productoService.js` una vez migrado.

---

## 4. Justificación

- **Patrón de consulta:** el acceso real del sistema es casi siempre "traer un producto completo" o "listar productos de una subcategoría con sus atributos" — exactamente el acceso que un documento auto-contenido resuelve en una lectura, contra siete tablas hoy.
- **Escalabilidad de esquema:** cada categoría define sus propios atributos sin migraciones de esquema ni columnas `NULL`; ya lo estábamos simulando con EAV, Mongo lo hace nativo.
- **Consistencia:** los datos financieros/transaccionales (pedidos, pagos, inventario descontado atómicamente) exigen las garantías ACID fuertes que ya tenemos en MySQL — por eso esos no se tocan. El catálogo, en cambio, tolera consistencia eventual entre el conteo de reseñas embebido y la colección de reseñas real (ver §6.1) sin que eso rompa nada crítico.
- **Costo operativo:** se suma una base de datos más para operar, pero es exactamente el costo que el PRD espera que se pague cuando el análisis lo justifica — no cambiar tecnologías "porque sí" tiene el mismo peso de evaluación que cambiarlas, y acá el diagnóstico (§1) sostiene el cambio.

## 5. Consecuencias

**Beneficios:**
- Detalle de producto pasa de siete tablas relacionales a un documento de Mongo + una fila de `inventario` (MySQL) — sigue siendo una simplificación real (ver §3.2).
- Agregar un atributo nuevo a una categoría deja de requerir filas EAV — es directamente parte del documento.
- El historial de cambios por evento (requerimiento de mayor peso de Entrega 1, ver ESTADO-PROYECTO.md) tiene un modelo natural: cada evento es un snapshot del documento completo.
- **El checkout atómico no se toca.** Al no migrar `inventario`, la transacción de Prisma que ya está construida y probada (pedido + líneas + pago + descuento de stock) sigue siendo una sola operación atómica en una sola base de datos — cero riesgo de regresión sobre la Fase Inicial.

**Limitaciones asumidas:**
- Dos bases de datos que mantener, respaldar y en las que razonar en vez de una.
- Crear o editar un producto ahora escribe en dos bases (Mongo para lo descriptivo, MySQL para precio/cantidad) sin una transacción conjunta que las cubra a ambas — si la segunda escritura falla después de que la primera tuvo éxito, queda una inconsistencia parcial. Es una versión acotada del mismo problema que Entrega 3 va a resolver formalmente para el checkout; acá se mitiga con una limpieza de mejor esfuerzo (ver implementación de `crear()`), no con una solución completa.
- El resumen de reseñas embebido en el producto (§6.1) puede quedar desactualizado si no se recalcula con disciplina — es una inconsistencia eventual aceptada a propósito, no un descuido.

---

## 6. Decisiones de modelado: embed vs. reference

Criterios del PRD: frecuencia de acceso conjunto, volumen de datos, tasa de cambio.

### 6.1 Reseñas de producto → **reference**, con resumen embebido

| Criterio | Análisis |
|---|---|
| Frecuencia de acceso conjunto | Alta — casi toda vista de producto muestra calificación/cantidad de reseñas. Pero la *lista completa* de reseñas normalmente no hace falta al listar el catálogo, solo al entrar al detalle. |
| Volumen de datos | Potencialmente **no acotado** — un producto popular puede acumular miles de reseñas. Un array embebido sin límite es exactamente el caso que la documentación de MongoDB marca como señal de "no embeber" (documentos que crecen sin cota, límite de 16 MB por documento). |
| Tasa de cambio | Las reseñas se agregan con frecuencia (muchos documentos nuevos), pero cada reseña individual casi no se edita después de creada. |

**Decisión:** colección propia `resenas`, referenciando `producto_id`. Para no perder el beneficio de "ver el rating sin una consulta aparte", el producto guarda un **resumen calculado** (patrón *computed/extended reference*, no las reseñas en sí):

```json
// colección "resenas"
{ "_id": "...", "producto_id": "ObjectId(...)", "usuario_id": 1, "calificacion": 5, "comentario": "...", "fecha": "2026-08-23T..." }

// dentro del documento de producto
{ "...": "...", "resenas_resumen": { "promedio": 4.6, "cantidad": 213 } }
```

Trade-off asumido: `resenas_resumen` requiere recalcularse cuando se crea/edita/borra una reseña (batch o al vuelo) — es la misma clase de inconsistencia eventual que ya se documentó en §5, aceptada porque el resumen no es dato crítico (a diferencia de, por ejemplo, el inventario).

### 6.2 Imágenes asociadas → **embed**

| Criterio | Análisis |
|---|---|
| Frecuencia de acceso conjunto | Total — una imagen de producto nunca se consulta sin el producto; no existe un caso de uso de "listar imágenes" de forma independiente. |
| Volumen de datos | Acotado — un producto tiene típicamente 3 a 8 fotos, no crece sin límite como las reseñas. |
| Tasa de cambio | Baja — se cargan al crear el producto y rara vez cambian después. |

Los tres criterios apuntan en la misma dirección, a diferencia de reseñas (§6.1). **Decisión:** array embebido, reemplazando el `imagen_url` único actual:

```json
{ "...": "...", "imagenes": [
  { "url": "https://...", "alt": "Camiseta azul, vista frontal", "orden": 1, "principal": true },
  { "url": "https://...", "alt": "Camiseta azul, vista trasera", "orden": 2, "principal": false }
] }
```

La migración (ETL) convierte el `imagen_url` actual de cada producto en un array de un solo elemento con `principal: true`.

### 6.3 Relación producto–vendedor → **reference**, con caché de solo lectura

| Criterio | Análisis |
|---|---|
| Frecuencia de acceso conjunto | Alta — el detalle de producto ya muestra "Vendido por {nombre}" hoy. |
| Volumen de datos | N:1 desde producto (un vendedor, no un array) — no hay problema de tamaño de documento. |
| Tasa de cambio | El vendedor es un `usuario`, que **sigue viviendo en MySQL** — esto no es negociable, porque `usuarios` no migra (§3). Por lo tanto no es una decisión embed/reference dentro de la misma base: es una **referencia cruzada entre bases**. |

**Decisión:** el documento de producto guarda `vendedor_id` (el `id_usuario` relacional), no los datos del vendedor. Para no pagar una consulta a MySQL por cada producto mostrado en una grilla de catálogo, se cachea `vendedor_nombre` de solo lectura junto al `vendedor_id`, actualizado cuando el vendedor cambia su nombre (evento poco frecuente):

```json
{ "...": "...", "vendedor_id": 2, "vendedor_nombre": "Luis Ramírez" }
```

**Esto es el "mecanismo de referencia cruzada" que pide documentar el PRD** — con el modelo dividido de §3.2, es más acotado de lo que parecía en la versión original de este documento, porque `producto`/`inventario` **no se movieron** de MySQL: `compra_detalle.id_producto` sigue siendo una `FOREIGN KEY` real hacia una fila de `producto` que sigue existiendo, sin cambios. Las referencias cruzadas de verdad son estas dos, ambas nacidas en Mongo apuntando hacia MySQL:

- **`productos.producto_id` (Mongo) → `producto.id` (MySQL):** es un número plano, no una `FOREIGN KEY` — el motor no impide que quede huérfano. Mitigación: nunca se borra un `producto` de MySQL (no hay endpoint para eso), solo se desactiva (`estado: "inactivo"` en el documento de Mongo). El ETL y `productoService.crear()` son los únicos puntos que crean esta relación, y siempre crean primero la fila MySQL y recién después el documento Mongo (ver implementación), así que un `producto_id` en Mongo apunta siempre a algo que ya existía cuando se escribió.
- **`productos.vendedor_id` (Mongo) → `usuarios.id_usuario` (MySQL):** mismo mecanismo. Si el vendedor se diera de baja (no hay endpoint para eso hoy tampoco), el documento quedaría con un `vendedor_id` huérfano — mitigación equivalente: desactivar, no borrar.

---

## 7. Próximos pasos (implementación, fuera del alcance de este documento)

1. Elegir driver/ODM de MongoDB para Node.js (Mongoose vs. driver nativo `mongodb`) — misma naturaleza de decisión que Prisma vs. Sequelize en [ADR-001](ADR-001-stack-y-migraciones.md); se documentará por separado cuando se implemente.
2. Agregar el servicio de MongoDB a `docker-compose.yml`.
3. Escribir el script de ETL (relacional → documental) para `categoria`, `subcategoria`, `producto` — reproducible, documentado, no destructivo sobre MySQL.
4. Reescribir `categoriaService`/`productoService` para leer/escribir Mongo, manteniendo el mismo contrato de API hacia el frontend en la medida de lo posible (para no tener que rehacer las pantallas ya construidas).
5. Diseñar e implementar el historial de cambios por eventos + la consulta de reconstrucción por fecha (documento aparte, es el ítem de mayor peso de Entrega 1).
6. Construir reseñas e imágenes como features nuevas sobre el modelo ya decidido acá.

---

## 8. Notas de implementación (2026-08-23)

### 8.1 Conflicto de puertos con un MongoDB nativo de Windows

Después de levantar el contenedor de Mongo (`docker compose up -d`, puerto publicado como `27017:27017`) y correr el ETL, la conexión desde Node.js vía Bash funcionaba, pero **Compass, `mongosh` y cualquier proceso lanzado desde PowerShell no veían la base `tiendaya`** — Compass listaba solo `admin`/`config`/`local`, vacías.

**Diagnóstico inicial (incorrecto):** se atribuyó el problema a algo específico de PowerShell (antivirus, variables de entorno, etc.) y se sugirió como mitigación usar siempre Bash. El usuario lo cuestionó directamente ("its also not working in the mongosh, are you sure its not a port problem or maybe a file?"), lo cual llevó a revisar el puerto en vez de asumir una causa ambiental.

**Causa real:** `Get-NetTCPConnection -LocalPort 27017` mostró que un **servicio nativo de Windows** (`MongoDB`, `C:\Program Files\MongoDB\Server\8.3\bin\mongod.exe`, arranque automático, instalado fuera de este proyecto) ya estaba escuchando en `127.0.0.1:27017`. Docker publicaba el contenedor en `0.0.0.0:27017`, pero un binding específico a `127.0.0.1` en Windows tiene precedencia sobre uno genérico en el mismo puerto — cualquier cliente que conectara a `localhost`/`127.0.0.1:27017` (que es lo que hacen Compass y `mongosh` por defecto) terminaba hablando con el Mongo nativo, no con el de Docker. Node.js lanzado desde Bash daba la casualidad de resolver la conexión distinto y sí llegaba al contenedor, lo cual ocultó la causa real al principio.

**Primer intento de fix (insuficiente):** remapear solo el puerto publicado (`"27018:27017"` en `docker-compose.yml`, puerto interno del contenedor sin cambiar). Esto arregló que Compass viera `tiendaya` vía `listDatabases`, pero una conexión *replica-set-aware* completa (la que usa transacciones multi-documento, ver [ADR-003](ADR-003-historial-cambios-eventos.md)) seguía fallando desde PowerShell. Motivo: el replica set (`rs0`) ya se había inicializado antes, con su único miembro registrado como `localhost:27017` — ese valor queda persistido en el volumen de Mongo, así que aunque el puerto *publicado* cambiara, el replica set seguía anunciándose internamente en el 27017. Intentar corregirlo con `rs.reconfig()` a `127.0.0.1:27018` falló con `MongoServerError: No host described in new configuration ... maps to this node`: Mongo exige que el host anunciado del miembro coincida con el puerto en el que `mongod` escucha *dentro* del proceso, no solo con el mapeo de Docker.

**Fix real:** mover `mongod` al puerto 27018 **adentro y afuera del contenedor** (`command: [..., "--port", "27018"]` + `ports: ["27018:27018"]`), para que el replica set se auto-inicialice ya anunciando el puerto correcto desde el principio. Como el replica set existente no se podía reconfigurar in-place hacia ese estado, hubo que descartar el volumen (`docker compose stop mongo && docker compose rm -f mongo && docker volume rm base_de_datos_2_p_mongo_data`) y recrear el contenedor desde cero. Verificado con una conexión replica-set-aware real y una transacción multi-documento de prueba, ejecutadas tanto desde PowerShell como desde Bash — ambas funcionan igual ahora. `docker-compose.yml`, `backend/.env` y `backend/.env.example` quedaron actualizados a `mongodb://localhost:27018/tiendaya?replicaSet=rs0`.

Este es un problema del entorno local (una instalación previa de MongoDB en la máquina de desarrollo), no del diseño del proyecto — no requiere ninguna decisión de arquitectura adicional, solo se documenta para que no se repita el diagnóstico si vuelve a aparecer.

### 8.2 Pérdida de un producto de prueba al recrear el volumen de Mongo

El descarte del volumen en §8.1 borró todos los documentos de Mongo, incluyendo un producto ("Casco de ciclismo", id relacional 6) que se había creado *después* de la migración, directamente vía el flujo nuevo (`productoService.crear()`), y que por lo tanto nunca tuvo una fila en la tabla relacional `categoria_producto` (esa tabla quedó en desuso, ver §5). Al volver a correr el ETL para repoblar Mongo desde MySQL, el script no pudo determinar su subcategoría por esa misma razón y lo omitió (`Producto 6 sin subcategoría asignada — se omite`), dejando su fila de `producto`/`inventario` en MySQL sin contraparte en Mongo.

Al ser dato de prueba (creado durante pruebas manuales del panel de vendedor, sin compras asociadas), se optó por eliminar la fila huérfana en MySQL en vez de reconstruirla — no había nada que migrar realmente. En un ambiente con datos reales, la fila huérfana habría sido una señal de que el ETL necesita también contemplar productos creados nativamente en Mongo (que no necesitan migrarse, solo no deberían generar una advertencia de "omitido" cuando en realidad ya están completos).
