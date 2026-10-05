/**
 * The complete IPC contract. The renderer can only ask for the named actions below;
 * there is deliberately no channel that accepts a command string.
 */
import {
  DEFAULT_LAUNCH_OPTIONS,
  DEFAULT_STOP_OPTIONS,
  type AgentCraftStatus,
  type ApiKeyState,
  type Backend,
  type ConsoleLine,
  type DirectoryCheck,
  type LaunchOptions,
  type OperationState,
  type StopOptions,
  type ValidationIssue,
} from './types';

export const IPC = {
  /* renderer -> main (invoke) */
  settingsGet: 'settings:get',
  settingsPatch: 'settings:patch',
  backendSelect: 'settings:select-backend',

  directoryChoose: 'dialog:choose-agentcraft',
  directoryValidate: 'dialog:validate-directory',
  folderChoose: 'dialog:choose-folder',

  startBackend: 'action:start-backend',
  restart: 'action:restart',
  reset: 'action:reset',
  stopAll: 'action:stop-all',
  stopForeman: 'action:stop-foreman',
  stopGame: 'action:stop-game',

  statusRead: 'status:read',
  consoleRead: 'console:read',
  consoleClear: 'console:clear',
  logsOpen: 'logs:open',

  apiKeySet: 'apikey:set',
  apiKeyClear: 'apikey:clear',
  apiKeyValidate: 'apikey:validate',
  apiKeyRead: 'apikey:read',

  platformInfo: 'app:info',
} as const;

/** Events pushed from the main process to the renderer. */
export const IPC_EVENTS = {
  console: 'event:console',
  consoleClear: 'event:console-clear',
  status: 'event:status',
  operation: 'event:operation',
  settings: 'event:settings',
  apiKey: 'event:api-key',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
export type IpcEventName = (typeof IPC_EVENTS)[keyof typeof IPC_EVENTS];

export interface AppInfo {
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  powershell: string | null;
  powershellError: string | null;
  nodeExe: string | null;
  packaged: boolean;
}

export interface SettingsSnapshot {
  agentcraftDir: string;
  directory: DirectoryCheck | null;
  options: LaunchOptions;
  stop: StopOptions;
  issues: ValidationIssue[];
  canPersistSecret: boolean;
}
export interface ActionResult {
  ok: boolean;
  message: string;
  /** Present after a launch: launch.ps1 -SummaryJson contents. */
  summary: unknown | null;
}

export interface ApiKeyValidationResult {
  status: 'validated' | 'invalid' | 'unavailable' | 'empty';
  message: string;
  at: number;
}

export interface StartRequest {
  options: LaunchOptions;
  stop?: StopOptions;
  /** Only used by the claude backend; resolved in main, never in the renderer. */
  backend: Backend;
}

export interface ConsoleSnapshot {
  lines: ConsoleLine[];
  truncated: boolean;
}

/* -------------------------------------------------------------------------- */
/* Payload validation                                                          */
/* -------------------------------------------------------------------------- */

export type ValidationOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

function fail(error: string): ValidationOutcome<never> {
  return { ok: false, error };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function intOrNull(value: unknown, min: number, max: number): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.trunc(n);
  if (rounded < min || rounded > max) return null;
  return rounded;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

const MAX_STRING = 4096;
const MAX_LIST = 32;

/**
 * Every incoming payload is re-validated here. Values that do not fit the declared
 * contract are rejected instead of being forwarded to PowerShell.
 */
export function parseLaunchOptions(input: unknown): ValidationOutcome<LaunchOptions> {
  if (!isPlainObject(input)) return fail('launch options must be an object');

  // An absent backend means "the launcher's default"; a present but unknown one is a bug
  // or a tampered payload and must not be silently replaced.
  const backendRaw = input.backend === undefined ? DEFAULT_LAUNCH_OPTIONS.backend : str(input.backend);
  if (backendRaw !== 'sim' && backendRaw !== 'claude') return fail('backend must be "sim" or "claude"');

  const showcaseAtRaw = str(input.showcaseAt);
  const showcaseAt: 'busy' | 'late' = showcaseAtRaw === 'late' ? 'late' : 'busy';

  const repoRaw = Array.isArray(input.repo) ? input.repo : [];
  const repo = repoRaw
    .slice(0, MAX_LIST)
    .map((v) => (typeof v === 'string' ? v.trim().slice(0, MAX_STRING) : ''))
    .filter((v) => v.length > 0)
    .slice(0, MAX_LIST);

  return {
    ok: true,
    value: {
      backend: backendRaw,
      foremanProfile: (str(input.foremanProfile) ?? '').slice(0, 64),
      port: intOrNull(input.port, 1, 65535),
      devPort: intOrNull(input.devPort, 1, 65535),
      dev: bool(input.dev, false),
      reset: bool(input.reset, false),
      showcase: bool(input.showcase, false),
      showcaseAt,
      agentHome: (str(input.agentHome) ?? '').slice(0, MAX_STRING),
      gradleHome: (str(input.gradleHome) ?? '').slice(0, MAX_STRING),
      repo,
      speed: numberOrNull(input.speed),
      autostart: bool(input.autostart, false),
      goal: (str(input.goal) ?? '').slice(0, 1024),
      useClaudeLogin: bool(input.useClaudeLogin, false),
      notify: bool(input.notify, false),
      noNotify: bool(input.noNotify, false),
      noGame: bool(input.noGame, false),
      noForeman: bool(input.noForeman, false),
      noWait: bool(input.noWait, false),
      timeoutSec: intOrNull(input.timeoutSec, 10, 86400) ?? DEFAULT_LAUNCH_OPTIONS.timeoutSec,
    },
  };
}

export function parseStopOptions(input: unknown): ValidationOutcome<StopOptions> {
  if (!isPlainObject(input)) return fail('stop options must be an object');
  const timeout = intOrNull(input.timeoutSec, 1, 3600);
  // An explicitly out-of-range timeout is a mistake worth reporting; an absent one is fine.
  if (input.timeoutSec !== undefined && input.timeoutSec !== null && input.timeoutSec !== '' && timeout === null) {
    return fail('stop timeoutSec must be between 1 and 3600');
  }
  return {
    ok: true,
    value: {
      game: bool(input.game, false),
      foreman: bool(input.foreman, false),
      stopDaemon: bool(input.stopDaemon, false),
      foremanProfile: (str(input.foremanProfile) ?? '').slice(0, 64),
      agentHome: (str(input.agentHome) ?? '').slice(0, MAX_STRING),
      port: intOrNull(input.port, 1, 65535),
      timeoutSec: timeout ?? DEFAULT_STOP_OPTIONS.timeoutSec,
    },
  };
}

/** Payload accepted by `settings:patch`: a shallow, per-field allowlist. */
export function parseSettingsPatch(input: unknown): ValidationOutcome<Record<string, unknown>> {
  if (!isPlainObject(input)) return fail('settings patch must be an object');
  const patch: Record<string, unknown> = {};

  if ('agentcraftDir' in input) patch.agentcraftDir = (str(input.agentcraftDir) ?? '').slice(0, MAX_STRING);

  const allowedFlags = [
    'dev',
    'reset',
    'showcase',
    'autostart',
    'useClaudeLogin',
    'notify',
    'noNotify',
    'noGame',
    'noForeman',
    'noWait',
    'stopDaemon',
  ] as const;

  for (const flag of allowedFlags) {
    if (flag in input) {
      if (typeof input[flag] !== 'boolean') return fail(`${flag} must be a boolean`);
      patch[flag] = input[flag];
    }
  }

  const allowedStrings: Array<[keyof LaunchOptions, number]> = [
    ['foremanProfile', 64],
    ['agentHome', MAX_STRING],
    ['gradleHome', MAX_STRING],
    ['goal', 1024],
  ];
  for (const [key, max] of allowedStrings) {
    if (key in input) {
      const value = str(input[key]);
      if (value === null) return fail(`${key} must be a string`);
      patch[key] = value.slice(0, max);
    }
  }

  if ('backend' in input) {
    const value = str(input.backend);
    if (value !== 'sim' && value !== 'claude') return fail('backend must be "sim" or "claude"');
    patch.backend = value;
  }
  if ('showcaseAt' in input) {
    const value = str(input.showcaseAt);
    if (value !== 'busy' && value !== 'late') return fail('showcaseAt must be "busy" or "late"');
    patch.showcaseAt = value;
  }
  if ('port' in input) patch.port = intOrNull(input.port, 1, 65535);
  if ('devPort' in input) patch.devPort = intOrNull(input.devPort, 1, 65535);
  if ('speed' in input) patch.speed = numberOrNull(input.speed);
  if ('timeoutSec' in input) patch.timeoutSec = intOrNull(input.timeoutSec, 10, 86400) ?? DEFAULT_LAUNCH_OPTIONS.timeoutSec;
  if ('stopTimeoutSec' in input) patch.stopTimeoutSec = intOrNull(input.stopTimeoutSec, 1, 3600) ?? DEFAULT_STOP_OPTIONS.timeoutSec;

  if ('repo' in input) {
    if (!Array.isArray(input.repo)) return fail('repo must be an array of paths');
    patch.repo = input.repo
      .slice(0, MAX_LIST)
      .map((v) => (typeof v === 'string' ? v.trim().slice(0, MAX_STRING) : ''))
      .filter((v) => v.length > 0);
  }

  if ('windowBounds' in input) {
    const bounds = input.windowBounds;
    if (!isPlainObject(bounds)) return fail('windowBounds must be an object');
    // Window size is cosmetic, so an odd value is clamped rather than rejected.
    const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
      // Number(null) and Number('') are both 0, which is not what "missing" means here.
      if (value === null || value === undefined || value === '') return fallback;
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return fallback;
      return Math.min(Math.max(Math.trunc(parsed), min), max);
    };
    patch.windowBounds = {
      width: clamp(bounds.width, 700, 1600, 1180),
      height: clamp(bounds.height, 480, 1600, 820),
    };
  }

  if ('rememberApiKey' in input) {
    if (typeof input.rememberApiKey !== 'boolean') return fail('rememberApiKey must be a boolean');
    patch.rememberApiKey = input.rememberApiKey;
  }

  return { ok: true, value: patch };
}

export function parseApiKeyInput(input: unknown): ValidationOutcome<{ apiKey: string; remember: boolean }> {
  if (!isPlainObject(input)) return fail('api key payload must be an object');
  const apiKey = str(input.apiKey);
  if (apiKey === null) return fail('apiKey must be a string');
  const remember = input.remember === undefined ? true : input.remember;
  if (typeof remember !== 'boolean') return fail('remember must be a boolean');
  return { ok: true, value: { apiKey: apiKey.slice(0, 4096), remember } };
}

export function parseDirectoryPath(input: unknown): ValidationOutcome<string> {
  if (!isPlainObject(input)) return fail('directory payload must be an object');
  const path = str(input.path);
  if (path === null) return fail('path must be a string');
  if (path.length > MAX_STRING) return fail('path is too long');
  return { ok: true, value: path };
}

/* -------------------------------------------------------------------------- */
/* Shared response shapes                                                     */
/* -------------------------------------------------------------------------- */

export type {
  AgentCraftStatus,
  ApiKeyState,
  ConsoleLine,
  DirectoryCheck,
  OperationState,
  ValidationIssue,
};