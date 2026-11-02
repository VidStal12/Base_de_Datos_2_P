require('dotenv').config();
const mongoose = require('mongoose');
const { conectar } = require('../src/config/mongo');
const Producto = require('../src/models/mongo/Producto');

// La migración solo cambia el esquema. Conserva el texto original completo y
// no reescribe los eventos históricos ni se atribuye una edición al vendedor.
async function migrar(aplicar) {
  await conectar();
  const pendientes = { nombre: null };
  let revisados = 0, modificados = 0, sinDescripcion = 0;
  for await (const doc of Producto.find(pendientes).select('descripcion atributos version').lean().cursor()) {
    if (!doc.descripcion?.trim()) throw new Error(`Texto original vacío en ${doc._id}; revisar manualmente.`);
    const descripcion = (doc.atributos ?? []).filter((a) => a.nombre && a.valor)
      .map((a) => `${a.nombre}: ${a.valor}.`).join(' ');
    revisados++;
    if (!descripcion) sinDescripcion++;
    if (aplicar) {
      const r = await Producto.collection.updateOne(
        { _id: doc._id, ...pendientes, descripcion: doc.descripcion, version: doc.version },
        { $set: { nombre: doc.descripcion, descripcion } }
      );
      modificados += r.modifiedCount;
    }
  }
  console.log(`${aplicar ? 'Migración' : 'Vista previa'}: ${revisados} antiguos, ${modificados} migrados, ${sinDescripcion} sin atributos para la descripción.`);
  if (aplicar && revisados !== modificados) throw new Error('El catálogo cambió durante la migración; volver a ejecutar.');
}

migrar(process.argv.includes('--aplicar')).catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => mongoose.disconnect());
