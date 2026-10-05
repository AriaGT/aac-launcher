/**
 * The IPC surface. Every handler validates its payload with the shared parsers before
 * touching the filesystem, the settings file or PowerShell. There is intentionally no
 * handler that accepts a command string or an arbitrary path to execute.
 */
import { BrowserWindow, dialog, ipcMain, shell, app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import {
  IPC,
  parseApiKeyInput,
  parseDirectoryPath,
  parseLaunchOptions,
  parseSettingsPatch,
  parseStopOptions,
  type ActionResult,
  type ApiKeyValidationResult,
  type AppInfo,
  type SettingsSnapshot,
  type StartRequest,
} from '../shared/ipc';
import { apiKeyHint, checkAgentCraftDirectory, hasErrors, validateLaunchOptions } from '../shared/validation';
import type { ApiKeyState, DirectoryCheck, LaunchOptions, StopOptions } from '../shared/types';
import { AgentCraftController } from './agentcraft';
import { StatusService } from './status-service';
import { canPersistSecret, decryptSecret, encryptSecret, loadConfig, saveConfig, type StoredConfig } from './store';
import { resolvePowerShell } from './powershell';
import { validateAnthropicApiKey } from './anthropic';
import { createFsProbe, isGitRepo } from './fs-probe';
import { effectivePort, effectiveProfile } from '../shared/command-builder';

export interface LauncherRuntime {
  config: StoredConfig;
  /** Held in memory for the whole session; the only place the plaintext key lives. */
  apiKey: string | null;
  apiKeyStatus: ApiKeyState['status'];
  apiKeyMessage: string;
  apiKeyValidatedAt: number | null;
  status: StatusService;
  controller: AgentCraftController;
}

export function createRuntime(getWindow: () => BrowserWindow | null): LauncherRuntime {
  const config = loadConfig();
  const apiKey: string | null = config.apiKeyBlob ? decryptSecret(config.apiKeyBlob) : null;

  const runtime: LauncherRuntime = {
    config,
    apiKey,
    apiKeyStatus: apiKey ? 'configured' : 'empty',
    apiKeyMessage: apiKey
      ? 'Restored from Windows credential protection (DPAPI).'
      : 'No API key in this session.',
    apiKeyValidatedAt: null,
    status: null as unknown as StatusService,
    controller: null as unknown as AgentCraftController,
  };

  runtime.status = new StatusService(
    {
      agentcraftDir: () => runtime.config.agentcraftDir,
      launchOptions: () => runtime.config.options,
      apiKey: () => runtime.apiKey,
      isBusy: () => runtime.controller.busy,
    },
    (channel, payload) => {
      const win = getWindow();
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    },
  );

  runtime.controller = new AgentCraftController({
    agentcraftDir: () => runtime.config.agentcraftDir,
    launchOptions: () => runtime.config.options,
    console: runtime.status,
    status: runtime.status,
    apiKey: () => runtime.apiKey,
  });
  runtime.controller.setOptions(runtime.config.options);

  return runtime;
}

/* -------------------------------------------------------------------------- */
/* Snapshot helpers                                                           */
/* -------------------------------------------------------------------------- */

function directoryCheck(runtime: LauncherRuntime): DirectoryCheck | null {
  if (!runtime.config.agentcraftDir) return null;
  return checkAgentCraftDirectory(runtime.config.agentcraftDir, createFsProbe());
}

function apiKeyState(runtime: LauncherRuntime): ApiKeyState {
  return {
    status: runtime.apiKeyStatus,
    hint: apiKeyHint(runtime.apiKey ?? ''),
    remember: runtime.config.rememberApiKey,
    canPersist: canPersistSecret(),
    validatedAt: runtime.apiKeyValidatedAt,
    message: runtime.apiKeyMessage,
  };
}

function settingsSnapshot(runtime: LauncherRuntime): SettingsSnapshot {
  const check = directoryCheck(runtime);
  const issues = check?.ok ? validateLaunchOptions(runtime.config.options, { isGitRepo }) : [];
  return {
    agentcraftDir: runtime.config.agentcraftDir,
    directory: check,
    options: runtime.config.options,
    stop: runtime.config.stop,
    issues,
    canPersistSecret: canPersistSecret(),
  };
}

function persist(runtime: LauncherRuntime): void {
  runtime.config.apiKeyBlob =
    runtime.config.rememberApiKey && runtime.apiKey ? encryptSecret(runtime.apiKey) : null;
  saveConfig(runtime.config);
}

function asActionError(error: unknown): ActionResult {
  return { ok: false, message: (error as Error)?.message ?? String(error), summary: null };
}

/** Refuse to run anything unless the directory is a real AgentCraft checkout. */
function requireCheckout(runtime: LauncherRuntime): ActionResult | null {
  const check = directoryCheck(runtime);
  if (!check || !check.ok) {
    return { ok: false, message: check?.message ?? 'Choose the AgentCraft folder first.', summary: null };
  }
  return null;
}

function requireNoOptionErrors(runtime: LauncherRuntime): ActionResult | null {
  const issues = validateLaunchOptions(runtime.config.options, { isGitRepo });
  if (hasErrors(issues)) {
    const first = issues.find((i) => i.severity === 'error');
    return { ok: false, message: first?.message ?? 'Fix the highlighted options first.', summary: null };
  }
  return null;
}

/**
 * Catch the port collision before launch.ps1 does, and say something useful.
 *
 * launch.ps1 derives an empty -ForemanProfile from the backend, so a default `sim`
 * start asks for profile `sim` on port 7878. If a Foreman of *another* profile is
 * already serving 7878, the script dies at its port check and the user only ever sees
 * "exited with code 1". A live Foreman of the *same* profile is fine: the script
 * reuses it.
 */
function requirePortFree(runtime: LauncherRuntime): ActionResult | null {
  const options = runtime.config.options;
  const profile = effectiveProfile(options);
  const port = effectivePort(options);
  const clash = runtime.status
    .snapshot()
    .foremen.find((f) => f.alive && f.port === port && f.profile !== profile);
  if (!clash) return null;

  const action = clash.ownedByLauncher ? 'Stop Foreman, then press Start again' : 'Stop that Foreman, then press Start again';
  return {
    ok: false,
    message:
      `Foreman port ${port} is already used by the live "${clash.profile}" profile (pid ${clash.pid}). ` +
      `This start would use profile "${profile}" on the same port, and launch.ps1 refuses that. ` +
      `${action}, or pick a different Foreman port.`,
    summary: null,
  };
}

function parseStartRequest(runtime: LauncherRuntime, raw: unknown): StartRequest | ActionResult {
  if (typeof raw !== 'object' || raw === null) return { ok: false, message: 'Missing request.', summary: null };
  const record = raw as Record<string, unknown>;

  const optionsParsed = parseLaunchOptions(record.options ?? runtime.config.options);
  if (!optionsParsed.ok) return { ok: false, message: optionsParsed.error, summary: null };
  const options: LaunchOptions = optionsParsed.value;

  const backendRaw = typeof record.backend === 'string' ? record.backend : options.backend;
  const backend = backendRaw === 'claude' ? 'claude' : 'sim';
  // launch.ps1 forces sim for the showcase, so normalise here too.
  const effective: LaunchOptions = { ...options, backend: options.showcase ? 'sim' : backend };

  const stopParsed = record.stop ? parseStopOptions(record.stop) : null;
  if (stopParsed && !stopParsed.ok) return { ok: false, message: stopParsed.error, summary: null };

  const stop: StopOptions = stopParsed && stopParsed.ok
    ? stopParsed.value
    : {
        ...runtime.config.stop,
        foremanProfile: effective.foremanProfile || runtime.config.stop.foremanProfile,
        agentHome: effective.agentHome || runtime.config.stop.agentHome,
        port: effective.port ?? runtime.config.stop.port,
      };

  return { options: effective, stop, backend: effective.backend };
}

function isActionResult(value: StartRequest | ActionResult): value is ActionResult {
  return 'ok' in value;
}

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

export function registerIpc(runtime: LauncherRuntime, getWindow: () => BrowserWindow | null): void {
  const handle = (channel: string, fn: (...args: never[]) => unknown): void => {
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return await (fn as (...a: unknown[]) => unknown)(...args);
      } catch (error) {
        runtime.status.system(`IPC ${channel} failed: ${(error as Error).message}`);
        return { ok: false, message: (error as Error).message, summary: null };
      }
    });
  };

  /* ------------------------------ settings ------------------------------ */

  handle(IPC.settingsGet, () => settingsSnapshot(runtime));

  handle(IPC.settingsPatch, (raw: unknown) => {
    const parsed = parseSettingsPatch(raw);
    if (!parsed.ok) return { ok: false, message: parsed.error, summary: null };
    const patch = parsed.value;

    const before: LaunchOptions = { ...runtime.config.options };
    const beforeStop: StopOptions = { ...runtime.config.stop };

    if (typeof patch.agentcraftDir === 'string') runtime.config.agentcraftDir = patch.agentcraftDir;
    const bounds = patch.windowBounds as { width: number; height: number } | undefined;
    if (bounds) {
      runtime.config.windowBounds = bounds;
      const win = getWindow();
      if (win && !win.isDestroyed()) win.setSize(bounds.width, bounds.height);
    }
    if (typeof patch.rememberApiKey === 'boolean') runtime.config.rememberApiKey = patch.rememberApiKey;

    const optionKeys: Array<keyof LaunchOptions> = [
      'backend', 'foremanProfile', 'port', 'devPort', 'dev', 'reset', 'showcase', 'showcaseAt',
      'agentHome', 'gradleHome', 'repo', 'speed', 'autostart', 'goal', 'useClaudeLogin',
      'notify', 'noNotify', 'noGame', 'noForeman', 'noWait', 'timeoutSec',
    ];
    const target = runtime.config.options as unknown as Record<string, unknown>;
    for (const key of optionKeys) {
      if (key in patch) target[key] = patch[key];
    }
    if ('stopDaemon' in patch) runtime.config.stop.stopDaemon = patch.stopDaemon as boolean;
    if ('stopTimeoutSec' in patch) runtime.config.stop.timeoutSec = patch.stopTimeoutSec as number;

    // Keep the two copies in sync so a stop targets what a start created.
    runtime.config.stop.foremanProfile = runtime.config.options.foremanProfile;
    runtime.config.stop.agentHome = runtime.config.options.agentHome;
    runtime.config.stop.port = runtime.config.options.port;
    runtime.controller.setOptions(runtime.config.options);

    const optionsChanged = JSON.stringify(before) !== JSON.stringify(runtime.config.options);
    const stopChanged = JSON.stringify(beforeStop) !== JSON.stringify(runtime.config.stop);
    if (optionsChanged || stopChanged) {
      persist(runtime);
      void runtime.status.refreshNow();
    }
    return settingsSnapshot(runtime);
  });

  handle(IPC.backendSelect, (raw: unknown) => {
    const parsed = parseSettingsPatch({ backend: (raw as Record<string, unknown>)?.backend });
    if (!parsed.ok || parsed.value.backend !== 'sim' && parsed.value.backend !== 'claude') {
      return { ok: false, message: 'Unknown backend.', summary: null };
    }
    runtime.config.options.backend = parsed.value.backend;
    runtime.config.stop.foremanProfile = runtime.config.options.foremanProfile;
    runtime.controller.setOptions(runtime.config.options);
    persist(runtime);
    void runtime.status.refreshNow();
    return settingsSnapshot(runtime);
  });

  /* ------------------------------ dialogs ------------------------------- */

  handle(IPC.directoryChoose, async () => {
    const win = getWindow();
    const options: Electron.OpenDialogOptions = {
      title: 'Select the AgentCraft folder',
      properties: ['openDirectory'],
      defaultPath: runtime.config.agentcraftDir || app.getPath('home'),
    };
    const result = win && !win.isDestroyed()
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return { ok: true, cancelled: true, snapshot: settingsSnapshot(runtime) };
    runtime.config.agentcraftDir = result.filePaths[0];
    persist(runtime);
    void runtime.status.refreshNow();
    return { ok: true, cancelled: false, snapshot: settingsSnapshot(runtime) };
  });

  handle(IPC.folderChoose, async (raw: unknown) => {
    const parsed = parseDirectoryPath(raw);
    const record = raw as Record<string, unknown>;
    const title = typeof record?.title === 'string' ? record.title : 'Select a folder';
    const defaultPath = parsed.ok && parsed.value ? parsed.value : app.getPath('home');
    const result = await dialog.showOpenDialog({
      title,
      properties: ['openDirectory', 'createDirectory'],
      defaultPath,
    });
    return { ok: true, cancelled: result.canceled || !result.filePaths[0], path: result.filePaths[0] ?? '' };
  });

  handle(IPC.directoryValidate, (raw: unknown) => {
    const parsed = parseDirectoryPath(raw);
    if (!parsed.ok) return checkAgentCraftDirectory('', createFsProbe());
    return checkAgentCraftDirectory(parsed.value, createFsProbe());
  });

  /* ------------------------------ actions ------------------------------- */

  // Restart and Reset deliberately omit the port check: both stop the old Foreman
// first, which is exactly what frees the port.
const guard = (): ActionResult | null =>
    requireCheckout(runtime) ?? requireNoOptionErrors(runtime);
const startGuard = (): ActionResult | null => guard() ?? requirePortFree(runtime);

  handle(IPC.startBackend, async (raw: unknown) => {
    const blocked = startGuard();
    if (blocked) return blocked;
    const request = parseStartRequest(runtime, raw);
    if (isActionResult(request)) return request;
    runtime.status.system(
      `Starting: ${describeLaunch(request.options)}`,
    );
    try {
      return await runtime.controller.start(request);
    } catch (error) {
      return asActionError(error);
    }
  });

  handle(IPC.restart, async (raw: unknown) => {
    const blocked = guard();
    if (blocked) return blocked;
    const request = parseStartRequest(runtime, raw);
    if (isActionResult(request)) return request;
    runtime.status.system(`Restarting: ${describeLaunch(request.options)}`);
    try {
      return await runtime.controller.restart(request);
    } catch (error) {
      return asActionError(error);
    }
  });

  handle(IPC.reset, async (raw: unknown) => {
    const blocked = guard();
    if (blocked) return blocked;
    const request = parseStartRequest(runtime, raw);
    if (isActionResult(request)) return request;
    runtime.status.system(
      `Resetting: stopping the Foreman first, then starting with -Reset (${describeLaunch(request.options)})`,
    );
    try {
      return await runtime.controller.reset(request);
    } catch (error) {
      return asActionError(error);
    }
  });

  handle(IPC.stopAll, async () => {
    const blocked = requireCheckout(runtime);
    if (blocked) return blocked;
    try {
      return await runtime.controller.stopAll({ ...runtime.config.stop, game: true, foreman: true });
    } catch (error) {
      return asActionError(error);
    }
  });

  handle(IPC.stopForeman, async () => {
    const blocked = requireCheckout(runtime);
    if (blocked) return blocked;
    try {
      return await runtime.controller.stopForeman({ ...runtime.config.stop });
    } catch (error) {
      return asActionError(error);
    }
  });

  handle(IPC.stopGame, async () => {
    const blocked = requireCheckout(runtime);
    if (blocked) return blocked;
    try {
      return await runtime.controller.stopGame({ ...runtime.config.stop });
    } catch (error) {
      return asActionError(error);
    }
  });

  /* --------------------------- status / console ------------------------- */

  handle(IPC.statusRead, () => runtime.status.snapshot());
  handle(IPC.consoleRead, () => runtime.status.read());
  handle(IPC.consoleClear, () => {
    runtime.status.clear();
    return runtime.status.read();
  });

  handle(IPC.logsOpen, () => {
    const check = directoryCheck(runtime);
    if (!check?.ok) return { ok: false, message: check?.message ?? 'No AgentCraft folder selected.' };
    const logs = path.join(check.resolved, 'artifacts', 'logs');
    try {
      fs.mkdirSync(logs, { recursive: true });
    } catch {
      /* the shell will complain if it is not there */
    }
    const error = shell.openPath(logs);
    return error ? { ok: false, message: error } : { ok: true, message: `Opened ${logs}` };
  });

  /* ------------------------------ API key ------------------------------- */

  handle(IPC.apiKeySet, (raw: unknown) => {
    const parsed = parseApiKeyInput(raw);
    if (!parsed.ok) return { ok: false, message: parsed.error, state: apiKeyState(runtime) };
    const key = parsed.value.apiKey.trim();
    if (!key) return { ok: false, message: 'The API key is empty.', state: apiKeyState(runtime) };

    runtime.apiKey = key;
    runtime.config.rememberApiKey = parsed.value.remember;
    runtime.apiKeyStatus = 'configured';
    runtime.apiKeyMessage = parsed.value.remember
      ? canPersistSecret()
        ? 'Stored in memory and encrypted with Windows DPAPI for this user.'
        : 'Stored in memory only: Windows credential protection is unavailable.'
      : 'Stored in memory only for this session.';
    runtime.apiKeyValidatedAt = null;
    persist(runtime);
    return { ok: true, message: runtime.apiKeyMessage, state: apiKeyState(runtime) };
  });

  handle(IPC.apiKeyClear, () => {
    runtime.apiKey = null;
    runtime.config.apiKeyBlob = null;
    runtime.config.rememberApiKey = false;
    runtime.apiKeyStatus = 'empty';
    runtime.apiKeyMessage = 'The API key was removed from this launcher.';
    runtime.apiKeyValidatedAt = null;
    persist(runtime);
    return { ok: true, message: runtime.apiKeyMessage, state: apiKeyState(runtime) };
  });

  handle(IPC.apiKeyValidate, async (): Promise<ApiKeyValidationResult> => {
    if (!runtime.apiKey) {
      const result: ApiKeyValidationResult = { status: 'empty', message: 'No API key configured.', at: Date.now() };
      runtime.apiKeyStatus = 'empty';
      runtime.apiKeyMessage = result.message;
      return result;
    }
    runtime.status.system('Validating the API key against the Anthropic API (GET /v1/models)...');
    const result = await validateAnthropicApiKey(runtime.apiKey);
    runtime.apiKeyStatus = result.status;
    runtime.apiKeyMessage = result.message;
    runtime.apiKeyValidatedAt = result.at;
    runtime.status.system(`API key: ${result.message}`);
    return result;
  });

  handle(IPC.apiKeyRead, () => apiKeyState(runtime));

  /* ------------------------------ app info ------------------------------ */

  handle(IPC.platformInfo, (): AppInfo => {
    const shellInfo = resolvePowerShell();
    return {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? '',
      nodeVersion: process.versions.node,
      powershell: 'exe' in shellInfo ? shellInfo.exe : null,
      powershellError: 'error' in shellInfo ? shellInfo.error : null,
      nodeExe: process.execPath,
      packaged: app.isPackaged,
    };
  });
}

function describeLaunch(options: LaunchOptions): string {
  const parts = [`backend ${options.showcase ? 'sim (showcase)' : options.backend}`];
  if (options.foremanProfile) parts.push(`profile ${options.foremanProfile}`);
  if (options.dev) parts.push('-Dev');
  if (options.autostart) parts.push('-Autostart');
  if (options.goal) parts.push('goal set');
  if (options.repo.length) parts.push(`${options.repo.length} repo path(s)`);
  return parts.join(', ');
}