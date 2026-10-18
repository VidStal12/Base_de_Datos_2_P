// Spike de MongoDB para el módulo de pagos — evidencia de IA/ADR-005.
//
//   npm run spike:pagos                     # todos los experimentos (≈ 5 min)
//   npm run spike:pagos -- --rapido         # humo: tamaños reducidos, valores NO representativos
//   npm run spike:pagos -- --experimento=2,5
//   npm run spike:pagos -- --salida=IA/ADR-005-spike-resultados.json
//
// Seguridad: trabaja SOLO en la base Mongo `tiendaya_poc_pagos` y el esquema MySQL
// `prisma_migrate_shadow_db_poc` (los crea y los borra). De `tiendaya` únicamente LEE `pago`/`metodo_pago`
// (experimento 8, sesión READ ONLY). No toca src/ ni detiene contenedores. Conviene correrlo con el
// backend apagado: el benchmark mide latencias y cualquier otra carga las contamina.
const fs = require('node:fs');
const path = require('node:path');
const entorno = require('./entorno');

const EXPERIMENTOS = {
  1: ['./e1_dinero', 120],
  2: ['./e2_idempotencia', 120],
  3: ['./e3_transacciones', 180],
  4: ['./e4_concurrencia', 300],
  5: ['./e5_saga', 240],
  6: ['./e6_rendimiento', 900],
  7: ['./e7_flexibilidad', 120],
  8: ['./e8_migracion', 180],
  9: ['./e9_prisma_deadlock', 120],
};

function argumentos() {
  const out = { experimentos: Object.keys(EXPERIMENTOS).map(Number), rapido: false, conservar: false, salida: null };
  for (const a of process.argv.slice(2)) {
    if (a === '--rapido') out.rapido = true;
    else if (a === '--conservar') out.conservar = true;
    else if (a.startsWith('--salida=')) out.salida = a.slice('--salida='.length);
    else if (a.startsWith('--experimento=')) out.experimentos = a.slice('--experimento='.length).split(',').map(Number);
    else { console.error(`Argumento desconocido: ${a}`); process.exit(2); }
  }
  if (out.experimentos.some((n) => !EXPERIMENTOS[n])) { console.error('Experimento inexistente (1-9)'); process.exit(2); }
  return out;
}

function conTiempoLimite(promesa, segundos, nombre) {
  let temporizador;
  const limite = new Promise((_, rechazar) => {
    temporizador = setTimeout(() => rechazar(new Error(`${nombre} superó el límite de ${segundos} s`)), segundos * 1000);
  });
  return Promise.race([promesa, limite]).finally(() => clearTimeout(temporizador));
}

async function main() {
  const args = argumentos();
  const inicio = Date.now();
  let ctx;
  let fallidas = 0;
  let total = 0;
  const salida = { entorno: null, rapido: args.rapido, experimentos: [] };
  const cortar = async () => { await entorno.cerrar(ctx).catch(() => {}); process.exit(130); };
  process.once('SIGINT', cortar);

  try {
    ctx = await entorno.abrir();
    salida.entorno = await entorno.hechos(ctx);
    console.log('# Spike de pagos en MongoDB — ADR-005');
    console.log(`\nModo: ${args.rapido ? 'RÁPIDO (humo, valores no representativos)' : 'completo'}`);
    console.log('\n```json\n' + JSON.stringify(salida.entorno, null, 2) + '\n```');

    for (const n of args.experimentos) {
      const [ruta, limite] = EXPERIMENTOS[n];
      const t0 = Date.now();
      let r;
      try {
        r = await conTiempoLimite(require(ruta).ejecutar(ctx, { rapido: args.rapido }), limite, `E${n}`);
      } catch (err) {
        r = { titulo: `E${n}`, checks: [{ nombre: 'El experimento termina sin excepción', ok: false, detalle: err.stack || err.message }], tablas: [], notas: [] };
      }
      const seg = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`\n## ${r.titulo}  (${seg} s)\n`);
      for (const c of r.checks) {
        total++;
        if (!c.ok) fallidas++;
        console.log(`- ${c.ok ? '✔' : '✘'} ${c.nombre}${c.detalle ? ` — ${c.detalle}` : ''}`);
      }
      for (const t of r.tablas) console.log(`\n**${t.titulo}**\n\n${t.md}`);
      if (r.notas.length) console.log('\n' + r.notas.map((x) => `- ${x}`).join('\n'));
      salida.experimentos.push({ id: n, segundos: Number(seg), ...r });
    }
  } finally {
    await entorno.cerrar(ctx, { conservar: args.conservar });
  }

  salida.duracion_s = Math.round((Date.now() - inicio) / 1000);
  console.log(`\n---\nVerificaciones: ${total - fallidas}/${total} correctas en ${salida.duracion_s} s. Espacios temporales ${args.conservar ? 'CONSERVADOS' : 'borrados'}.`);
  if (args.salida) {
    const destino = path.resolve(process.cwd(), args.salida);
    fs.writeFileSync(destino, JSON.stringify(salida, (k, v) => (typeof v === 'bigint' ? Number(v) : v), 2));
    console.log(`Resultados en ${destino}`);
  }
  process.exitCode = fallidas ? 1 : 0;
  setTimeout(() => process.exit(), 3000).unref();
}

main().catch((err) => {
  console.error('ERROR del spike:', err.stack || err.message);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 3000).unref();
});
