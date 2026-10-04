# PRD — TiendaYa
## Bases de Datos 2 · Proyecto de Curso

> **Ingeniería en Sistemas y Ciencias de la Computación**  
> Proyecto de semestre · cuatro entregas · desarrollo en equipo

---

## 1. Resumen ejecutivo

**TiendaYa** es un portal de comercio electrónico de escala intermedia desarrollado como proyecto de curso para demostrar criterio técnico en la selección de tecnologías de bases de datos dentro de una **arquitectura políglota**. El sistema se construye de manera incremental a lo largo del semestre en cuatro entregas, cada una incorporando una nueva familia de base de datos sobre la capa anterior.

La complejidad del proyecto reside en las **decisiones de arquitectura de datos**, no en la lógica de negocio del e-commerce. El criterio de evaluación central es la calidad del análisis técnico: justificar mantener un componente relacional tiene el mismo peso que justificar una migración a NoSQL.

---

## 2. Objetivo del proyecto

- Fundamentar, con criterios técnicos, la selección de tecnologías de bases de datos para problemas concretos.
- Construir un sistema políglota funcional que integre múltiples familias de bases de datos.
- Documentar cada decisión arquitectónica con un Registro de Decisión (ADR).
- Demostrar que la calidad del análisis importa más que la cantidad de tecnologías incorporadas.

---

## 3. Alcance funcional completo

| Módulo / Funcionalidad | Descripción | Componente de Persistencia | Entrega |
|---|---|---|---|
| Registro y autenticación | Alta de usuarios, login, roles: comprador / vendedor / administrador | Modelo relacional | Fase inicial |
| Catálogo de productos | Alta, edición y consulta con atributos variables por categoría | Base documental | Entrega 1 |
| Historial de cambios del producto | Reconstrucción del estado de un producto en un punto del tiempo | Base documental | Entrega 1 |
| Carrito de compra | Persistencia por sesión con expiración por inactividad | Almacén clave-valor | Entrega 2 |
| Oferta con inventario limitado | Venta bajo alta concurrencia sin sobreventa | Almacén clave-valor | Entrega 2 |
| Detección de fraude en reseñas | Identificación de relaciones anómalas entre cuentas, reseñas y productos. *Alcance implementado por el equipo (ver [PLAN-NEO4J-DETECCION-FRAUDE.md](PLAN-NEO4J-DETECCION-FRAUDE.md) §18):* seis señales sobre cuentas, reseñas, compras y vendedores — reseñas coordinadas, gasto anómalo, categoría inusual, cuentas de una misma persona (mismo nombre o mismo buzón de correo), ráfaga de gasto y autocompra; además, el sistema impide que un vendedor compre sus propios productos | Base de grafos *(según decisión del equipo)* | Entrega 2 |
| Panel de tendencias de venta | Ventas por intervalos de tiempo y productos en ascenso de demanda | Base columnar *(según decisión del equipo)* | Entrega 2 |
| Búsqueda de productos | Texto libre con tolerancia a variaciones y relevancia | Motor de búsqueda | Entrega 3 |
| Proceso de compra distribuido | Checkout con múltiples componentes y estrategia de consistencia definida | Relacional + NoSQL | Entrega 3 |
| Pedidos y pagos | Registro transaccional de pedidos y pagos | Modelo relacional | Fase inicial → transversal |
| Productos relacionados por contenido | Sugerencias por similitud semántica de descripción | Base vectorial | Entrega final |
| Control de acceso a datos | Autenticación y autorización en al menos un componente NoSQL | Según arquitectura | Entrega final |
| Panel administrativo | Catálogo, pedidos, inventario y reportes | Múltiples fuentes | Transversal |

---

## 4. Arquitectura de datos de referencia

| Componente | Opción de referencia | Alternativa equivalente |
|---|---|---|
| Modelo relacional | PostgreSQL | MySQL / MariaDB |
| Base documental | MongoDB | — |
| Almacén clave-valor | Redis | — |
| Base de grafos | Neo4j | — |
| Base columnar | Apache Cassandra | ScyllaDB |
| Motor de búsqueda | Elasticsearch | OpenSearch |
| Componente vectorial | pgvector (extensión PostgreSQL) | Cualquier alternativa con soporte vectorial |
| Backend / API | A elección del equipo | — |
| Frontend | A elección del equipo | Evaluado por funcionalidad, no por diseño |

---

## 5. Entregas y requerimientos

### 🔷 Fase Inicial — Modelo Transaccional Base
> **Semana previa a la semana 4** · Sin puntuación independiente (evaluada en Entrega 1)

**Contexto:** Base relacional propia que sirve de punto de partida para todas las entregas.

**Requerimientos:**
- [ ] Modelo relacional normalizado en **3FN mínimo** (PostgreSQL o MySQL) que cubra:
  - Usuarios y direcciones
  - Categorías y productos
  - Pedidos y líneas de pedido
  - Pagos
  - Inventario
- [ ] Diagrama Entidad-Relación (ERD) con justificación de decisiones de normalización
- [ ] Flujo de compra como **transacción atómica**: pedido + líneas + pago + descuento de inventario
- [ ] Repositorio con DDL versionado y datos de prueba representativos

**Entregable mínimo:** Esquema normalizado + checkout transaccional en funcionamiento

---

### 🟢 Entrega 1 — Base Documental
> **Semana 4** · Documentales I y II · **5 puntos (Nota 1)**

**Contexto:** El esquema relacional fijo no puede representar de forma eficiente atributos heterogéneos entre categorías de productos ni mantener historial de cambios.

**Funcionalidades:**
- Catálogo con filtros por categoría (atributos relevantes por tipo de producto)
- Panel administrativo: formulario adaptable por categoría al crear/editar productos
- Vista de detalle de producto
- Consulta del estado histórico de un producto en una fecha arbitraria

**Requerimientos técnicos:**
- [ ] **Migración** documentada y reproducible de productos: modelo relacional → base documental
- [ ] **Decisión embed vs. reference** fundamentada para:
  - Reseñas de producto
  - Imágenes asociadas
  - Relación producto–vendedor
  *(criterios: frecuencia de acceso conjunto, volumen de datos, tasa de cambio)*
- [ ] Al menos **un índice compuesto** mapeado a un patrón de consulta real
- [ ] Al menos **una consulta de agregación** usando el framework de la base documental
- [ ] **Historial de cambios por eventos**: cada modificación agrega un evento (sin sobrescribir); consulta de reconstrucción del estado en fecha arbitraria
- [ ] Documentación del mecanismo de referencia cruzada: líneas de pedido (relacionales) → productos (documentales), sin exigir integridad referencial garantizada en esta etapa

**Entregable:**
- Informe: modelo relacional base + diagnóstico + decisión documental justificada + evidencia de funcionamiento
- Repositorio: script de migración + código del catálogo

**Rúbrica (5 pts):**

| Criterio | Peso |
|---|---|
| Diseño y normalización del modelo relacional base | 0.5 pts |
| Diagnóstico del problema y justificación de la migración | 0.75 pts |
| Decisión embed/reference debidamente argumentada | 1.0 pt |
| Implementación funcional del catálogo (índice + agregación) | 1.0 pt |
| Historial de cambios + consulta de reconstrucción por fecha | 1.25 pts |
| Calidad del informe y del repositorio | 0.5 pts |

---

### 🟡 Entrega 2 — Clave-Valor, Columnar, Grafos
> **Semana 8** · **10 puntos (Nota 2)**

**Contexto:** El carrito relacional genera escrituras/lecturas frecuentes de datos transitorios. La venta de unidades limitadas bajo concurrencia exige atomicidad sin bloqueos de aplicación. Las necesidades de análisis de fraude y tendencias requieren evaluación de familias distintas.

**Funcionalidades:**
- Carrito persistente por sesión con **expiración automática** por inactividad
- Oferta flash: N unidades disponibles bajo múltiples solicitudes concurrentes, sin sobreventa
- Panel administrativo: patrones de posible manipulación de reseñas *(si se elige grafos)*
- Panel de actividad de ventas por intervalos de tiempo *(si se elige columnar)*

**Requerimientos técnicos:**
- [ ] Carrito sobre **almacén clave-valor** (Redis) con TTL configurado explícitamente y efecto documentado sobre el checkout
- [ ] Oferta de inventario limitado mediante **operaciones atómicas** del almacén clave-valor, validada bajo concurrencia simulada (sin bloqueos a nivel de aplicación)
- [ ] **Evaluación comparativa** de grafos vs. columnar para los dos requerimientos de análisis (criterios específicos al sistema, no genéricos)
- [ ] **Implementación de al menos una familia:**
  - **Si grafos (Neo4j):** modelo de cuentas-reseñas-productos + consulta multi-salto que detecte patrón anómalo de interacción
  - **Si columnar (Cassandra/ScyllaDB):** modelo orientado a intervalos de tiempo + consulta que identifique variaciones de demanda entre períodos
- [ ] Para la familia **no seleccionada**: documentación de condiciones bajo las cuales su incorporación estaría justificada

**Entregable:**
- Documento de decisión técnica
- Repositorio: almacén clave-valor + oferta de inventario + familia seleccionada implementada
- Diagrama de arquitectura actualizado

**Rúbrica (10 pts):**

| Criterio | Peso |
|---|---|
| Implementación del carrito (clave-valor + expiración justificada) | 1.5 pts |
| Oferta de inventario limitado con operaciones atómicas bajo concurrencia | 3.0 pts |
| Evaluación comparativa grafos vs. columnar | 1.5 pts |
| Implementación de la familia seleccionada + reto específico | 3.0 pts |
| Calidad del informe + diagrama de arquitectura actualizado | 1.0 pt |

---

### 🟠 Entrega 3 — Motor de Búsqueda, Transacciones Distribuidas
> **Semana 12** · Motores de búsqueda · Transacciones · NewSQL · **15 puntos (Nota 3)**

**Contexto:** La búsqueda por texto exacto no es suficiente para un catálogo real. El checkout ahora involucra múltiples componentes de persistencia, creando riesgo de fallos parciales sin estrategia de consistencia explícita.

**Funcionalidades:**
- Búsqueda de productos por texto libre con **tolerancia ortográfica** y ordenamiento por relevancia
- **Filtros facetados** sobre resultados (calculados con agregaciones del motor de búsqueda)
- Manejo explícito de fallos parciales en el checkout con comportamiento definido y comunicado al usuario

**Requerimientos técnicos:**
- [ ] **Índice de búsqueda** del catálogo con mapping definido deliberadamente (no configuración por defecto)
- [ ] Al menos una funcionalidad de **autocompletado** o corrección ortográfica
- [ ] Al menos una **agregación** para filtros facetados
- [ ] **Documento de estrategia de consistencia** para el checkout distribuido:
  - Identificar cada componente involucrado
  - Mapear puntos de falla posibles
  - Mecanismo de mitigación: reintentos idempotentes / patrón de compensación / consistencia eventual documentada
- [ ] **Prueba de falla simulada** sobre el checkout con evidencia del comportamiento del sistema
- [ ] *(Opcional / puntuación extra)* Evaluación de migración del módulo de pagos a **NewSQL**, contrastando con el modelo relacional vigente

**Entregable:**
- Buscador implementado
- Documento de estrategia de consistencia + evidencia de prueba de falla
- Diagrama de arquitectura actualizado

**Rúbrica (15 pts):**

| Criterio | Peso |
|---|---|
| Buscador con tolerancia a variaciones + filtros facetados | 5.0 pts |
| Documento de estrategia de consistencia para checkout distribuido | 5.0 pts |
| Evidencia de prueba de falla simulada y su manejo | 4.0 pts |
| Calidad del informe y del repositorio | 1.0 pt |

---

### 🔴 Entrega Final — Vectorial, Seguridad y Cierre
> **Semana 15** · Operación · Seguridad · Bases Vectoriales · **20 puntos (Nota final)**

**Contexto:** El sistema opera sobre múltiples componentes de persistencia. Restan dos aspectos críticos: control de acceso en los componentes NoSQL y recomendación semántica de productos.

**Funcionalidades:**
- Recomendación de productos por **similitud semántica** de descripción (en página de producto o principal)
- **Control de acceso** configurado en al menos un componente NoSQL, con roles y permisos acotados por servicio

**Requerimientos técnicos:**
- [ ] **Búsqueda semántica vectorial**: embeddings de descripciones de productos + consulta de similitud (pgvector u alternativa)
- [ ] **Autenticación y autorización explícita** en al menos un componente NoSQL, con evidencia de que usuarios sin permiso no pueden operar fuera de su alcance
- [ ] **Diagrama de arquitectura final** que refleje todos los componentes de persistencia y sus relaciones
- [ ] **Documento de retrospectiva** que identifique:
  - Qué decisiones arquitectónicas se sostendrían
  - Cuáles se replantearían
  - Justificación en ambos casos
- [ ] **Presentación del proyecto** ante el curso

**Entregable:**
- Repositorio completo del sistema
- Informe de arquitectura final
- Presentación del proyecto

**Rúbrica (20 pts):**

| Criterio | Peso |
|---|---|
| Funcionalidad de recomendación semántica | 5.0 pts |
| Control de acceso en componente NoSQL | 4.0 pts |
| Diagrama de arquitectura final, completo y correcto | 3.0 pts |
| Documento de retrospectiva | 4.0 pts |
| Presentación: claridad + capacidad de sustentar decisiones | 4.0 pts |

---

## 6. Registro de Decisiones Arquitectónicas (ADR)

Cada decisión de incorporar o excluir un componente debe documentarse con la siguiente estructura:

| Campo | Contenido esperado |
|---|---|
| **Contexto** | Problema identificado con evidencia concreta |
| **Alternativas consideradas** | Al menos dos opciones (incluyendo "no cambiar") |
| **Decisión** | Alternativa seleccionada |
| **Justificación** | Criterios técnicos: consistencia, escalabilidad, patrón de consulta, costo operativo |
| **Consecuencias** | Beneficios obtenidos y limitaciones asumidas |

> **Nota importante:** Justificar mantener un componente relacional con análisis fundamentado se evalúa con **el mismo rigor** que justificar una migración. El criterio determinante es la **calidad del análisis**, no la cantidad de tecnologías.

---

## 7. Lineamientos del equipo

- **Tamaño del equipo:** 2 a 3 integrantes para la totalidad del semestre
- **Distribución de responsabilidades:** debe indicarse en cada entrega
- **Repositorio:** único para el proyecto completo, con historial incremental visible
- **Documentación:** actualizada en cada entrega con instrucciones de instalación y ejecución

---

## 8. Roadmap resumido

```
Semana previa a 4   →  Fase Inicial:  Modelo relacional + checkout transaccional
Semana 4            →  Entrega 1:     Base documental (catálogo + historial)
Semana 8            →  Entrega 2:     Clave-valor + grafos o columnar
Semana 12           →  Entrega 3:     Motor de búsqueda + consistencia distribuida
Semana 15           →  Entrega Final: Vectorial + seguridad + presentación
```

---

## 9. Pendientes / Información por completar

> Los siguientes campos se completarán con información adicional del equipo:

- [ ] **Nombres de los integrantes del equipo**
- [x] **Stack tecnológico elegido** (backend, frontend, ORM/ODM): Node.js (JavaScript) + React · MySQL en contenedor Docker · ORM — ver [ADR-001](ADR-001-stack-y-migraciones.md)
- [x] **Decisiones preliminares de arquitectura** (e.g., grafos vs. columnar para Entrega 2): resueltas — el equipo incorporó las dos familias, Cassandra para el panel de ventas ([ADR-004](ADR-004-analitica-ventas-cassandra.md)) y Neo4j para detección de fraude ([PLAN-NEO4J-DETECCION-FRAUDE.md](PLAN-NEO4J-DETECCION-FRAUDE.md)); Elasticsearch para la búsqueda de Entrega 3 ([PLAN-ELASTICSEARCH-BUSQUEDA.md](PLAN-ELASTICSEARCH-BUSQUEDA.md))
- [ ] **Enlace al repositorio del proyecto**
- [x] **Estrategia de consistencia preliminar** para el checkout distribuido: documentada y probada con dos fallas reales simuladas — [ENTREGA-3-CONSISTENCIA.md](ENTREGA-3-CONSISTENCIA.md)
- [x] **Modelo de datos relacional inicial** (ERD): confirmado — Página 1 de [ERD.md](ERD.md), con entidad `pago` incorporada
- [ ] **Cronograma interno del equipo** con milestones por entrega

---
