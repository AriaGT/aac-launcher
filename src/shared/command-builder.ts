/**
 * Pure command construction for the AgentCraft PowerShell scripts.
 *
 * Nothing here touches the filesystem or spawns anything. The main process is the
 * only place that turns these argument arrays into a `powershell.exe` process.
 *
 * Every flag used here exists in `tools\launch.ps1` / `tools\stop.ps1`; nothing is
 * invented and no string ever comes from the renderer as a raw command.
 */
import {
  type Backend,
  type LaunchOptions,
  type ShowcaseAt,
  type StopOptions,
} from './types';

/** launch.ps1 derives the Foreman profile from the backend unless one is given. */
export function defaultProfileFor(options: LaunchOptions): string {
  if (options.showcase) return options.showcaseAt === 'late' ? 'showcase-late' : 'showcase';
  return options.backend;
}

/** launch.ps1 forces the sim backend whenever a showcase is requested. */
export function effectiveBackend(options: LaunchOptions): Backend {
  return options.showcase ? 'sim' : options.backend;
}

/** launch.ps1 default ports, kept here only to resolve defaults for stop targeting. */
export const DEFAULT_FOREMAN_PORT = 7878;
export const DEFAULT_DEV_PORT = 7879;

export function effectivePort(options: LaunchOptions): number {
  return options.port ?? DEFAULT_FOREMAN_PORT;
}

export function effectiveDevPort(options: LaunchOptions): number {
  return options.devPort ?? DEFAULT_DEV_PORT;
}

/**
 * The profile name launch.ps1 will actually use. An empty -ForemanProfile means
 * "derive from the backend/showcase", so a stop targeting the same profile has to know
 * the derived name rather than the empty string.
 */
export function effectiveProfile(options: LaunchOptions): string {
  const explicit = options.foremanProfile.trim();
  return explicit ? explicit : defaultProfileFor(options);
}

/** launch.ps1's own default for -AgentHome: %USERPROFILE%\.agentcraft. */
export function effectiveAgentHome(options: LaunchOptions, userProfile?: string): string {
  const explicit = options.agentHome.trim();
  if (explicit) return explicit;
  const base = (userProfile ?? process.env.USERPROFILE ?? '').replace(/[\\/]+$/, '');
  return base ? `${base}\\.agentcraft` : '.agentcraft-home';
}

/** Control characters would corrupt a command line, so free text is flattened first. */
export function sanitizeFreeText(value: string, maxLength = 500): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? ' ' : ch;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function pushSwitch(args: string[], on: boolean, flag: string): void {
  if (on) args.push(flag);
}

function pushValue(args: string[], flag: string, value: string | number | null | undefined): void {
  if (value === null || value === undefined) return;
  const text = String(value).trim();
  if (!text) return;
  args.push(flag, text);
}

function pushList(args: string[], flag: string, values: readonly string[]): void {
  // launch.ps1 splits every -Repo value on commas itself, so one joined value is exactly
  // what it expects (`foreach ($part in ($r -split ','))`).
  const joined = values.map((v) => v.trim()).filter(Boolean).join(',');
  if (joined) args.push(flag, joined);
}

/**
 * Arguments passed to `tools\launch.ps1` (without the script path itself).
 * Switches are emitted bare: PowerShell would read a following token as their value.
 */
export function buildLaunchScriptArgs(options: LaunchOptions, summaryJsonPath?: string): string[] {
  const args: string[] = [];

  args.push('-Backend', effectiveBackend(options));
  pushValue(args, '-ForemanProfile', options.foremanProfile);
  pushValue(args, '-Port', options.port);
  pushValue(args, '-DevPort', options.devPort);
  pushValue(args, '-AgentHome', options.agentHome);
  pushValue(args, '-GradleHome', options.gradleHome);
  pushList(args, '-Repo', options.repo);

  if (options.showcase) {
    // `-ShowcaseAt busy|late` alone already turns the showcase on in launch.ps1
    // ($showcaseOn = $Showcase.IsPresent -or [bool]$ShowcaseAt).
    args.push('-ShowcaseAt', options.showcaseAt satisfies ShowcaseAt);
  }

  pushValue(args, '-Goal', sanitizeFreeText(options.goal));
  pushValue(args, '-Speed', options.speed);
  args.push('-TimeoutSec', String(Math.trunc(options.timeoutSec)));
  pushValue(args, '-SummaryJson', summaryJsonPath);

  pushSwitch(args, options.dev, '-Dev');
  pushSwitch(args, options.reset, '-Reset');
  pushSwitch(args, options.autostart, '-Autostart');
  pushSwitch(args, options.useClaudeLogin, '-UseClaudeLogin');
  pushSwitch(args, options.notify, '-Notify');
  pushSwitch(args, options.noNotify, '-NoNotify');
  pushSwitch(args, options.noGame, '-NoGame');
  pushSwitch(args, options.noForeman, '-NoForeman');
  pushSwitch(args, options.noWait, '-NoWait');

  return args;
}

/**
 * Arguments passed to `tools\stop.ps1`.
 *
 * stop.ps1 treats the switches as: nothing given = game + every Foreman this
 * checkout started, `-Game` = game only, `-Foreman` = Foreman only.
 */
export function buildStopScriptArgs(options: StopOptions): string[] {
  const args: string[] = [];

  // Identifiers first so the filtering flags read naturally in the console log.
  pushValue(args, '-ForemanProfile', options.foremanProfile);
  pushValue(args, '-AgentHome', options.agentHome);
  pushValue(args, '-Port', options.port);

  pushSwitch(args, options.game, '-Game');
  pushSwitch(args, options.foreman, '-Foreman');
  pushSwitch(args, options.stopDaemon, '-StopDaemon');

  if (options.timeoutSec !== 30) {
    args.push('-TimeoutSec', String(Math.trunc(options.timeoutSec)));
  }

  return args;
}

/** `powershell.exe` flags used for every invocation. */
export const POWERSHELL_BASE_ARGS: readonly string[] = [
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
];

export function buildPowerShellArgs(scriptPath: string, scriptArgs: readonly string[]): string[] {
  return [...POWERSHELL_BASE_ARGS, scriptPath, ...scriptArgs];
}

export interface PowerShellCommand {
  exe: string;
  args: string[];
  scriptPath: string;
  scriptArgs: string[];
  cwd: string;
}

/** Full `powershell.exe ... -File tools\launch.ps1 ...` invocation. */
export function buildLaunchCommand(params: {
  powershellExe: string;
  scriptPath: string;
  cwd: string;
  options: LaunchOptions;
  summaryJsonPath?: string;
}): PowerShellCommand {
  const scriptArgs = buildLaunchScriptArgs(params.options, params.summaryJsonPath);
  return {
    exe: params.powershellExe,
    args: buildPowerShellArgs(params.scriptPath, scriptArgs),
    scriptPath: params.scriptPath,
    scriptArgs,
    cwd: params.cwd,
  };
}

export function buildStopCommand(params: {
  powershellExe: string;
  scriptPath: string;
  cwd: string;
  options: StopOptions;
}): PowerShellCommand {
  const scriptArgs = buildStopScriptArgs(params.options);
  return {
    exe: params.powershellExe,
    args: buildPowerShellArgs(params.scriptPath, scriptArgs),
    scriptPath: params.scriptPath,
    scriptArgs,
    cwd: params.cwd,
  };
}

/** Quote one argument for display only; never fed back into a shell. */
export function quoteForDisplay(value: string): string {
  if (value === '') return '""';
  if (!/[\s"]/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

export function commandDisplay(exe: string, args: readonly string[]): string {
  const name = exe.split(/[\\/]/).pop() ?? exe;
  return [name, ...args].map(quoteForDisplay).join(' ');
}