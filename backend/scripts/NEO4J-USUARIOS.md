# Unicidad de usuarios en Neo4j

`fraudeSyncService` asegura `Usuario.id_usuario` único antes de sincronizar compras,
reseñas, publicaciones y dispositivos. El esquema se comparte entre llamadas
concurrentes y se vuelve a intentar si falla; no se reparan datos desde peticiones.

En instalaciones anteriores con nodos duplicados, preparar primero el grafo desde
`backend` (con el backend y otros escritores detenidos durante la migración):

```powershell
node scripts/unificarUsuariosNeo4j.js
node scripts/unificarUsuariosNeo4j.js --aplicar
```

El primer comando solo inspecciona. El segundo conserva un nodo por ID y elimina
únicamente duplicados cuyas propiedades y relaciones ya estén representadas en
el conservado. Valida todos los grupos antes de eliminar: si algún grupo tiene
datos distintos, aborta la transacción y requiere revisión manual. No combina
compras diferentes ni suma contadores de relaciones duplicadas.

Antes de eliminar guarda un snapshot JSON de los nodos y sus relaciones en el
directorio temporal del sistema y muestra su ruta. Al terminar aplica la
restricción `usuario_id_unico` con `IF NOT EXISTS`; repetir el comando es seguro.
Si la creación de la restricción falla, el comando termina con error: resolver
la causa y repetir antes de volver a habilitar escritores.

La reparación solo afecta el grafo derivado. No modifica MySQL, MongoDB, Redis,
casos de suspensión existentes ni reglas de confianza. Tampoco completa los
`compra_id` ausentes de relaciones históricas; eso corresponde al backfill.

Pruebas aisladas:

```powershell
node --test tests/neo4jEsquema.test.js tests/dispositivo.test.js tests/ventasSync.test.js tests/arquitecturaDeriva.test.js
```
