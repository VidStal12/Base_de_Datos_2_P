# ERD — TiendaYa (Fase Inicial)
## Análisis del diagrama entidad-relación

> Fuente: `Diagrama entidad relación Base de datos 2 , Tienda Ya.json` (exportado desde Lucidchart) · compartido por el equipo el 2026-08-22.
> Este documento transcribe y analiza el contenido del archivo para dejar registro versionado en el repositorio. **Decisión (2026-08-22):** el `.json` de Lucidchart no se versiona en Git — ver razones en §3. Este Markdown, con el diagrama Mermaid de la sección 1.2, es la fuente de verdad versionada del ERD.

---

## 0. Resumen

El archivo contiene **dos páginas** con modelos de datos distintos:

| | Página 1 | Página 2 |
|---|---|---|
| Entidades | 15 (incluye `pago`) | 21 |
| Alcance | Usuarios/direcciones, catálogo (categoría → subcategoría → atributos), inventario, carrito, compra/compra_detalle | Lo mismo salvo carrito/compra, más jerarquía geográfica (país/ciudad/departamento), un flujo de **reservas** en vez de compra directa, e historial de búsquedas con origen/destino de envío |
| Coincide con el alcance de Fase Inicial (PRD §5) | Sí, punto por punto | Parcialmente — agrega conceptos (geografía, reservas, envíos) que el PRD no menciona |
| Consistencia interna | Buena, con detalles menores (§1.4) | Varias inconsistencias: nombres duplicados, tablas repetidas, una PK sin nombre real (§2.2) |

**Confirmado (2026-08-22):** el equipo usa **Página 1** como base del modelo relacional de la Fase Inicial — cubre exactamente lo que pide el PRD (usuarios y direcciones, categorías y productos, pedidos y líneas de pedido, inventario, pagos) y es internamente más consistente. Ya incorpora la entidad `pago` agregada a partir de la observación 1.4.1. Página 2 queda documentada en la sección 2 solo como referencia histórica — no se implementa.

---

## 1. Página 1 — Modelo base confirmado para Fase Inicial

### 1.1 Entidades

| Entidad | PK | FK | Otros campos |
|---|---|---|---|
| `usuarios` | id_usuario | rol_id | nombres, apellidos, correo, contraseña, fecha_nacimiento (date) |
| `rol_usuario` | id | — | tipo_rol |
| `direcciones` | id | id_usuario | pais, direccion, codigo_postal (**decimal** ⚠) |
| `metodo_pago` | id | id_usuario | titular (varchar), token_pasarela (varchar), ultimos_4_digitos (varchar), marca (varchar) |
| `producto` | id | id_vendedor | descripcion, imagen_url, estado |
| `categoria` | id | — | categoria |
| `subcategoria` | id | id_categoria | subcategoria |
| `inventario` | id | id_producto | precio (decimal), cantidad (int) |
| `atributo_categoria` | id | id_subcategoria | atributo |
| `atributo_producto` | id | id_producto, id_atributo_categoria | ⚠ sin campo de valor (ver 1.4.3) |
| `categoria_producto` | id | id_subcategoria, id_producto | — (tabla pivote) |
| `carrito` | id | id_usuario, id_producto | cantidad, estado |
| `compra` | id | id_usuario, id_direccion | total (decimal), fecha (date) |
| `pago` | id | id_compra, id_metodo_pago | monto (decimal), estado (varchar), fecha_pago (date), referencia_transaccion (varchar) |
| `compra_detalle` | id | id_compra, id_producto | cantidad (int), precio_final, descuento, estado |

### 1.2 Diagrama

```mermaid
erDiagram
    USUARIOS {
        int id_usuario PK
        int rol_id FK
        varchar nombres
        varchar apellidos
        varchar correo
        varchar contrasena
        date fecha_nacimiento
    }
    ROL_USUARIO {
        int id PK
        varchar tipo_rol
    }
    DIRECCIONES {
        int id PK
        int id_usuario FK
        varchar pais
        varchar direccion
        varchar codigo_postal
    }
    METODO_PAGO {
        int id PK
        int id_usuario FK
        varchar titular
        varchar token_pasarela
        varchar ultimos_4_digitos
        varchar marca
    }
    PRODUCTO {
        int id PK
        int id_vendedor FK
        varchar descripcion
        varchar imagen_url
        varchar estado
    }
    CATEGORIA {
        int id PK
        varchar categoria
    }
    SUBCATEGORIA {
        int id PK
        int id_categoria FK
        varchar subcategoria
    }
    INVENTARIO {
        int id PK
        int id_producto FK
        decimal precio
        int cantidad
    }
    ATRIBUTO_CATEGORIA {
        int id PK
        int id_subcategoria FK
        varchar atributo
    }
    ATRIBUTO_PRODUCTO {
        int id PK
        int id_producto FK
        int id_atributo_categoria FK
    }
    CATEGORIA_PRODUCTO {
        int id PK
        int id_subcategoria FK
        int id_producto FK
    }
    CARRITO {
        int id PK
        int id_usuario FK
        int id_producto FK
        int cantidad
        varchar estado
    }
    COMPRA {
        int id PK
        int id_usuario FK
        decimal total
        date fecha
        int id_direccion FK
    }
    COMPRA_DETALLE {
        int id PK
        int id_compra FK
        int id_producto FK
        int cantidad
        decimal precio_final
        decimal descuento
        varchar estado
    }
    PAGO {
        int id PK
        int id_compra FK
        int id_metodo_pago FK
        decimal monto
        varchar estado
        date fecha_pago
        varchar referencia_transaccion
    }

    USUARIOS }o--|| ROL_USUARIO : tiene
    USUARIOS ||--o{ DIRECCIONES : registra
    USUARIOS ||--o{ METODO_PAGO : registra
    USUARIOS ||--o{ COMPRA : realiza
    USUARIOS ||--o{ CARRITO : posee
    USUARIOS ||--o{ PRODUCTO : vende
    DIRECCIONES ||--o{ COMPRA : recibe_en
    CATEGORIA ||--o{ SUBCATEGORIA : contiene
    SUBCATEGORIA ||--o{ ATRIBUTO_CATEGORIA : define
    SUBCATEGORIA ||--o{ CATEGORIA_PRODUCTO : clasifica
    PRODUCTO ||--o{ CATEGORIA_PRODUCTO : clasificado_en
    ATRIBUTO_CATEGORIA ||--o{ ATRIBUTO_PRODUCTO : instancia_en
    PRODUCTO ||--o{ ATRIBUTO_PRODUCTO : tiene
    PRODUCTO ||--o{ INVENTARIO : controla
    PRODUCTO ||--o{ CARRITO : agregado_en
    PRODUCTO ||--o{ COMPRA_DETALLE : incluido_en
    COMPRA ||--o{ COMPRA_DETALLE : contiene
    COMPRA ||--o{ PAGO : genera
    METODO_PAGO ||--o{ PAGO : usado_en
```

> Las cardinalidades de este diagrama reflejan lo que implican las columnas FK declaradas en cada entidad. No siempre coinciden con las puntas de flecha del archivo original de Lucidchart — ver observaciones 1.4.5 a 1.4.7.

### 1.3 Nota sobre el método de extracción

Todo lo anterior se extrajo de los datos estructurados del `.json` (figuras, campos y conectores), no de una lectura visual del diagrama renderizado. Donde el archivo tenía ambigüedades se documentan como observaciones abajo en vez de "corregirse" silenciosamente.

### 1.4 Observaciones y recomendaciones

1. ~~Falta una entidad de pago transaccional.~~ **Resuelto (2026-08-22):** se agregó `pago (id, id_compra FK, id_metodo_pago FK, monto, estado, fecha_pago, referencia_transaccion)`. Separa el instrumento guardado (`metodo_pago`) del cobro real de cada compra; `estado` modela pendiente/aprobado/rechazado/reembolsado. Un `compra` puede generar varios `pago` (reintentos, reembolsos) — ver diagrama en 1.2.

2. ~~Datos de tarjeta: tipo y seguridad.~~ **Resuelto (2026-08-22):** se quitó `codigo_seguridad` — el CVV no debe persistirse nunca, ni cifrado — y `num_tarjeta` (decimal) se reemplazó por `token_pasarela` + `ultimos_4_digitos` + `marca` (varchar). El número completo de la tarjeta ya no pasa por la base de datos: lo captura y custodia la pasarela de pago (Stripe, PayPal, MercadoPago u otra), que devuelve un token de referencia para cobros futuros y los últimos 4 dígitos para mostrarle la tarjeta al usuario. Esto además reduce el alcance de cumplimiento PCI-DSS del proyecto casi a cero, porque la aplicación nunca almacena datos sensibles de la tarjeta.

3. **`atributo_producto` no tiene campo de valor.** Vincula `producto` con `atributo_categoria`, pero no guarda el valor concreto (p. ej. atributo "Color", valor "Rojo"). Así como está, no se puede representar el atributo variable por categoría que pide el PRD (§3). Agregar `valor varchar`.

4. **`codigo_postal` como `decimal`.** Muchos códigos postales tienen ceros a la izquierda o letras (Reino Unido, Canadá); usar `varchar`.

5. **La relación `usuarios`–`compra` no está dibujada.** `compra.id_usuario` existe como FK en la tabla, pero la línea que debería unir `compra` con `usuarios` en el archivo en realidad conecta `compra_detalle` con `usuarios` (línea `p9rn8REtk6FQ`) — y `compra_detalle` no tiene columna `id_usuario`. Parece un error de trazado en Lucidchart (se enganchó la figura vecina). El diagrama de la sección 1.2 usa la relación correcta según la FK declarada; falta corregir el conector en el archivo original.

6. **Cardinalidad `inventario`↔`producto` y `carrito`↔`producto`.** El archivo dibuja ambas con `producto` del lado "muchos", pero `inventario.id_producto` y `carrito.id_producto` son FK — lo esperable es lo contrario (`producto` del lado "uno"). Si el inventario es estrictamente 1:1 por producto, conviene una restricción `UNIQUE` sobre `inventario.id_producto`; si se planea inventario por bodega o lote, falta una columna que distinga esa dimensión (p. ej. `almacen_id`).

7. **Varios conectores muestran "uno a uno" en ambos extremos** (`usuarios`–`rol_usuario`, `atributo_categoria`–`atributo_producto`, `usuarios`–`carrito`) donde la FK sugiere "uno a muchos". Vale la pena revisar las puntas de flecha directamente en Lucidchart antes de darlo por definitivo.

8. ~~`producto` no tenía dueño.~~ **Resuelto (2026-08-23):** ni Página 1 ni Página 2 modelaban qué vendedor gestiona qué producto (Página 2 tenía un campo `detalles_vendedor` en `producto`, pero era texto libre, no una relación) — con eso, cualquier usuario con rol `vendedor` podía editar el catálogo de cualquier otro. Se agregó `producto.id_vendedor` (FK a `usuarios`), con el backend exigiendo que un `vendedor` solo edite sus propios productos (un `administrador` sí puede editar cualquiera). Los 3 productos que ya existían en la base de desarrollo se migraron a nombre del vendedor sembrado por el seed — ver [ADR-001](ADR-001-stack-y-migraciones.md), patrón de migración con backfill.

9. ~~`compra_detalle` no registraba la cantidad comprada.~~ **Resuelto (2026-08-23):** tenía `precio_final` (el total de la línea) pero ningún campo para las unidades — imposible mostrar "2 × Camiseta" en un historial de pedidos, solo el total de esa línea. Se detectó recién al construir la vista de detalle de pedido del frontend. Se agregó `compra_detalle.cantidad` (int); las 5 filas de prueba que ya existían se rellenaron con `1` (son datos de desarrollo, no había forma confiable de reconstruir la cantidad real).

---

## 2. Página 2 — Modelo extendido (referencia)

Se conserva en este documento como material de referencia — por ejemplo, si más adelante se retoma la idea de direcciones con país/ciudad normalizados, o un flujo de reservas. **No es parte del alcance del proyecto ni se implementa**; la base oficial y única es la Página 1 (sección 1).

### 2.1 Entidades

| Entidad | PK | FK | Otros campos | Nota |
|---|---|---|---|---|
| `Tipo_departamento` (1) | id | Tipo | detalles, Propiedades | nombre repetido, ver 2.2 |
| `Inventario` | id | categoria_id, producto_id | cantidad, imagen_url | — |
| `usuarios` | id_usuario | pais, rol_id | nombres, apellidos, correo, contraseña, fecha_nacimiento (**int** ⚠) | fecha_nacimiento es `date` en Página 1 |
| `Ciudad` | id | Pais_id | ciudad, ubicacion | — |
| `Pais` | id | — | pais_nombre (unique), imagen_url | — |
| `rol_usuario` | id | — | tipo_rol | — |
| `compra_usuario` | id | reserva_id, usuario_id | nit, tarjeta_encriptada, fecha_pago | tarjeta cifrada — mejor práctica que `metodo_pago` de Página 1 |
| `busquedas_producto` | id | usuario_id, categoria_id, departamento_id, pais_id | origen_pais, origen_ciudad, destino_pais, destino_ciudad, fecha_envio, fecha_busqueda | parece un registro de envíos/logística, fuera del alcance descrito en el PRD |
| `Departamentos_multiples` | — | departamentos_id, categoria_id, busqueda_id | — | tabla pivote sin PK propio |
| `producto` | id | inventario_id, categoria_id | precio, detalles_vendedor, atributos_producto, detalles_propios_producto (unique) | — |
| `Reservas_producto` | id | usuario_id, producto_id, categoria_id, inventario_id | fecha_reserva, precio_total, estado, fecha_compra | reemplaza el flujo carrito+compra de Página 1 |
| `Detalles_producto_reservado_multiples` | — | detalle_producto_reservado, producto_id | — | mismos campos que `multiples_producto_reservados` |
| `Categoria` | id | departamento_productos, pais_id | categoria_principal | — |
| `Categoria_producto_pivote` | id (marcado **fk**, no pk ⚠) | id_producto, busqueda_producto_id | sub_categoria | — |
| `Tipo_departamento` (2) | — | Tipo_departamento, departamento_id | — | mismo nombre que (1), sin PK, parece pivote |
| `Pais_multiple` | — | pais_id, categoria_id | — | sin PK |
| `Historial_reservas` | id | reserva_id, usuario_id | accion, fecha_accion, detalles | — |
| `Tipos_departamento` | id | — | nombre | tercer concepto de "departamento" (ver 2.2) |
| `Detalles_producto_reservado` | **"int"** (pk) ⚠ | producto_id, reserva_producto, inventario_id | — | el nombre de la columna PK es literalmente "int" — probable error de tipeo |
| `Departamentos` | id | Tipo | nombre | — |
| `multiples_producto_reservados` | — | detalle_producto_reservado, producto_id | — | mismos campos que `Detalles_producto_reservado_multiples` |

### 2.2 Inconsistencias detectadas

- **Cuatro figuras para el concepto "departamento":** `Tipo_departamento` (con detalles/propiedades), otra tabla también llamada `Tipo_departamento` (solo dos FK, aparenta ser pivote), `Tipos_departamento` (id + nombre) y `Departamentos` (id + Tipo + nombre). No queda claro cuál es el departamento, cuál su tipo/categoría y cuál la tabla de unión.
- **Dos tablas pivote idénticas:** `Detalles_producto_reservado_multiples` y `multiples_producto_reservados` tienen exactamente los mismos campos (`detalle_producto_reservado`, `producto_id`) — parece un duplicado por copiar/pegar.
- **`Detalles_producto_reservado`** tiene su PK con el nombre de columna literalmente "int", en vez de un nombre real (p. ej. `id`).
- **`usuarios.fecha_nacimiento` es `int` aquí, pero `date` en Página 1** — inconsistencia entre páginas del mismo archivo.
- **Varias tablas pivote no declaran PK** (`Departamentos_multiples`, `Tipo_departamento` (2), `Pais_multiple`) — puede ser intencional (PK compuesta por las FK) pero no está indicado explícitamente.
- **Agrega alcance no mencionado en el PRD:** jerarquía geográfica completa (país → ciudad → departamento) y seguimiento de búsquedas con origen/destino de envío. Ninguna funcionalidad de TiendaYa descrita en el PRD requiere esto en la Fase Inicial.

---

## 3. Preguntas abiertas

Ninguna por el momento — las preguntas de la versión anterior de este documento ya se resolvieron:

- **CVV / número de tarjeta:** resuelto, ver observación 1.4.2.
- **Página 2:** se conserva como referencia, no se implementa (ver introducción de la sección 2).
- **¿Se versiona el `.json` de Lucidchart?** No. Es un export de una sola línea, no legible ni diffable, y queda desactualizado apenas alguien edite el diagrama en Lucidchart sin volver a exportar — un archivo así en el repo tiende a mentir con el tiempo. El diagrama Mermaid de la sección 1.2 cumple mejor el rol de "ERD versionado en el repo" que pide el PRD: es texto plano, se revisa en un PR como cualquier otro cambio, y se renderiza automáticamente en GitHub sin depender de una cuenta de Lucidchart. Si más adelante hace falta una imagen fija para el informe o la presentación (Entrega Final), lo útil sería exportar un **PNG/SVG** del diagrama — no el `.json` — y guardarlo en `IA/diagramas/`.

Preguntas nuevas se agregan aquí a medida que surjan.
