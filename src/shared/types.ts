/**
 * Types shared by the main process, the preload bridge and the renderer.
 * Nothing in this file imports Electron or Node APIs.
 */

export type Backend = 'sim' | 'claude';
export type ShowcaseAt = 'busy' | 'late';

export const BACKENDS: readonly Backend[] = ['sim', 'claude'];
export const SHOWCASE_STATES: readonly ShowcaseAt[] = ['busy', 'late'];

/** Ports launch.ps1 refuses because other dev servers use them. */
export const RESERVED_PORTS: readonly number[] = [3000, 5173, 8080];

/** launch.ps1: `if ($ForemanProfile -notmatch '^[A-Za-z0-9_-]+$')`. */
export const PROFILE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/** The subset of `tools\launch.ps1` parameters the launcher exposes. */
export interface LaunchOptions {
  backend: Backend;
  /** '' means "let launch.ps1 derive it from the backend/showcase". */
  foremanProfile: string;
  port: number | null;
  devPort: number | null;
  dev: boolean;
  reset: boolean;
  showcase: boolean;
  showcaseAt: ShowcaseAt;
  agentHome: string;
  gradleHome: string;
  repo: string[];
  speed: number | null;
  autostart: boolean;
  goal: string;
  useClaudeLogin: boolean;
  notify: boolean;
  noNotify: boolean;
  noGame: boolean;
  noForeman: boolean;
  noWait: boolean;
  timeoutSec: number;
}

/** The subset of `tools\stop.ps1` parameters the launcher exposes. */
export interface StopOptions {
  game: boolean;
  foreman: boolean;
  stopDaemon: boolean;
  foremanProfile: string;
  agentHome: string;
  port: number | null;
  timeoutSec: number;
}

export const DEFAULT_LAUNCH_OPTIONS: LaunchOptions = {
  backend: 'sim',
  foremanProfile: '',
  port: null,
  devPort: null,
  dev: false,
  reset: false,
  showcase: false,
  showcaseAt: 'busy',
  agentHome: '',
  gradleHome: '',
  repo: [],
  speed: null,
  autostart: false,
  goal: '',
  useClaudeLogin: false,
  notify: false,
  noNotify: false,
  noGame: false,
  noForeman: false,
  noWait: false,
  timeoutSec: 600,
};

export const DEFAULT_STOP_OPTIONS: StopOptions = {
  game: false,
  foreman: false,
  stopDaemon: false,
  foremanProfile: '',
  agentHome: '',
  port: null,
  timeoutSec: 30,
};

/* -------------------------------------------------------------------------- */
/* Directory detection                                                         */
/* -------------------------------------------------------------------------- */

export interface DirectoryCheck {
  ok: boolean;
  directory: string;
  /** Absolute, normalised path (as reported by the probe), or '' when missing. */
  resolved: string;
  exists: boolean;
  isDirectory: boolean;
  hasLaunchScript: boolean;
  hasStopScript: boolean;
  message: string;
}

/* -------------------------------------------------------------------------- */
/* API key                                                                     */
/* -------------------------------------------------------------------------- */

export type ApiKeyStatus = 'empty' | 'configured' | 'validated' | 'invalid' | 'unavailable';

export interface ApiKeyState {
  /** Never the key itself: only whether one is held and its last known verdict. */
  status: ApiKeyStatus;
  /** Masked preview such as `sk-ant-…4f2a`, or '' when unset. */
  hint: string;
  remember: boolean;
  /** True when Electron's safeStorage (DPAPI on Windows) can encrypt it. */
  canPersist: boolean;
  validatedAt: number | null;
  message: string;
}

/* -------------------------------------------------------------------------- */
/* Run state                                                                   */
/* -------------------------------------------------------------------------- */

export type RunPhase = 'idle' | 'starting' | 'running' | 'stopping' | 'error';

export type OperationKind = 'start' | 'restart' | 'reset' | 'stop';

export interface OperationState {
  kind: OperationKind;
  /** 0..1 for long operations; null when indeterminate. */
  progress: number | null;
  startedAt: number;
  message: string;
}

/** Authentication verdict reported by the Foreman itself. */
export type AuthState = 'ok' | 'failed' | 'unknown';

/** What the Foreman reported about the Minecraft server it drives. */
export interface McWorldSummary {
  address: string | null;
  online: boolean | null;
  mode: string | null;
  level: string | null;
  phase: string | null;
  players: string[];
}

export interface ForemanStatus {
  profile: string;
  pid: number;
  port: number | null;
  backend: string | null;
  home: string | null;
  startTime: string;
  /** The process still exists with the recorded start time (PID + start-time match). */
  alive: boolean;
  /** Test-NetConnection succeeded on `port`. */
  portOpen: boolean;
  /** A run file written by launch.ps1 exists, so stop.ps1 can stop it. */
  ownedByLauncher: boolean;
  auth: AuthState | null;
  authMessage: string | null;
  /** Which models the Foreman is driving, e.g. "Claude (lead opus, workers sonnet)". */
  model: string | null;
  /** The signed-in account, e.g. "… · Claude Pro". */
  account: string | null;
  /** Session spend reported by the Foreman, in USD. */
  costUsd: number | null;
  agents: number | null;
  activeAgents: number | null;
  tasks: number | null;
  openDecisions: number | null;
  showcase: boolean;
}

export interface GameStatus {
  running: boolean;
  gamePid: number | null;
  gradlePid: number | null;
  wrapperPid: number | null;
  devPort: number | null;
  foremanPort: number | null;
  /** launch.ps1 marked the client as connected to the Foreman. */
  ready: boolean;
  /** Deep state from tools\devcli.mjs; null until a deep probe succeeds. */
  world: McWorldSummary | null;
}

export interface AgentCraftStatus {
  agentcraftDir: string;
  /** The directory is an AgentCraft checkout. */
  valid: boolean;
  reason: string | null;
  /**
   * One entry per Foreman this machine is running for the selected checkout, whether
   * launch.ps1 started it or it was already up. Multiple profiles can coexist, so this
   * is a list rather than a single object.
   */
  foremen: ForemanStatus[];
  /** null when Minecraft is not running. */
  game: GameStatus | null;
  /**
   * PID of a Minecraft JVM belonging to this checkout that launch.ps1 did not start.
   * stop.ps1 can end it with -Game; the launcher warns before doing so.
   */
  strayGamePid: number | null;
  lastCheckAt: number;
  checking: boolean;
}

export const EMPTY_GAME_STATUS: GameStatus = {
  running: false,
  gamePid: null,
  gradlePid: null,
  wrapperPid: null,
  devPort: null,
  foremanPort: null,
  ready: false,
  world: null,
};

export const EMPTY_STATUS: AgentCraftStatus = {
  agentcraftDir: '',
  valid: false,
  reason: null,
  foremen: [],
  game: null,
  strayGamePid: null,
  lastCheckAt: 0,
  checking: false,
};

/** true when at least one Foreman process is alive. */
export function anyForemanRunning(status: AgentCraftStatus): boolean {
  return status.foremen.some((f) => f.alive);
}

/** The Foreman matching the effective profile, if any. */
export function foremanForProfile(
  status: AgentCraftStatus,
  profile: string,
): ForemanStatus | null {
  return status.foremen.find((f) => f.profile === profile && f.alive) ?? null;
}

/* -------------------------------------------------------------------------- */
/* Console                                                                     */
/* -------------------------------------------------------------------------- */

export type ConsoleStream = 'command' | 'stdout' | 'stderr' | 'system' | 'result';

export interface ConsoleLine {
  id: number;
  stream: ConsoleStream;
  text: string;
  at: number;
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

export type IssueSeverity = 'error' | 'warning';

export interface ValidationIssue {
  field: string;
  severity: IssueSeverity;
  message: string;
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

export interface AppSettings {
  agentcraftDir: string;
  options: LaunchOptions;
  stop: StopOptions;
  windowBounds: { width: number; height: number } | null;
}