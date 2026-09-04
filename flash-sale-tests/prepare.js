const path = require('node:path');
const { spawnSync } = require('node:child_process');

const runPath = path.join(__dirname, 'run.js');
const scenarioPath = path.join(__dirname, 'scenarios', 'combined.json');
const result = spawnSync(process.execPath, [runPath, scenarioPath, '--prepare-only'], {
  cwd: path.resolve(__dirname, '..'),
  stdio: 'inherit',
});

if (result.error) {
  console.error(`No se pudo iniciar la preparación: ${result.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
