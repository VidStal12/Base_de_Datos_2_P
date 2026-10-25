const fs = require('node:fs');
const path = require('node:path');
const modelo = require('../config/embeddingsModelo');

// Embeddings locales (ver IA/ADR-006-recomendacion-semantica-vectorial.md): el texto de un producto pasa por un
// modelo que corre dentro de este mismo proceso, desde la carpeta que deja `npm run modelo:descargar`. Nada
// sale de la máquina: sin internet, sin claves y sin mandarle los datos a un tercero.
//
// El modelo se carga la primera vez que hace falta (≈ 0,8 s y +400 MB de memoria, medido) y se queda cargado:
// liberarlo devuelve solo ~150 MB porque la librería nativa sigue residente. Hace falta al crear o editar un
// producto y al reconstruir el índice; LEER los relacionados no lo necesita (el vector ya está en el índice).
class ModeloNoDisponible extends Error {
  constructor(motivo, causa) {
    super(`El modelo de embeddings no está disponible: ${motivo}`, causa ? { cause: causa } : undefined);
    this.name = 'ModeloNoDisponible';
  }
}

const LOTE = 16;
// Tras una carga fallida no se vuelve a intentar durante este tiempo: un modelo que falta o una librería nativa que no
// arranca fallaría igual en cada edición de producto, y cada intento cuesta.
const REINTENTO_MS = 30000;

let cargado; // promesa del modelo listo
let fallo; // { en, error } de la última carga que falló
let cola = Promise.resolve();

// Los archivos del manifiesto que no están o no tienen el tamaño esperado. Es una comprobación barata para dar un
// mensaje claro; el SHA-256 completo lo hace `npm run modelo:verificar`.
function archivosFaltantes() {
  const carpeta = path.join(modelo.carpeta(), ...modelo.REPOSITORIO.split('/'));
  return modelo.ARCHIVOS
    .filter((archivo) => {
      const ruta = path.join(carpeta, archivo.ruta);
      return !fs.existsSync(ruta) || fs.statSync(ruta).size !== archivo.bytes;
    })
    .map((archivo) => archivo.ruta);
}

async function cargarModelo() {
  const faltan = archivosFaltantes();
  if (faltan.length > 0) {
    throw new ModeloNoDisponible(`faltan o están incompletos ${faltan.join(', ')} en ${modelo.carpeta()}; corré \`npm run modelo:descargar\``);
  }
  // Se pide acá y no al arrancar el servidor: la librería trae un runtime nativo, y si no arranca en esta máquina
  // el resto de la tienda debe seguir funcionando sin vectores.
  const { pipeline, env } = require('@huggingface/transformers');
  env.allowRemoteModels = false; // nunca baja nada por su cuenta
  env.localModelPath = modelo.carpeta();
  return pipeline('feature-extraction', modelo.REPOSITORIO, { dtype: modelo.DTYPE });
}

function obtenerModelo() {
  if (fallo && Date.now() - fallo.en < REINTENTO_MS) return Promise.reject(fallo.error);
  if (!cargado) {
    cargado = cargarModelo().then(
      (listo) => {
        fallo = undefined;
        return listo;
      },
      (err) => {
        cargado = undefined;
        const error = err instanceof ModeloNoDisponible ? err : new ModeloNoDisponible('no se pudo cargar', err);
        fallo = { en: Date.now(), error };
        throw error;
      }
    );
  }
  return cargado;
}

// E5 se entrena con el prefijo «query: » en consultas Y en documentos cuando lo que se compara es documento contra
// documento (similitud simétrica, la de «productos parecidos»): con «passage: » en los dos lados la precisión@5 fue
// menor (85,3 % contra 90,0 %, medido). El prefijo se agrega acá para que ningún llamador pueda olvidarlo.
async function calcular(textos) {
  if (textos.length === 0) return [];
  const modeloListo = await obtenerModelo();
  const vectores = [];
  for (let i = 0; i < textos.length; i += LOTE) {
    const salida = await modeloListo(textos.slice(i, i + LOTE).map((texto) => `${modelo.PREFIJO}${texto}`), { pooling: 'mean', normalize: true });
    const [filas, dimension] = salida.dims;
    if (dimension !== modelo.DIMENSION) throw new Error(`El modelo devolvió vectores de ${dimension} dimensiones y el índice espera ${modelo.DIMENSION}`);
    for (let fila = 0; fila < filas; fila += 1) vectores.push(Array.from(salida.data.subarray(fila * dimension, (fila + 1) * dimension)));
  }
  return vectores;
}

// Un cálculo a la vez: son milisegundos por título, y así la memoria del runtime no depende de cuántos productos
// se editen a la vez. Un fallo no frena a los que esperan atrás.
function incrustar(textos) {
  const turno = cola.then(() => calcular(textos));
  cola = turno.catch(() => {});
  return turno;
}

// Qué se incrusta de un producto: su título, la subcategoría y la categoría. El título solo es demasiado corto
// (mediana de 21 caracteres) y deja a muchos sin vecinos que se le parezcan; con la categoría la precisión@5 pasó de
// 64,0 % a 90,2 % — ojo: esa cifra mide aciertos de subcategoría, que este texto ya contiene (IA/ADR-006, «fuga de etiqueta»).
function textoDeProducto(producto) {
  return [producto.descripcion, producto.subcategoria?.subcategoria, producto.subcategoria?.categoria]
    .filter(Boolean)
    .map((parte) => `${parte}.`)
    .join(' ');
}

// Suelta el modelo cargado (≈ 150 MB; el runtime nativo sigue residente). Los scripts lo llaman al terminar por
// orden: el proceso termina solo aunque no se llame (medido).
async function cerrar() {
  const pendiente = cargado;
  cargado = undefined;
  fallo = undefined;
  if (pendiente) await pendiente.then((listo) => listo.dispose(), () => {});
}

module.exports = { incrustar, textoDeProducto, cerrar, ModeloNoDisponible, archivosFaltantes };
