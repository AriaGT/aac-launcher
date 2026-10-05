/**
 * Runs the Electron integration checks under tests/integration/.
 *
 * These need a real build (out/main, out/preload, out/renderer) and a real Electron,
 * so they are kept out of `npm test` and run with `npm run test:integration`.
 *
 * Electron on Windows is a GUI-subsystem binary and does not attach to the parent
 * console, so stdout/stderr are redirected to files and echoed afterwards.
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const checkDir = path.join(root, 'tests', 'integration');
const checks = ['reported-bugs.cjs', 'sidebar-layout.cjs'];
const TIMEOUT_MS = 120000;

function run(file) {
  // Electron is a GUI-subsystem binary on Windows: its stdout does not reach a pipe,
  // so both streams go to files that are read back after the process exits.
  const base = path.join(os.tmpdir(), `acl-int-${path.parse(file).name}`);
  const outFile = `${base}.log`;
  const errFile = `${base}.err`;
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  return new Promise((resolve) => {
    const child = spawn(electron, [path.join(checkDir, file)], {
      cwd: root,
      stdio: ['ignore', outFd, errFd],
    });
    const killer = setTimeout(() => child.kill(), TIMEOUT_MS);
    const finish = (code, extra) => {
      clearTimeout(killer);
      try {
        fs.closeSync(outFd);
        fs.closeSync(errFd);
      } catch {
        /* already closed */
      }
      resolve({
        code,
        stdout: fs.readFileSync(outFile, 'utf8'),
        stderr: `${fs.readFileSync(errFile, 'utf8')}${extra ?? ''}`,
      });
    };
    child.on('close', (code) => finish(code));
    child.on('error', (error) => finish(-1, `\nspawn error: ${error.message}`));
  });
}

(async () => {
  // Electron subprocesses can survive a parent exit on Windows.
  spawnSync('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' });

  let failed = 0;
  for (const file of checks) {
    console.log(`\n=== ${file} ===`);
    const { code, stdout, stderr } = await run(file);
    if (stdout.trim()) console.log(stdout.trim());
    const noise = stderr
      .split(/\r?\n/)
      .filter((line) => line.trim() && !/^\(node:\d+\)/.test(line.trim()));
    if (noise.length) console.log(`stderr:\n${noise.slice(0, 8).join('\n')}`);
    if (code !== 0) {
      failed += 1;
      console.log(`--- ${file} FAILED (exit ${code})`);
    }
  }

  console.log(`\n${failed === 0 ? 'ALL INTEGRATION CHECKS PASSED' : `${failed} CHECK FILE(S) FAILED`}`);
  process.exit(failed === 0 ? 0 : 1);
})();
