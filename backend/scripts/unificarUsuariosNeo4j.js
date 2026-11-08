// Por defecto solo inspecciona. --aplicar elimina únicamente nodos redundantes:
// cada propiedad y cada relación del duplicado deben existir ya en el conservado.
// Si difieren, aborta TODA la transacción; nunca elige qué evidencia descartar.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const GRUPOS = `
MATCH (u:Usuario)
WHERE u.id_usuario IS NOT NULL
WITH u ORDER BY elementId(u)
WITH u.id_usuario AS id, collect(elementId(u)) AS nodos
WHERE size(nodos) > 1
RETURN id, nodos`;

const ES_REDUNDANTE = `
MATCH (c:Usuario), (d:Usuario)
WHERE elementId(c) = $conservar AND elementId(d) = $duplicado
RETURN properties(c) = properties(d)
  AND size(labels(c)) = size(labels(d)) AND all(l IN labels(d) WHERE l IN labels(c))
  AND NOT EXISTS {
    MATCH (d)-[r]-(otro)
    WHERE NOT EXISTS {
      MATCH (c)-[s]-(otro)
      WHERE type(r) = type(s) AND properties(r) = properties(s)
        AND (startNode(r) = d) = (startNode(s) = c)
    }
  } AS seguro`;

async function unificar(driver, { aplicar = false } = {}) {
  const sesion = driver.session();
  try {
    return await sesion.executeWrite(async (tx) => {
      const grupos = (await tx.run(GRUPOS)).records.map((r) => r.toObject());
      // Bloquea los nodos antes de validar: una escritura concurrente no debe
      // cambiar sus relaciones entre la comprobación y la eliminación.
      if (aplicar && grupos.length) {
        await tx.run(`MATCH (u:Usuario) WHERE elementId(u) IN $nodos
          SET u.id_usuario = u.id_usuario`, { nodos: grupos.flatMap((g) => g.nodos) });
      }
      const pares = grupos.flatMap((g) => g.nodos.slice(1).map((duplicado) => ({ conservar: g.nodos[0], duplicado })));
      for (const par of pares) {
        const comprobacion = await tx.run(ES_REDUNDANTE, par);
        if (comprobacion.records[0]?.get('seguro') !== true) {
          throw new Error('Los usuarios duplicados tienen datos distintos; se necesita una revisión manual. No se aplicó ningún cambio.');
        }
      }
      let respaldo = null;
      if (aplicar && pares.length) {
        const snapshot = await tx.run(`MATCH (u:Usuario) WHERE elementId(u) IN $nodos
          OPTIONAL MATCH (u)-[r]-(otro)
          RETURN elementId(u) AS nodo, labels(u) AS etiquetas, properties(u) AS datos,
            collect({tipo: type(r), propiedades: properties(r), otro: elementId(otro), salida: startNode(r) = u}) AS relaciones`,
        { nodos: grupos.flatMap((g) => g.nodos) });
        respaldo = path.join(os.tmpdir(), `neo4j-usuarios-${Date.now()}-${process.pid}.json`);
        fs.writeFileSync(respaldo, JSON.stringify(snapshot.records.map((r) => r.toObject()), null, 2), { flag: 'wx' });
        await tx.run('MATCH (u:Usuario) WHERE elementId(u) IN $nodos DETACH DELETE u', { nodos: pares.map((p) => p.duplicado) });
      }
      return { grupos: grupos.map((g) => ({ id: g.id, nodos: g.nodos.length })), eliminados: aplicar ? pares.length : 0, respaldo };
    });
  } finally {
    await sesion.close();
  }
}

if (require.main === module) {
  require('dotenv').config();
  const neo4j = require('../src/config/neo4j');
  const aplicar = process.argv.includes('--aplicar');
  unificar(neo4j.conectar(), { aplicar })
    .then(async (resultado) => {
      console.log(JSON.stringify(resultado, null, 2));
      if (aplicar) {
        await neo4j.asegurarEsquema();
        console.log('Restricciones de unicidad aplicadas.');
      } else console.log('Solo inspección. Para reparar y aplicar el esquema: --aplicar');
    })
    .catch((err) => { console.error(err.message); process.exitCode = 1; })
    .finally(() => neo4j.cerrar());
}

module.exports = { unificar };
