import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ActionResult, AppInfo, ConsoleSnapshot, SettingsSnapshot } from '../shared/ipc';
import type {
  AgentCraftStatus,
  ApiKeyState,
  ConsoleLine,
  OperationState,
} from '../shared/types';
import { EMPTY_STATUS } from '../shared/types';
import { ApiKeyPanel } from './ApiKeyPanel';
import { ConsolePanel } from './ConsolePanel';
import { DirectoryPanel } from './DirectoryPanel';
import { OptionsPanel } from './OptionsPanel';
import { StatusPanel } from './StatusPanel';
import { Chip } from './ui';
import './index.css';

const bridge = window.launcher;

/** Drives the visible "now" so relative timestamps stay fresh between polls. */
function useTicker(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [settings, setSettings] = useState<SettingsSnapshot | null>(null);
  const [status, setStatus] = useState<AgentCraftStatus>(EMPTY_STATUS);
  const [apiKey, setApiKey] = useState<ApiKeyState | null>(null);
  const [consoleLines, setConsoleLines] = useState<ConsoleLine[]>([]);
  const [consoleTruncated, setConsoleTruncated] = useState(false);
  const [operation, setOperation] = useState<OperationState | null>(null);
  const [toast, setToast] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const now = useTicker(1000);

  /* ---------------------------- initial load ---------------------------- */

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [loadedInfo, loadedSettings, loadedConsole, loadedStatus, loadedKey] = await Promise.all([
        bridge.getInfo(),
        bridge.getSettings(),
        bridge.readConsole(),
        bridge.readStatus(),
        bridge.readApiKeyState(),
      ]);
      if (!alive) return;
      setInfo(loadedInfo);
      setSettings(loadedSettings);
      setConsoleLines(loadedConsole.lines);
      setConsoleTruncated(loadedConsole.truncated);
      setStatus(loadedStatus);
      setApiKey(loadedKey);
    })();
    return () => {
      alive = false;
    };
  }, []);

  /* ----------------------------- listeners ----------------------------- */

  useEffect(() => {
    const offs = [
      bridge.onConsole((line) => setConsoleLines((prev) => [...prev.slice(-2999), line])),
      bridge.onConsoleClear(() => {
        setConsoleLines([]);
        setConsoleTruncated(false);
      }),
      bridge.onStatus(setStatus),
      bridge.onOperation(setOperation),
      bridge.onSettings(setSettings),
      bridge.onApiKey(setApiKey),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  // A toast is transient; clear it after a beat.
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  /* ------------------------------ actions ------------------------------ */

  const flash = useCallback((result: ActionResult) => {
    setToast({ tone: result.ok ? 'ok' : 'bad', text: result.message });
  }, []);

  const run = useCallback(
    async (label: string, fn: () => Promise<ActionResult>) => {
      setBusy(true);
      try {
        flash(await fn());
      } catch (error) {
        setToast({ tone: 'bad', text: `${label} failed: ${(error as Error).message}` });
      } finally {
        setBusy(false);
      }
    },
    [flash],
  );

  const patch = useCallback(
    (patchBody: Record<string, unknown>) => {
      void bridge.patchSettings(patchBody).then((result) => {
        if ('directory' in result) setSettings(result);
        else setToast({ tone: 'bad', text: result.message });
      });
    },
    [],
  );

  const chooseDir = useCallback(async () => {
    setBusy(true);
    try {
      const result = await bridge.chooseAgentCraftDir();
      if (!result.cancelled && result.snapshot) setSettings(result.snapshot);
    } finally {
      setBusy(false);
    }
  }, []);

  const clearConsole = useCallback(async () => {
    const snapshot: ConsoleSnapshot = await bridge.clearConsole();
    setConsoleLines(snapshot.lines);
    setConsoleTruncated(snapshot.truncated);
  }, []);

  if (!settings || !apiKey) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-500">
        Loading the launcher…
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <header className="panel flex flex-none items-center justify-between gap-4 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="text-sm font-bold tracking-tight text-slate-100">AgentCraft Launcher</h1>
          <Chip tone={status.valid ? 'ok' : 'bad'}>{status.valid ? 'checkout ok' : 'no checkout'}</Chip>
          {operation && <Chip tone="warn">{operation.message}</Chip>}
        </div>
        <div className="flex flex-none items-center gap-2 text-[11px] text-slate-500">
          {info && (
            <>
              <span className="font-mono">v{info.appVersion}</span>
              <span>Electron {info.electronVersion}</span>
              <span>Node {info.nodeVersion}</span>
              {info.powershell && <span className="font-mono">PowerShell 5.1</span>}
              {info.powershellError && <Chip tone="bad">PowerShell not found</Chip>}
            </>
          )}
        </div>
      </header>

      {toast && (
        <div
          className={`flex-none rounded-lg border px-4 py-2 text-xs ${
            toast.tone === 'ok'
              ? 'border-emerald-700/50 bg-emerald-950/40 text-emerald-200'
              : 'border-rose-800/60 bg-rose-950/40 text-rose-200'
          }`}
        >
          {toast.text}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto lg:grid-cols-[minmax(360px,420px)_1fr] lg:overflow-hidden">
        <div className="sidebar-stack flex min-h-0 flex-col gap-3 overflow-y-auto">
          <DirectoryPanel check={settings.directory} busy={busy} onChoose={chooseDir} onValidate={(path) => void bridge.validateDirectory(path).then(() => patch({ agentcraftDir: path }))} />
          <OptionsPanel
            snapshot={settings}
            operation={operation}
            status={status}
            onPatch={patch}
            onSelectBackend={(backend) => {
              void bridge.selectBackend(backend).then((result) => {
                if ('directory' in result) setSettings(result);
                else setToast({ tone: 'bad', text: result.message });
              });
            }}
            onStart={() => void run('Start', () => bridge.start(settings.options))}
            onRestart={() => void run('Restart', () => bridge.restart(settings.options))}
            onReset={() => void run('Reset', () => bridge.reset(settings.options))}
            onStopAll={() => void run('Stop all', () => bridge.stopAll(settings.stop))}
            onStopForeman={() => void run('Stop Foreman', () => bridge.stopForeman(settings.stop))}
            onStopGame={() => void run('Stop game', () => bridge.stopGame(settings.stop))}
            onOpenLogs={() => void bridge.openLogs().then((r) => setToast({ tone: r.ok ? 'ok' : 'bad', text: r.message }))}
          />
          <ApiKeyPanel state={apiKey} />
        </div>

        <div className="flex min-h-0 flex-col gap-3 lg:overflow-hidden">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <StatusPanel status={status} operation={operation} options={settings.options} now={now} />
          </div>
          <div className="flex min-h-[240px] flex-1 flex-col">
            <ConsolePanel lines={consoleLines} truncated={consoleTruncated} onClear={() => void clearConsole()} />
          </div>
        </div>
      </div>
    </div>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);