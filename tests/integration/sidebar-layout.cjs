/**
 * Layout check for the sidebar overlap.
 *
 * The sidebar is a scrolling flex column of panels. Flex items default to
 * flex-shrink: 1, so when the panels are taller than the column each one was
 * squeezed below its own content height; because .panel does not clip, the contents
 * spilled over the panel below. This asserts the panels no longer intersect each
 * other and that the column really scrolls.
 */
const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');

const LAUNCHER = 'C:\\Users\\aless\\Repositorios\\aac-launcher';
const CHECKOUT = 'C:\\Users\\aless\\Repositorios\\agentcraft';
const { createRuntime, registerIpc } = require(path.join(LAUNCHER, 'out', 'main', 'ipc.js'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let window = null;
const getWindow = () => (window && !window.isDestroyed() ? window : null);

app.on('window-all-closed', () => {});
app.disableHardwareAcceleration();

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ` :: ${detail}` : ''}`);
};

app.whenReady().then(async () => {
  session.defaultSession.setPermissionCheckHandler(() => false);
  const runtime = createRuntime(getWindow);
  registerIpc(runtime, getWindow);
  runtime.config.agentcraftDir = CHECKOUT;
  runtime.config.options.dev = true;
  runtime.config.options.devPort = 7880;
  runtime.config.options.speed = 'fast';
  runtime.config.options.goal = 'a fairly long goal string to make the options panel taller than the viewport';

  // A deliberately short window, the worst case for the sidebar.
  window = new BrowserWindow({
    show: false,
    width: 1180,
    height: 620,
    webPreferences: {
      preload: path.join(LAUNCHER, 'out', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const js = (code) => window.webContents.executeJavaScript(code).catch((e) => `THREW: ${e.message}`);

  await window.loadFile(path.join(LAUNCHER, 'out', 'renderer', 'index.html'));
  for (let i = 0; i < 40; i += 1) {
    if ((await js('typeof window.launcher')) === 'object') break;
    await wait(250);
  }
  await wait(3500);

  const report = JSON.parse(await js(`(() => {
    const stack = document.querySelector('.sidebar-stack');
    if (!stack) return JSON.stringify({ error: 'no .sidebar-stack' });
    const kids = [...stack.children].map((el) => {
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        height: Math.round(r.height),
        scrollH: el.scrollHeight,
        clientH: el.clientHeight,
        overflowsSelf: el.scrollHeight - el.clientHeight,
      };
    });
    const overlaps = [];
    for (let i = 0; i < kids.length - 1; i += 1) {
      if (kids[i].bottom > kids[i + 1].top + 1) {
        overlaps.push({ i, aBottom: kids[i].bottom, bTop: kids[i + 1].top });
      }
    }
    const sr = stack.getBoundingClientRect();
    return JSON.stringify({
      panels: kids,
      overlaps,
      column: {
        scrollH: stack.scrollHeight,
        clientH: stack.clientHeight,
        scrollable: stack.scrollHeight > stack.clientHeight + 1,
        overflowY: getComputedStyle(stack).overflowY,
        height: Math.round(sr.height),
      },
      viewport: { w: window.innerWidth, h: window.innerHeight },
      bodyOverflow: getComputedStyle(document.body).overflow,
    });
  })()`));

  if (report.error) {
    console.log(`ERROR ${report.error}`);
    app.exit(2);
    return;
  }

  check('sidebar has panels', report.panels.length === 3, `${report.panels.length} panels`);
  check('no sidebar panels overlap', report.overlaps.length === 0, JSON.stringify(report.overlaps));
  check(
    'no panel is squeezed below its own content',
    report.panels.every((p) => p.overflowsSelf <= 1),
    JSON.stringify(report.panels.map((p) => `${p.tag}:h=${p.height},content=${p.scrollH}`)),
  );
  check(
    'sidebar column scrolls instead of clipping',
    report.column.scrollable && report.column.overflowY === 'auto',
    JSON.stringify(report.column),
  );

  // And the body itself must not scroll: only the columns do.
  check('body does not scroll', report.bodyOverflow === 'hidden', `body overflow=${report.bodyOverflow}`);

  console.log(`VIEWPORT ${JSON.stringify(report.viewport)}`);
  console.log(`SUMMARY pass=${results.filter((r) => r.pass).length} fail=${results.filter((r) => !r.pass).length}`);
  app.exit(results.every((r) => r.pass) ? 0 : 1);
});
