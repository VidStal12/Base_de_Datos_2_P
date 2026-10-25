const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// IA/ARQUITECTURA-FINAL.md describe el sistema que existe HOY y trae, en su sección 1, un inventario legible por
// máquina (contenedores, modelos, llaves de Redis, tablas, etiquetas, procesos de fondo). Esta prueba lo compara con
// el repositorio: si alguien agrega o quita una de esas piezas sin actualizar el documento y sus diagramas, la suite
// falla diciendo qué falta. No abre ninguna conexión: solo lee archivos y carga dos módulos de configuración puros.
// También revisa que los diagramas Mermaid no tengan nodos fantasma ni pasen del tope de flechas por vista, y que los
// archivos y funciones que cita la tabla de flechas existan.

const BACKEND = path.join(__dirname, '..');
const RAIZ = path.join(BACKEND, '..');
const SRC = path.join(BACKEND, 'src');
const TOPE_DE_FLECHAS = 25;
const leer = (...partes) => fs.readFileSync(path.join(...partes), 'utf8').replace(/\r\n/g, '\n');
const ordenado = (valores) => [...new Set(valores)].sort();
const DOC = leer(RAIZ, 'IA', 'ARQUITECTURA-FINAL.md');

function inventarioDelDocumento() {
  const bloque = DOC.match(/```json inventario\n([\s\S]*?)\n```/);
  assert.ok(bloque, 'IA/ARQUITECTURA-FINAL.md ya no tiene el bloque «json inventario» de la sección 1');
  return JSON.parse(bloque[1]);
}
const inv = inventarioDelDocumento();

function coinciden(que, real, documentado) {
  const r = ordenado(real);
  const d = ordenado(documentado);
  const sinDocumentar = r.filter((x) => !d.includes(x));
  const sobran = d.filter((x) => !r.includes(x));
  assert.deepEqual({ sinDocumentar, sobran }, { sinDocumentar: [], sobran: [] },
    `${que}: el código y el inventario de IA/ARQUITECTURA-FINAL.md (sección 1) ya no coinciden. ` +
    '«sinDocumentar» existe en el código y falta en el documento; «sobran» está en el documento y ya no existe. ' +
    'Actualizá el inventario, los diagramas que lo muestran y la tabla de flechas.');
}

function archivosJs(carpeta) {
  return fs.readdirSync(carpeta, { withFileTypes: true }).flatMap((entrada) => {
    const ruta = path.join(carpeta, entrada.name);
    if (entrada.isDirectory()) return archivosJs(ruta);
    return entrada.name.endsWith('.js') ? [ruta] : [];
  });
}

// ── Inventario contra el código ───────────────────────────────────────────────────────────────────────────────────

test('los contenedores del inventario son los servicios de docker-compose.yml', () => {
  const texto = `\n${leer(RAIZ, 'docker-compose.yml')}`;
  const inicio = texto.indexOf('\nservices:\n');
  assert.ok(inicio >= 0, 'docker-compose.yml no tiene la clave «services:»');
  const resto = texto.slice(inicio + '\nservices:\n'.length);
  const fin = resto.search(/^(?!#)\S/m);
  const bloque = fin < 0 ? resto : resto.slice(0, fin);
  const servicios = [...bloque.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)].map((m) => m[1]);
  coinciden('contenedores', servicios, inv.contenedores);
});

test('los archivos de config/ son los del inventario y hay un cliente por cada contenedor', () => {
  const archivos = fs.readdirSync(path.join(SRC, 'config')).filter((f) => f.endsWith('.js')).map((f) => f.replace(/\.js$/, ''));
  coinciden('archivos de src/config', archivos, inv.configuracion);
  for (const cliente of inv.clientes) {
    assert.ok(archivos.includes(cliente), `el cliente «${cliente}» del inventario no tiene src/config/${cliente}.js`);
  }
  assert.equal(inv.clientes.length, inv.contenedores.length, 'cada contenedor tiene su cliente (MySQL, el de Prisma)');
});

test('los modelos de Prisma son los del inventario', () => {
  const esquema = leer(BACKEND, 'prisma', 'schema.prisma');
  coinciden('modelos de Prisma', [...esquema.matchAll(/^model (\w+) \{/gm)].map((m) => m[1]), inv.modelosPrisma);
});

test('los modelos de Mongoose son los del inventario', () => {
  const carpeta = path.join(SRC, 'models', 'mongo');
  const modelos = fs.readdirSync(carpeta).filter((f) => f.endsWith('.js'))
    .flatMap((f) => [...leer(carpeta, f).matchAll(/\bmodel\('(\w+)'/g)].map((m) => m[1]));
  coinciden('modelos de Mongoose', modelos, inv.modelosMongoose);
});

test('las familias de llaves de Redis son las que reparten las cuentas de config/redisCuentas.js', () => {
  const { CUENTAS } = require('../src/config/redisCuentas');
  const familias = Object.values(CUENTAS).flatMap((cuenta) => (cuenta.llaves || []).map((llave) => llave.replace(/^(%R)?~/, '')));
  coinciden('familias de llaves de Redis', familias, inv.familiasRedis);
});

test('las tablas de Cassandra son las del CQL de inicio', () => {
  const cql = leer(RAIZ, 'docker', 'cassandra-init', '01-schema.cql');
  coinciden('tablas de Cassandra', [...cql.matchAll(/CREATE TABLE IF NOT EXISTS \w+\.(\w+)/gi)].map((m) => m[1]), inv.tablasCassandra);
});

test('las etiquetas de Neo4j son las que escribe fraudeSyncService', () => {
  const fuente = leer(SRC, 'services', 'fraudeSyncService.js');
  coinciden('etiquetas de Neo4j', [...fuente.matchAll(/MERGE \(\w+:(\w+)/g)].map((m) => m[1]), inv.etiquetasNeo4j);
});

test('el índice de Elasticsearch es el del inventario', () => {
  const fuente = leer(SRC, 'config', 'elasticsearch.js');
  const porDefecto = fuente.match(/process\.env\.ELASTICSEARCH_INDICE \|\| '([\w-]+)'/);
  assert.ok(porDefecto, 'config/elasticsearch.js ya no declara el índice con process.env.ELASTICSEARCH_INDICE || «nombre»');
  assert.equal(porDefecto[1], inv.indiceElasticsearch);
});

test('los procesos de fondo son los archivos con temporizador, y server.js arranca los que dice el inventario', () => {
  const conTemporizador = archivosJs(SRC)
    .filter((ruta) => /\bsetInterval\(/.test(leer(ruta)))
    .map((ruta) => path.basename(ruta, '.js'));
  const { arrancanEnServer, alEncolar } = inv.procesosDeFondo;
  coinciden('procesos de fondo (archivos con setInterval)', conTemporizador, [...arrancanEnServer, ...alEncolar]);

  const servidor = leer(SRC, 'server.js');
  const alias = new Map([...servidor.matchAll(/const (\w+) = require\('\.\/services\/(\w+)'\)/g)].map((m) => [m[1], m[2]]));
  const iniciados = [...servidor.matchAll(/\b(\w+)\.iniciar\(\)/g)].map((m) => alias.get(m[1])).filter(Boolean);
  coinciden('procesos que server.js arranca con iniciar()', iniciados, arrancanEnServer);

  for (const nombre of alEncolar) {
    assert.match(leer(SRC, 'services', `${nombre}.js`), /function encolar\b/, `${nombre} se enciende al encolar y ya no tiene encolar()`);
  }
});

test('los routers montados y las rutas declaradas en la lista blanca son los del inventario', () => {
  const montados = [...leer(SRC, 'app.js').matchAll(/^app\.use\('\/api\/[^']+', \w+\);/gm)].length;
  assert.equal(montados, inv.routers, 'routers montados en app.js (cuentan los dos que comparten /api/admin)');
  const { RUTAS } = require('../src/config/politicaRutas');
  assert.equal(RUTAS.length, inv.rutasDeclaradas, 'rutas declaradas en config/politicaRutas.js (63 de los routers y el índice «/»)');
});

// ── La tabla de flechas cita archivos, funciones y rutas que existen ──────────────────────────────────────────────

test('los archivos, funciones y rutas que cita la tabla de flechas existen', () => {
  const inicio = DOC.indexOf('## 7. Cada flecha');
  const fin = DOC.indexOf('\n## 8.');
  assert.ok(inicio >= 0 && fin > inicio, 'no se encontró la sección 7 («Cada flecha») del documento');
  const tabla = DOC.slice(inicio, fin);

  const relativos = new Set(archivosJs(SRC).map((ruta) => path.relative(SRC, ruta).split(path.sep).join('/')));
  const nombres = new Set([...relativos].map((ruta) => path.basename(ruta)));
  const { rutaPorClave } = require('../src/config/politicaRutas');

  const citas = [...tabla.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
  const revisadas = { archivos: 0, funciones: 0, rutas: 0 };
  for (const cita of citas) {
    if (/\.js$/.test(cita)) {
      assert.ok(cita.includes('/') ? relativos.has(cita) : nombres.has(cita), `la tabla cita ${cita} y no existe en backend/src`);
      revisadas.archivos += 1;
      continue;
    }
    const funcion = cita.match(/^(\w+)\.(\w+)$/);
    if (funcion && relativos.has(`services/${funcion[1]}.js`)) {
      assert.match(leer(SRC, 'services', `${funcion[1]}.js`), new RegExp(`\\b${funcion[2]}\\b`), `la tabla cita ${cita} y ${funcion[1]}.js no menciona ${funcion[2]}`);
      revisadas.funciones += 1;
      continue;
    }
    if (/^(GET|POST|PUT|PATCH|DELETE) \/api\//.test(cita) && !cita.includes('*')) {
      assert.ok(rutaPorClave(cita), `la tabla cita la ruta «${cita}» y no está en config/politicaRutas.js`);
      revisadas.rutas += 1;
    }
  }
  assert.ok(revisadas.archivos >= 10 && revisadas.funciones >= 4 && revisadas.rutas >= 3,
    `la tabla casi no cita nada comprobable (${JSON.stringify(revisadas)}): ¿cambió el formato de la sección 7?`);
});

// ── Los diagramas ─────────────────────────────────────────────────────────────────────────────────────────────────

const BLOQUES = [...DOC.matchAll(/```mermaid\n([\s\S]*?)\n```/g)].map((m) => m[1]);
const FLUJOS = BLOQUES.filter((bloque) => /^flowchart /.test(bloque));
const SECUENCIAS = BLOQUES.filter((bloque) => /^sequenceDiagram/.test(bloque));
const ALMACENES = ['MY', 'MG', 'RE', 'CA', 'NE', 'ES'];

test('el documento trae cuatro vistas de flujo y una secuencia', () => {
  assert.equal(FLUJOS.length, 4, 'vistas de flujo (V1, V2a, V2b y V3)');
  assert.equal(SECUENCIAS.length, 1, 'secuencias (V4, el checkout)');
});

test('cada vista de flujo dibuja los seis almacenes, no deja nodos fantasma, cierra sus subgraph y no pasa del tope de flechas', () => {
  FLUJOS.forEach((bloque, i) => {
    const vista = `vista de flujo ${i + 1}`;
    const declarados = new Set([...bloque.matchAll(/\b([A-Za-z][A-Za-z0-9_]*)(?=\[|\{|\(\[|\(\()/g)].map((m) => m[1]));

    for (const id of ALMACENES) assert.ok(declarados.has(id), `${vista}: falta dibujar el almacén ${id}`);

    for (const linea of bloque.split('\n')) {
      const clase = linea.match(/^\s*class ([\w,]+) \w+\s*$/);
      if (clase) {
        for (const id of clase[1].split(',')) assert.ok(declarados.has(id), `${vista}: «class ${id}» apunta a un nodo que no existe`);
      }
      if (!/-->|==>|-\.->/.test(linea)) continue;
      const sinTextos = linea.replace(/"[^"]*"/g, '').replace(/\|[^|]*\|/g, ' ');
      for (const extremo of sinTextos.split(/\s*(?:-->|==>|-\.->|--)\s*/).map((t) => t.trim()).filter(Boolean)) {
        const id = extremo.match(/^[A-Za-z][A-Za-z0-9_]*/);
        assert.ok(id && declarados.has(id[0]), `${vista}: la flecha «${linea.trim()}» termina en un nodo que no existe («${extremo}»)`);
      }
    }

    const abre = (bloque.match(/^\s*subgraph /gm) || []).length;
    const cierra = (bloque.match(/^\s*end\s*$/gm) || []).length;
    assert.equal(abre, cierra, `${vista}: hay ${abre} subgraph y ${cierra} «end»`);

    const flechas = (bloque.match(/-->|==>|-\.->/g) || []).length;
    assert.ok(flechas <= TOPE_DE_FLECHAS, `${vista}: ${flechas} flechas; el tope es ${TOPE_DE_FLECHAS} (si pasa, dividir la vista)`);
  });
});

test('en la secuencia del checkout todos los participantes están declarados', () => {
  const [secuencia] = SECUENCIAS;
  const participantes = new Set([...secuencia.matchAll(/^\s*(?:participant|actor) (\w+)/gm)].map((m) => m[1]));
  for (const id of ['U', 'A', 'K', 'R', 'M', 'G', 'N', 'W', 'C']) assert.ok(participantes.has(id), `la secuencia no declara al participante ${id}`);
  for (const linea of secuencia.split('\n')) {
    const mensaje = linea.match(/^\s*(\w+)-{1,2}>>(\w+):/);
    const nota = linea.match(/^\s*Note over (\w+)(?:,(\w+))?:/);
    for (const id of [...(mensaje || []).slice(1), ...(nota || []).slice(1)].filter(Boolean)) {
      assert.ok(participantes.has(id), `la secuencia usa a «${id}» sin declararlo: ${linea.trim()}`);
    }
  }
});
