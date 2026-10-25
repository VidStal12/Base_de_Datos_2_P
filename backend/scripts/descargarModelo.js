// npm run modelo:descargar — baja a una carpeta propia el modelo de embeddings (src/config/embeddingsModelo.js) y
// comprueba cada archivo: tamaño y SHA-256 (git blob para los pequeños) contra el manifiesto. Idempotente: lo que ya está
// bien no se vuelve a bajar. `npm run modelo:verificar` solo comprueba, sin descargar.
//
// Se baja de huggingface.co a una REVISIÓN fija del repositorio; cada archivo llega a «<archivo>.parcial» y solo se
// renombra a su nombre final si el tamaño y el hash coinciden, así una descarga cortada nunca queda pasando por buena.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const modelo = require('../src/config/embeddingsModelo');

const SOLO_VERIFICAR = process.argv.includes('--verificar');
const MB = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

const carpeta = path.join(modelo.carpeta(), ...modelo.REPOSITORIO.split('/'));
const urlDe = (ruta) => `https://huggingface.co/${modelo.REPOSITORIO}/resolve/${modelo.REVISION}/${ruta}`;

// El «git blob id» de un archivo pequeño: sha1("blob <bytes>\0" + contenido).
function gitBlob(contenido) {
  return createHash('sha1').update(`blob ${contenido.length}\0`).update(contenido).digest('hex');
}

// true si el archivo existe y coincide con el manifiesto (tamaño y huella).
async function estaBien(archivo) {
  const ruta = path.join(carpeta, archivo.ruta);
  if (!fs.existsSync(ruta) || fs.statSync(ruta).size !== archivo.bytes) return false;
  if (archivo.sha256) {
    const hash = createHash('sha256');
    await pipeline(fs.createReadStream(ruta), new Transform({ transform: (trozo, _, listo) => (hash.update(trozo), listo()) }));
    return hash.digest('hex') === archivo.sha256;
  }
  return gitBlob(fs.readFileSync(ruta)) === archivo.gitBlob;
}

async function descargar(archivo) {
  const destino = path.join(carpeta, archivo.ruta);
  const parcial = `${destino}.parcial`;
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  const respuesta = await fetch(urlDe(archivo.ruta), { redirect: 'follow', signal: AbortSignal.timeout(15 * 60 * 1000) });
  if (!respuesta.ok) throw new Error(`${archivo.ruta}: HTTP ${respuesta.status} al bajar ${urlDe(archivo.ruta)}`);

  const hash = createHash('sha256');
  let recibidos = 0;
  let ultimoAviso = 0;
  const contar = new Transform({
    transform(trozo, _, listo) {
      hash.update(trozo);
      recibidos += trozo.length;
      if (archivo.bytes > 5e6 && recibidos - ultimoAviso > archivo.bytes / 10) {
        ultimoAviso = recibidos;
        process.stdout.write(`    ${archivo.ruta}: ${Math.round((recibidos / archivo.bytes) * 100)} %\n`);
      }
      listo(null, trozo);
    },
  });
  try {
    await pipeline(Readable.fromWeb(respuesta.body), contar, fs.createWriteStream(parcial));
    if (recibidos !== archivo.bytes) throw new Error(`${archivo.ruta}: llegaron ${recibidos} bytes y el manifiesto dice ${archivo.bytes}`);
    const huella = archivo.sha256 ? hash.digest('hex') === archivo.sha256 : gitBlob(fs.readFileSync(parcial)) === archivo.gitBlob;
    if (!huella) throw new Error(`${archivo.ruta}: la huella no coincide con el manifiesto (otro contenido en el repositorio, o descarga dañada)`);
    fs.renameSync(parcial, destino);
  } catch (err) {
    fs.rmSync(parcial, { force: true });
    throw err;
  }
}

async function main() {
  console.log(`Modelo de embeddings ${modelo.REPOSITORIO} @ ${modelo.REVISION.slice(0, 12)}`);
  console.log(`  carpeta: ${carpeta}`);
  let faltan = 0;
  for (const archivo of modelo.ARCHIVOS) {
    if (await estaBien(archivo)) {
      console.log(`  ✔ ${archivo.ruta} (${MB(archivo.bytes)}) ya está y coincide`);
      continue;
    }
    if (SOLO_VERIFICAR) {
      console.log(`  ✖ ${archivo.ruta} falta o no coincide con el manifiesto`);
      faltan += 1;
      continue;
    }
    console.log(`  ↓ ${archivo.ruta} (${MB(archivo.bytes)})`);
    await descargar(archivo);
    console.log(`  ✔ ${archivo.ruta} verificado`);
  }
  if (faltan > 0) {
    console.error('\nFalta el modelo o está dañado: `npm run modelo:descargar` (necesita internet solo esta vez).');
    process.exitCode = 1;
    return;
  }
  console.log('\nListo: el servidor lo carga desde esa carpeta, sin internet.');
}

main().catch((err) => {
  console.error(`No se pudo preparar el modelo: ${err.message}`);
  process.exitCode = 1;
});
