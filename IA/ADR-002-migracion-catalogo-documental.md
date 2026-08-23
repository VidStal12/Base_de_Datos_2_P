# ADR-002 — Migración del catálogo a base documental (Entrega 1)

**Fecha:** 2026-08-23
**Estado:** Diagnóstico y decisiones de modelado — pendiente de implementación (ver §7)

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

Migrar a MongoDB: `categoria`, `subcategoria` (con las definiciones de atributo embebidas — ver §3.1) y `producto` (con sus valores de atributo embebidos, ver §6). Reseñas e imágenes nacen documentales directamente (son features nuevas, no había nada que migrar). Todo lo demás — `usuarios`, `rol_usuario`, `direcciones`, `metodo_pago`, `carrito`, `compra`, `pago`, `compra_detalle` — se queda en MySQL: son datos transaccionales con integridad fuerte entre sí (pedidos, pagos, inventario) donde el modelo relacional ya funciona bien y donde el PRD no pide ni sugiere migrarlos.

### 3.1 Simplificación que trae el modelo documental

En Mongo no hace falta una colección separada para "qué atributos tiene esta subcategoría" — se puede embeber directamente como plantilla dentro del documento de la subcategoría:

```json
// colección "subcategorias"
{
  "_id": "ObjectId(...)",
  "categoria": "Ropa",
  "subcategoria": "Camisetas",
  "atributos_definidos": ["Talla", "Color"]
}
```

Y el producto guarda directamente nombre + valor, sin ninguna tabla de definición que joinear:

```json
// colección "productos"
{
  "_id": "ObjectId(...)",
  "descripcion": "Camiseta básica de algodón",
  "estado": "activo",
  "subcategoria_id": "ObjectId(...)",
  "precio": 89.99,
  "cantidad": 43,
  "atributos": [
    { "nombre": "Talla", "valor": "M" },
    { "nombre": "Color", "valor": "Azul" }
  ]
}
```

Esto reemplaza los siete joins de §1.1 por una sola lectura de documento para todo lo que no sea vendedor/reseñas (ver §6).

---

## 4. Justificación

- **Patrón de consulta:** el acceso real del sistema es casi siempre "traer un producto completo" o "listar productos de una subcategoría con sus atributos" — exactamente el acceso que un documento auto-contenido resuelve en una lectura, contra siete tablas hoy.
- **Escalabilidad de esquema:** cada categoría define sus propios atributos sin migraciones de esquema ni columnas `NULL`; ya lo estábamos simulando con EAV, Mongo lo hace nativo.
- **Consistencia:** los datos financieros/transaccionales (pedidos, pagos, inventario descontado atómicamente) exigen las garantías ACID fuertes que ya tenemos en MySQL — por eso esos no se tocan. El catálogo, en cambio, tolera consistencia eventual entre el conteo de reseñas embebido y la colección de reseñas real (ver §6.1) sin que eso rompa nada crítico.
- **Costo operativo:** se suma una base de datos más para operar, pero es exactamente el costo que el PRD espera que se pague cuando el análisis lo justifica — no cambiar tecnologías "porque sí" tiene el mismo peso de evaluación que cambiarlas, y acá el diagnóstico (§1) sostiene el cambio.

## 5. Consecuencias

**Beneficios:**
- Detalle de producto pasa de 7 tablas a 1 documento (+ vendedor, ver §6.3).
- Agregar un atributo nuevo a una categoría deja de requerir filas EAV — es directamente parte del documento.
- El historial de cambios por evento (requerimiento de mayor peso de Entrega 1, ver ESTADO-PROYECTO.md) tiene un modelo natural: cada evento es un snapshot del documento completo.

**Limitaciones asumidas:**
- Se pierde la integridad referencial de base de datos entre `compra_detalle.id_producto` (MySQL) y el documento de producto (Mongo) — hay que documentarlo y manejarlo en código, no en el motor (ver §6.3, mismo mecanismo que aplica para producto→vendedor).
- Dos bases de datos que mantener, respaldar y en las que razonar en vez de una.
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

**Esta es la misma clase de problema que "Documentación del mecanismo de referencia cruzada" pide el PRD para `compra_detalle.id_producto` (MySQL) → producto (Mongo), solo que en la dirección opuesta.** En ambos casos, el motor de base de datos no puede garantizar la integridad referencial (no hay `FOREIGN KEY` que cruce MySQL↔Mongo), así que la garantía pasa a ser responsabilidad de la aplicación:

- **`compra_detalle.id_producto` → producto en Mongo:** si un producto se borra de Mongo, las líneas de pedido relacionales que lo referencian quedan con un ID que ya no resuelve a nada. Igual que hoy con `producto.estado`, la mitigación es no borrar productos — desactivarlos (`estado: "inactivo"`), igual que ya hace el panel de vendedor actual. El pedido histórico sigue mostrando lo que se compró (vía `compra_detalle.cantidad`/`precio_final`, que ya son un snapshot del momento de compra, no un link vivo al producto).
- **`producto.vendedor_id` → usuario en MySQL:** si el vendedor se diera de baja, el producto queda con un `vendedor_id` huérfano. Mitigación equivalente: no se contempla borrar usuarios (no hay ni un endpoint para eso hoy), solo desactivarlos.

---

## 7. Próximos pasos (implementación, fuera del alcance de este documento)

1. Elegir driver/ODM de MongoDB para Node.js (Mongoose vs. driver nativo `mongodb`) — misma naturaleza de decisión que Prisma vs. Sequelize en [ADR-001](ADR-001-stack-y-migraciones.md); se documentará por separado cuando se implemente.
2. Agregar el servicio de MongoDB a `docker-compose.yml`.
3. Escribir el script de ETL (relacional → documental) para `categoria`, `subcategoria`, `producto` — reproducible, documentado, no destructivo sobre MySQL.
4. Reescribir `categoriaService`/`productoService` para leer/escribir Mongo, manteniendo el mismo contrato de API hacia el frontend en la medida de lo posible (para no tener que rehacer las pantallas ya construidas).
5. Diseñar e implementar el historial de cambios por eventos + la consulta de reconstrucción por fecha (documento aparte, es el ítem de mayor peso de Entrega 1).
6. Construir reseñas e imágenes como features nuevas sobre el modelo ya decidido acá.
