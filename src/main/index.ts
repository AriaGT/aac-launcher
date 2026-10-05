/**
 * Electron main entry point.
 *
 * Security posture (Electron's own recommendations):
 *   - contextIsolation on, nodeIntegration off, sandbox on for the renderer
 *   - a preload script that only re-exports the fixed IPC allowlist via contextBridge
 *   - navigation and window.open blocked, external links handed to the system browser
 *   - the renderer loaded from a custom privileged scheme, never from file://
 */
import { BrowserWindow, Menu, app, session, shell, protocol } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime, registerIpc } from './ipc';
import { probeScriptPath } from './status-service';

const RENDERER_ORIGIN = 'app://agentcraft-launcher';
/** `npm run dev` sets NODE_ENV=development and starts Vite before Electron. */
const isDev = process.env.NODE_ENV === 'development';

/* -------------------------------------------------------------------------- */
/* Protocol                                                                   */
/* -------------------------------------------------------------------------- */

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

let mainWindow: BrowserWindow | null = null;

function getWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

function serveRenderer(): void {
  // In dev the renderer is the Vite dev server; when packaged it is the built bundle.
  if (isDev) {
    const devServer = process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5273';
    void mainWindow?.loadURL(devServer);
    return;
  }

  const rendererRoot = path.join(app.getAppPath(), 'out', 'renderer');
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'agentcraft-launcher') return new Response('Not found', { status: 404 });

    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    const target = path.join(rendererRoot, path.normalize(requested).replace(/^([/\\])+/, ''));
    if (!target.startsWith(rendererRoot)) return new Response('Forbidden', { status: 403 });

    try {
      const { readFile } = await import('node:fs/promises');
      const data = await readFile(target);
      const { existsSync } = await import('node:fs');
      const ext = path.extname(target);
      const contentType = existsSync(target)
        ? ({
            '.html': 'text/html; charset=utf-8',
            '.js': 'text/javascript; charset=utf-8',
            '.mjs': 'text/javascript; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.json': 'application/json; charset=utf-8',
            '.svg': 'image/svg+xml',
            '.png': 'image/png',
            '.ico': 'image/x-icon',
            '.woff2': 'font/woff2',
          }[ext] ?? 'application/octet-stream')
        : 'application/octet-stream';
      return new Response(data, { headers: { 'content-type': contentType } });
    } catch {
      // Unknown paths fall back to the SPA entry point.
      const { readFile } = await import('node:fs/promises');
      const html = await readFile(path.join(rendererRoot, 'index.html'));
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
  });

  void mainWindow?.loadURL(`${RENDERER_ORIGIN}/index.html`);
}

/* -------------------------------------------------------------------------- */
/* Window                                                                     */
/* -------------------------------------------------------------------------- */

function createWindow(runtime: ReturnType<typeof createRuntime>): void {
  const bounds = runtime.config.windowBounds ?? { width: 1180, height: 820 };

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: '#0b1020',
    title: 'AgentCraft Launcher',
    autoHideMenuBar: true,
    icon: path.join(app.getAppPath(), 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  });

  Menu.setApplicationMenu(null);

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    if (isDev && process.env.LAUNCHER_DEVTOOLS === '1') mainWindow?.webContents.openDevTools({ mode: 'detach' });
  });

  mainWindow.on('resize', () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized() || mainWindow.isMaximized()) return;
    const [width, height] = mainWindow.getSize();
    runtime.config.windowBounds = { width, height };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // No in-app navigation and no popups: external links go to the system browser.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(RENDERER_ORIGIN) || url.startsWith('http://localhost:5273')) return;
    event.preventDefault();
    void shell.openExternal(url);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  // Opt-in renderer logging: set LAUNCHER_LOG_RENDERER=1 when diagnosing a packaged app.
  if (process.env.LAUNCHER_LOG_RENDERER === '1') {
    mainWindow.webContents.on('console-message', (...args: unknown[]) => {
      // Electron 44 passes one event object; older signatures passed positional fields.
      const first = args[0] as
        | { level?: string | number; message?: string; lineNumber?: number; sourceId?: string }
        | undefined;
      if (first && typeof first === 'object' && 'message' in first) {
        console.log(
          `[renderer:${first.level}] ${first.message} (${first.sourceId ?? '?'}:${first.lineNumber ?? 0})`,
        );
        return;
      }
      const [level, message, line, source] = args as [number, string, number, string];
      console.log(`[renderer:${level}] ${message} (${source}:${line})`);
    });
    mainWindow.webContents.on('did-fail-load', (_e, code, description, url) => {
      console.error(`[renderer] did-fail-load ${code} ${description} ${url}`);
    });
    mainWindow.webContents.on('render-process-gone', (_e, details) => {
      console.error(`[renderer] process gone: ${details.reason}`);
    });
    mainWindow.webContents.on('preload-error', (_e, preloadPath, error) => {
      console.error(`[renderer] preload error in ${preloadPath}: ${error.message}`);
    });

    // A one-line summary, so a blank or half-drawn window is visible without devtools.
    mainWindow.webContents.on('did-finish-load', () => {
      setTimeout(() => {
        void mainWindow?.webContents
          .executeJavaScript(
            `(() => {
              const text = document.body.innerText || '';
              return JSON.stringify({
                bridge: typeof window.launcher,
                methods: typeof window.launcher === 'object' ? Object.keys(window.launcher).length : 0,
                rendered: !text.includes('Loading the launcher') && text.length > 0,
                chars: text.length,
                loading: text.includes('Loading the launcher'),
              });
            })()`,
          )
          .then((report: string) => console.log(`[renderer:dom] ${report}`))
          .catch((error: Error) => console.error(`[renderer:dom] ${error.message}`));
      }, 4000);
    });
  }

  serveRenderer();
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = getWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  void app.whenReady().then(() => {
    // The renderer never needs a camera, a microphone or notifications.
    session.defaultSession.setPermissionCheckHandler(() => false);

    const runtime = createRuntime(getWindow);
    registerIpc(runtime, getWindow);

    createWindow(runtime);
    runtime.status.start();

    // Log the resolved probe path once, so a packaging mistake is obvious in devtools.
    console.log('[launcher] probe script:', probeScriptPath());

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(runtime);
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', () => {
    // Nothing is killed here on purpose: AgentCraft processes belong to the user, and
    // stop.ps1 is the only sanctioned way to end them.
    session.defaultSession.clearCache().catch(() => undefined);
  });

  process.on('uncaughtException', (error) => {
    console.error('[launcher] uncaught:', error);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[launcher] unhandled rejection:', reason);
  });
}

export { pathToFileURL };