const path = require('node:path');

// El modelo de embeddings de la recomendación semántica (IA/ADR-006, IA/PLAN-ENTREGA-FINAL.md §3.3).
//
// `multilingual-e5-small` (Microsoft/intfloat, licencia MIT) en la conversión a ONNX que usa transformers.js
// (repositorio Xenova/multilingual-e5-small), cuantizado a enteros de 8 bits: 384 dimensiones, ~100 idiomas.
// Se calcula EN LOCAL: no hay claves de pago ni llamadas a internet al servir una petición, y las direcciones y los
// títulos de los productos no salen de la máquina.
//
// El modelo NO está en git (118 MB: supera el límite de GitHub). `npm run modelo:descargar` lo baja una vez a
// `backend/modelos/` (o a EMBEDDINGS_DIR) y comprueba cada archivo contra este manifiesto. Se fija la REVISIÓN exacta
// del repositorio y el SHA-256 de cada archivo grande (el git blob de cada archivo pequeño): si alguien cambiara el
// contenido en el repositorio remoto, o una descarga llegara cortada, la verificación falla en vez de cargar otra cosa.
// En tiempo de ejecución el servidor nunca descarga nada (ver services/embeddingService.js).

const REPOSITORIO = 'Xenova/multilingual-e5-small';
const REVISION = '761b726dd34fb83930e26aab4e9ac3899aa1fa78';

const ARCHIVOS = [
  { ruta: 'config.json', bytes: 658, gitBlob: '4104f38273cc595fd9500fd243124e9f6cf383dc' },
  { ruta: 'tokenizer_config.json', bytes: 443, gitBlob: '059214673d9d6d2ee319411e2ffec8c024b816d5' },
  { ruta: 'special_tokens_map.json', bytes: 167, gitBlob: 'e0b1d18ecd0ae4ff1d47bd297d910c0cf83e504b' },
  { ruta: 'tokenizer.json', bytes: 17082730, sha256: '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39' },
  { ruta: 'onnx/model_quantized.onnx', bytes: 118308185, sha256: 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193' },
];

module.exports = {
  REPOSITORIO,
  REVISION,
  ARCHIVOS,
  // `q8` es el archivo onnx/model_quantized.onnx.
  DTYPE: 'q8',
  DIMENSION: 384,
  // E5 exige un prefijo en TODO texto, también en español. «query: » en los dos lados (producto y consulta) es lo que
  // recomienda el modelo para similitud simétrica; «passage: » sería para recuperar documentos largos con una pregunta.
  PREFIJO: 'query: ',
  // Dónde está la carpeta con el modelo: EMBEDDINGS_DIR, o backend/modelos. Dentro, `Xenova/multilingual-e5-small/…`.
  carpeta: (env = process.env) => env.EMBEDDINGS_DIR || path.join(__dirname, '..', '..', 'modelos'),
};
