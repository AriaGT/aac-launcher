/**
 * End-to-end check of the three reported bugs, driving the real compiled main process
 * (out/main/ipc.js) with the real preload and renderer bundle.
 *
 * Read-only with respect to AgentCraft: Start must be blocked by the new pre-flight
 * guard, and nothing here ever calls stop.
 */
const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');

const LAUNCHER = 'C:\\Users\\aless\\Repositorios\\aac-launcher';
const CHECKOUT = 'C:\\Users\\aless\\Repositorios\\agentcraft';
const { createRuntime, registerIpc } = require(path.join(LAUNCHER, 'out', 'main', 'ipc.js'));

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ` :: ${detail}` : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let window = null;
const getWindow = () => (window && !window.isDestroyed() ? window : null);

app.on('window-all-closed', () => {});
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  session.defaultSession.setPermissionCheckHandler(() => false);
  const runtime = createRuntime(getWindow);
  registerIpc(runtime, getWindow);

  window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(LAUNCHER, 'out', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const js = (code) => window.webContents.executeJavaScript(code).catch((e) => `THREW: ${e.message}`);

  try {
    await window.loadFile(path.join(LAUNCHER, 'out', 'renderer', 'index.html'));
  } catch (error) {
    console.log(`LOAD FAILED: ${error.message}`);
    app.exit(2);
    return;
  }

  for (let i = 0; i < 40; i += 1) {
    if ((await js('typeof window.launcher')) === 'object') break;
    await wait(250);
  }
  check('preload bridge is exposed', (await js('typeof window.launcher')) === 'object');

  // Subscribe from inside the renderer: webContents.send() does not travel through
  // emit(), so patching emit on the main side captures nothing.
  await js(`(() => {
    window.__st = [];
    window.__cl = [];
    window.launcher.onStatus((s) => { if (window.__st.length < 500) window.__st.push(s); });
    window.launcher.onConsole((l) => { if (window.__cl.length < 500) window.__cl.push(l); });
    return 1;
  })()`);

  runtime.status.start();
  await wait(5000);

  const lastStatus = async () => JSON.parse(await js('JSON.stringify(window.__st[window.__st.length - 1] ?? null)'));
  const allConsole = async () => JSON.parse(await js('JSON.stringify(window.__cl)'));

  const before = await lastStatus();
  check(
    'fresh profile reports no directory selected',
    before?.reason === 'No AgentCraft directory selected.',
    `reason=${JSON.stringify(before?.reason)}`,
  );

  // Simulate the Browse button: the dialog handler persists the chosen path.
  await js(`window.launcher.patchSettings({ agentcraftDir: ${JSON.stringify(CHECKOUT)} }).then(() => 1)`);
  await wait(9000);

  const after = await lastStatus();
  check(
    'status recovers after choosing a folder (probe latch fixed)',
    after?.valid === true && after?.agentcraftDir === CHECKOUT,
    `valid=${after?.valid} reason=${JSON.stringify(after?.reason)}`,
  );
  check(
    'live Foreman is detected',
    Array.isArray(after?.foremen) && after.foremen.some((f) => f.alive),
    JSON.stringify((after?.foremen ?? []).map((f) => `${f.profile}:${f.pid}:${f.port}`)),
  );

  // The deep probe shells out to foremancli, so give it time to report which
  // models are driving the live Foreman.
  let live = null;
  for (let i = 0; i < 12 && !live; i += 1) {
    await wait(3000);
    const s = await lastStatus();
    live = (s?.foremen ?? []).find((f) => f.alive && f.model) ?? null;
  }
  check(
    'status reports which models the live Foreman is driving',
    Boolean(live?.model) && /opus|sonnet|haiku/i.test(live.model),
    live ? `profile=${live.profile} models=${JSON.stringify(live.model)} auth=${live.auth}` : 'no model reported',
  );

  const lines = await allConsole();
  check(
    'console receives lines (console channel fixed)',
    lines.length > 0,
    `${lines.length} lines: ${lines.slice(0, 3).map((l) => l.text).join(' | ')}`,
  );

  const buttons = JSON.parse(await js(`(() => {
    const out = {};
    for (const b of document.querySelectorAll('button')) {
      const label = (b.textContent || '').trim();
      if (['Stop all', 'Stop Foreman', 'Stop game', 'Start'].includes(label)) {
        out[label] = { disabled: b.disabled };
      }
    }
    return JSON.stringify(out);
  })()`));
  check(
    'Stop Foreman is enabled while a Foreman is live (stale flags fixed)',
    buttons['Stop Foreman']?.disabled === false,
    JSON.stringify(buttons),
  );

  const consoleChars = await js(`(() => {
    const text = document.body.innerText || '';
    const m = text.match(/(\\d+) lines/);
    return JSON.stringify({ reported: m ? Number(m[1]) : null });
  })()`);

  const parsedStart = JSON.parse(await js(`window.launcher
    .start({ backend: 'sim', showcase: false, port: null, devPort: null })
    .then((r) => JSON.stringify(r))`));
  check(
    'Start explains the port clash instead of exiting 1',
    parsedStart.ok === false && /already used by the live/.test(parsedStart.message),
    parsedStart.message,
  );

  console.log(`CONSOLE PANEL ${consoleChars}`);
  console.log(`SUMMARY pass=${results.filter((r) => r.pass).length} fail=${results.filter((r) => !r.pass).length}`);
  app.exit(results.every((r) => r.pass) ? 0 : 1);
});
