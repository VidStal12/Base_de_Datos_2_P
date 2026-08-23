# ADR-003 — Historial de cambios de producto por eventos (Entrega 1)

**Fecha:** 2026-08-23
**Estado:** Diseño — pendiente de implementación (depende de que MongoDB esté levantado, ver [ADR-002](ADR-002-migracion-catalogo-documental.md) §7)

> Cubre el requerimiento de mayor peso individual de Entrega 1 (1.25 de 5 pts): "cada modificación agrega un evento (sin sobrescribir); consulta de reconstrucción del estado en fecha arbitraria". Es diseño, no código — no hay todavía una instancia de MongoDB corriendo (ver ADR-002 §7).

---

## 1. Contexto

`productoService.actualizar()` (relacional, hoy) hace `UPDATE`/`upsert` directo — el valor anterior desaparece en cuanto se guarda el nuevo. Migrar a Mongo (ADR-002) no resuelve esto por sí solo: si el nuevo `productoService` contra Mongo simplemente hace `updateOne` sobre el documento, el problema es exactamente el mismo, solo que en otra base de datos. Hace falta un mecanismo explícito de historial, y una consulta que responda "¿cómo estaba este producto el 1 de agosto?" sin haber guardado esa fecha exacta de antemano.

## 2. Alternativas consideradas

| Opción | Cómo funciona | Costo de lectura (estado actual) | Costo de lectura (reconstrucción histórica) | Complejidad de escritura |
|---|---|---|---|---|
| **A. Event sourcing puro** | No existe "el producto" como documento independiente — solo existe la secuencia de eventos. El estado actual (y cualquier estado pasado) se calcula reproduciendo eventos desde el principio. | Alto — cada vista de catálogo tendría que reproducir todo el historial de cada producto, o mantener una vista materializada aparte (con lo cual ya no es "puro") | Igual de costoso que leer el estado actual | Simple — solo se inserta el evento |
| **B. Snapshot completo por evento + colección de estado actual** | La colección `productos` tiene el estado vigente (igual que hoy). Cada `crear`/`actualizar` además inserta en `producto_eventos` una **copia completa** del documento resultante, con fecha y versión. | Igual que hoy — una lectura directa de `productos`, sin tocar el historial | Una consulta: el evento más reciente con `fecha <= X` | Un insert extra por escritura, dentro de la misma transacción |
| **C. Delta por evento** (como B, pero el evento guarda solo los campos que cambiaron, no el documento completo) | Igual que B para lectura del estado actual | Hay que reproducir (fold) todos los deltas desde el evento más antiguo hasta la fecha pedida, en orden | Escritura más liviana (menos bytes por evento) que B, pero calcular el diff exige más código | |

**Se descarta A:** el catálogo se lee constantemente (es la pantalla principal de la tienda) y la reconstrucción histórica es una consulta rara/administrativa — optimizar el caso frecuente a costa del caso raro es exactamente al revés de lo que conviene acá. Además, "sin vista materializada" es poco realista en la práctica: casi cualquier sistema de event sourcing real termina manteniendo una proyección del estado actual de todos modos, con lo que A termina pareciéndose a B pero con más partes móviles.

**Se descarta C** frente a B: el ahorro de espacio no compensa la complejidad de tener que reproducir N deltas en orden para reconstruir una fecha, contra una sola consulta ordenada por fecha en B. Con el volumen de datos de este proyecto (un catálogo de un curso, no miles de ediciones por producto por día), el espacio extra de guardar snapshots completos es insignificante.

## 3. Decisión

**Opción B:** colección `productos` con el estado vigente (ya definida en ADR-002) + colección separada `producto_eventos`, *append-only*, donde cada evento es un snapshot completo del producto en el momento de la escritura.

### 3.1 Esquema

```json
// colección "productos" — estado vigente (agrega version/actualizado_en a lo ya definido en ADR-002)
{
  "_id": ObjectId("..."),
  "descripcion": "Camiseta básica de algodón",
  "estado": "activo",
  "subcategoria_id": ObjectId("..."),
  "vendedor_id": 2,
  "vendedor_nombre": "Luis Ramírez",
  "precio": 89.99,
  "cantidad": 43,
  "atributos": [{ "nombre": "Talla", "valor": "M" }, { "nombre": "Color", "valor": "Azul" }],
  "imagenes": [{ "url": "...", "alt": "...", "orden": 1, "principal": true }],
  "resenas_resumen": { "promedio": 4.6, "cantidad": 213 },
  "version": 3,
  "actualizado_en": ISODate("2026-08-20T14:00:00Z")
}
```

```json
// colección "producto_eventos" — historial, nunca se actualiza ni se borra
{
  "_id": ObjectId("..."),
  "producto_id": ObjectId("..."),
  "version": 3,
  "tipo": "creacion" | "edicion",
  "fecha": ISODate("2026-08-20T14:00:00Z"),
  "usuario_id": 2,
  "campos_modificados": ["precio", "cantidad"],
  "snapshot": {
    "descripcion": "Camiseta básica de algodón",
    "estado": "activo",
    "precio": 89.99,
    "cantidad": 43,
    "atributos": [{ "nombre": "Talla", "valor": "M" }, { "nombre": "Color", "valor": "Azul" }],
    "imagenes": [{ "url": "...", "alt": "...", "orden": 1, "principal": true }]
  }
}
```

`snapshot` deliberadamente **no** incluye `resenas_resumen`: es un agregado calculado (ADR-002 §6.1), no un dato editado por el vendedor — versionarlo junto con el resto mezclaría "cambios que hizo alguien" con "recálculos automáticos" en la misma línea de tiempo, que son dos cosas distintas. `vendedor_id`/`vendedor_nombre` tampoco se versionan por evento: quién vende el producto no es parte de "cómo estaba el producto" en el sentido que pide el PRD (descripción, precio, stock, atributos).

### 3.2 Escritura: un evento por cada `crear`/`actualizar`, atómico con el cambio de estado

Igual que el checkout relacional usa `prisma.$transaction` para que "descontar inventario" y "crear el pedido" sean atómicos, acá hace falta que "actualizar el documento vigente" y "grabar el evento" lo sean — si el evento se pierde pero el documento sí cambió (o viceversa), el historial queda mentiroso. MongoDB soporta transacciones multi-documento desde 4.0 (requiere que el servidor corra como *replica set*, aunque sea de un solo nodo — detalle de infraestructura a resolver en el docker-compose cuando se implemente, no parte de este diseño):

```js
// pseudocódigo — productoService.actualizar(), versión Mongo
async function actualizar(vendedor, productoId, cambios) {
  const session = await mongoose.startSession();
  await session.withTransaction(async () => {
    const anterior = await Producto.findById(productoId).session(session);
    verificarPermiso(vendedor, anterior); // misma lógica de ownership que ya existe

    const nuevaVersion = anterior.version + 1;
    const actualizado = await Producto.findByIdAndUpdate(
      productoId,
      { ...cambios, version: nuevaVersion, actualizado_en: new Date() },
      { new: true, session }
    );

    await ProductoEvento.create([{
      producto_id: productoId,
      version: nuevaVersion,
      tipo: 'edicion',
      fecha: actualizado.actualizado_en,
      usuario_id: vendedor.id_usuario,
      campos_modificados: Object.keys(cambios),
      snapshot: snapshotDe(actualizado),
    }], { session });
  });
}
```

`crear()` sigue el mismo patrón, con `tipo: 'creacion'` y `version: 1`, en la misma transacción que crea el documento.

### 3.3 Lectura: reconstrucción del estado en una fecha arbitraria

```js
// El evento vigente en una fecha es el más reciente con fecha <= la consultada
const evento = await ProductoEvento
  .findOne({ producto_id: productoId, fecha: { $lte: fechaConsultada } })
  .sort({ fecha: -1 });

if (!evento) {
  // no hay ningún evento antes de esa fecha: el producto todavía no existía
  throw new Error('El producto no existía en esa fecha');
}
return evento.snapshot;
```

Un único `findOne` con `sort` — no hace falta reproducir ni acumular nada, que es exactamente la ventaja de guardar snapshots completos (§2, opción B) en vez de deltas.

### 3.4 Índice y agregación (requerimientos técnicos de Entrega 1, no solo de este ADR)

El patrón de consulta de §3.3 (filtrar por `producto_id`, ordenar por `fecha` descendente) es exactamente lo que pide indexar un compuesto:

```js
db.producto_eventos.createIndex({ producto_id: 1, fecha: -1 });
```

Esto **es** el "al menos un índice compuesto mapeado a un patrón de consulta real" que pide el PRD como requerimiento técnico de Entrega 1 — no hace falta inventar un índice aparte, sale directo de este diseño.

De la misma colección sale también una agregación natural — por ejemplo, cantidad de ediciones por producto en los últimos 30 días (útil para un panel de "productos más editados"):

```js
db.producto_eventos.aggregate([
  { $match: { fecha: { $gte: hace30Dias } } },
  { $group: { _id: "$producto_id", ediciones: { $sum: 1 } } },
  { $sort: { ediciones: -1 } },
]);
```

### 3.5 Endpoint propuesto

```
GET /api/productos/:id/historial?fecha=2026-08-01   → snapshot vigente en esa fecha (§3.3)
GET /api/productos/:id/historial                     → lista completa de eventos (línea de tiempo, para el panel de vendedor)
```

## 4. Justificación

- **Patrón de consulta real:** el catálogo se lee todo el tiempo, el historial se consulta rara vez — la opción B optimiza el caso frecuente sin penalizarlo, y resuelve el caso raro en una sola consulta indexada.
- **Atomicidad:** usa el mismo patrón ya validado en este proyecto (`prisma.$transaction` para el checkout) aplicado a Mongo — no es una técnica nueva para el equipo, es la misma idea en otra base de datos.
- **Simplicidad de la reconstrucción:** snapshots completos hacen que "estado en fecha X" sea un `findOne` con `sort`, no un algoritmo de reproducción de deltas.

## 5. Consecuencias

**Beneficios:**
- Satisface el requerimiento de mayor peso de Entrega 1 con un diseño que reutiliza patrones (transacciones) que ya se usaron y probaron en la Fase Inicial.
- El índice y la agregación que pide el PRD como requerimientos aparte salen del mismo diseño, no hay que forzarlos después.

**Limitaciones asumidas:**
- Cada edición duplica el documento completo en `producto_eventos` — más espacio en disco que guardar solo deltas (opción C, descartada en §2). Aceptable al volumen de este proyecto; si un producto se editara miles de veces, valdría la pena revisar esta decisión.
- Requiere que MongoDB corra como replica set (aunque sea de un nodo) para poder usar transacciones — una restricción de infraestructura a resolver en `docker-compose.yml` cuando se implemente, no un problema de diseño, pero hay que tenerlo presente.
- `resenas_resumen` y datos del vendedor quedan fuera del snapshot a propósito (§3.1) — si en el futuro se pidiera reconstruir "cuántas reseñas tenía en tal fecha", este diseño no lo respondería sin extenderlo.

## 6. Próximos pasos (implementación)

Depende de que se resuelvan primero los puntos de infraestructura de [ADR-002 §7](ADR-002-migracion-catalogo-documental.md#7-próximos-pasos-implementación-fuera-del-alcance-de-este-documento) (Mongo levantado, driver/ODM elegido, ETL corrido). Una vez ahí: implementar `productoService` contra Mongo con el patrón de transacción de §3.2, los dos endpoints de §3.5, y el índice de §3.4.
