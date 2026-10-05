/**
 * Preload bridge.
 *
 * This runs in an isolated world with `sandbox: true`, so it must be CommonJS and may
 * only use `electron`'s renderer-safe API surface. It exposes a fixed set of functions
 * and event subscriptions; there is no generic `invoke(channel, ...)` escape hatch, so
 * the renderer cannot reach a channel this file does not name.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, IPC_EVENTS } from '../shared/ipc';
import type {
  ActionResult,
  ApiKeyValidationResult,
  AppInfo,
  ConsoleSnapshot,
  SettingsSnapshot,
  StartRequest,
} from '../shared/ipc';
import type { AgentCraftStatus, ApiKeyState, DirectoryCheck, OperationState } from '../shared/types';
import type { Backend, LaunchOptions, StopOptions } from '../shared/types';

export interface LauncherBridge {
  getInfo(): Promise<AppInfo>;

  getSettings(): Promise<SettingsSnapshot>;
  patchSettings(patch: Record<string, unknown>): Promise<SettingsSnapshot | { ok: false; message: string }>;
  selectBackend(backend: Backend): Promise<SettingsSnapshot | { ok: false; message: string }>;

  chooseAgentCraftDir(): Promise<{ ok: boolean; cancelled: boolean; snapshot?: SettingsSnapshot }>;
  chooseFolder(title: string): Promise<{ ok: boolean; cancelled: boolean; path: string }>;
  validateDirectory(path: string): Promise<DirectoryCheck>;

  start(options?: LaunchOptions): Promise<ActionResult>;
  restart(options?: LaunchOptions): Promise<ActionResult>;
  reset(options?: LaunchOptions): Promise<ActionResult>;
  stopAll(stop?: Partial<StopOptions>): Promise<ActionResult>;
  stopForeman(stop?: Partial<StopOptions>): Promise<ActionResult>;
  stopGame(stop?: Partial<StopOptions>): Promise<ActionResult>;

  readStatus(): Promise<AgentCraftStatus>;
  readConsole(): Promise<ConsoleSnapshot>;
  clearConsole(): Promise<ConsoleSnapshot>;
  openLogs(): Promise<{ ok: boolean; message: string }>;

  setApiKey(apiKey: string, remember: boolean): Promise<{ ok: boolean; message: string; state: ApiKeyState }>;
  clearApiKey(): Promise<{ ok: boolean; message: string; state: ApiKeyState }>;
  validateApiKey(): Promise<ApiKeyValidationResult>;
  readApiKeyState(): Promise<ApiKeyState>;

  onConsole(handler: (line: import('../shared/types').ConsoleLine) => void): () => void;
  onConsoleClear(handler: () => void): () => void;
  onStatus(handler: (status: AgentCraftStatus) => void): () => void;
  onOperation(handler: (operation: OperationState | null) => void): () => void;
  onSettings(handler: (settings: SettingsSnapshot) => void): () => void;
  onApiKey(handler: (state: ApiKeyState) => void): () => void;
}

function request(options?: LaunchOptions): StartRequest {
  const resolved = options ?? ({} as Partial<LaunchOptions>);
  // `backend` is carried both inside options and as a top-level hint. Derive the hint
  // from the same value the renderer chose instead of a constant, otherwise a Claude
  // start would silently be validated and launched as sim.
  const backend: Backend = resolved.showcase ? 'sim' : resolved.backend === 'claude' ? 'claude' : 'sim';
  return { options: resolved as LaunchOptions, backend };
}

const bridge: LauncherBridge = {
  getInfo: () => ipcRenderer.invoke(IPC.platformInfo),

  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  patchSettings: (patch) => ipcRenderer.invoke(IPC.settingsPatch, patch),
  selectBackend: (backend) => ipcRenderer.invoke(IPC.backendSelect, { backend }),

  chooseAgentCraftDir: () => ipcRenderer.invoke(IPC.directoryChoose),
  chooseFolder: (title) => ipcRenderer.invoke(IPC.folderChoose, { title }),
  validateDirectory: (path) => ipcRenderer.invoke(IPC.directoryValidate, { path }),

  start: (options) => ipcRenderer.invoke(IPC.startBackend, request(options)),
  restart: (options) => ipcRenderer.invoke(IPC.restart, request(options)),
  reset: (options) => ipcRenderer.invoke(IPC.reset, request(options)),
  stopAll: (stop) => ipcRenderer.invoke(IPC.stopAll, stop ?? {}),
  stopForeman: (stop) => ipcRenderer.invoke(IPC.stopForeman, stop ?? {}),
  stopGame: (stop) => ipcRenderer.invoke(IPC.stopGame, stop ?? {}),

  readStatus: () => ipcRenderer.invoke(IPC.statusRead),
  readConsole: () => ipcRenderer.invoke(IPC.consoleRead),
  clearConsole: () => ipcRenderer.invoke(IPC.consoleClear),
  openLogs: () => ipcRenderer.invoke(IPC.logsOpen),

  setApiKey: (apiKey, remember) => ipcRenderer.invoke(IPC.apiKeySet, { apiKey, remember }),
  clearApiKey: () => ipcRenderer.invoke(IPC.apiKeyClear),
  validateApiKey: () => ipcRenderer.invoke(IPC.apiKeyValidate),
  readApiKeyState: () => ipcRenderer.invoke(IPC.apiKeyRead),

  onConsole: (handler) => subscribe(IPC_EVENTS.console, handler),
  onConsoleClear: (handler) => subscribe(IPC_EVENTS.consoleClear, () => handler()),
  onStatus: (handler) => subscribe(IPC_EVENTS.status, handler),
  onOperation: (handler) => subscribe(IPC_EVENTS.operation, handler),
  onSettings: (handler) => subscribe(IPC_EVENTS.settings, handler),
  onApiKey: (handler) => subscribe(IPC_EVENTS.apiKey, handler),
};

function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => handler(payload);
  ipcRenderer.on(channel, listener as never);
  return () => {
    ipcRenderer.removeListener(channel, listener as never);
  };
}

contextBridge.exposeInMainWorld('launcher', bridge);