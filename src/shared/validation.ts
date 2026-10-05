/**
 * Pure validation for the launcher's own configuration.
 *
 * Every rule here mirrors something `tools\launch.ps1` or `tools\stop.ps1` really does,
 * so the UI can explain a problem before a PowerShell process is ever spawned.
 */
import { PROFILE_NAME_PATTERN, RESERVED_PORTS, type DirectoryCheck, type LaunchOptions, type ValidationIssue } from './types';
import { effectiveBackend } from './command-builder';

export interface FsProbe {
  /** Resolves to the absolute normalised path when the entry exists, else null. */
  stat(target: string): string | null;
  /** Like stat but also reports directories. */
  isDirectory(target: string): boolean;
}

export const REQUIRED_SCRIPTS = ['tools\\launch.ps1', 'tools\\stop.ps1'] as const;

function joinWin(dir: string, relative: string): string {
  const trimmed = dir.replace(/[\\/]+$/, '');
  return `${trimmed}\\${relative}`;
}

export function checkAgentCraftDirectory(directory: string, probe: FsProbe): DirectoryCheck {
  const dir = (directory ?? '').trim();
  if (!dir) {
    return {
      ok: false,
      directory: '',
      resolved: '',
      exists: false,
      isDirectory: false,
      hasLaunchScript: false,
      hasStopScript: false,
      message: 'Choose the AgentCraft folder first.',
    };
  }

  const resolved = probe.stat(dir);
  const isDirectory = probe.isDirectory(dir);
  if (!resolved || !isDirectory) {
    return {
      ok: false,
      directory: dir,
      resolved: resolved ?? '',
      exists: Boolean(resolved),
      isDirectory,
      hasLaunchScript: false,
      hasStopScript: false,
      message: `Not a folder: ${dir}`,
    };
  }

  const launchPath = joinWin(resolved, 'tools\\launch.ps1');
  const stopPath = joinWin(resolved, 'tools\\stop.ps1');
  const hasLaunchScript = Boolean(probe.stat(launchPath));
  const hasStopScript = Boolean(probe.stat(stopPath));

  if (!hasLaunchScript || !hasStopScript) {
    const missing = [!hasLaunchScript ? 'tools\\launch.ps1' : '', !hasStopScript ? 'tools\\stop.ps1' : '']
      .filter(Boolean)
      .join(' and ');
    return {
      ok: false,
      directory: dir,
      resolved,
      exists: true,
      isDirectory: true,
      hasLaunchScript,
      hasStopScript,
      message: `Not an AgentCraft checkout: ${missing} missing.`,
    };
  }

  return {
    ok: true,
    directory: dir,
    resolved,
    exists: true,
    isDirectory: true,
    hasLaunchScript: true,
    hasStopScript: true,
    message: 'AgentCraft detected',
  };
}

/* -------------------------------------------------------------------------- */
/* API key                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Anthropic console keys look like `sk-ant-api03-...`. This is a shape check only:
 * it never proves the key works, which is what `validateApiKey` (main process) is for.
 */
export function looksLikeAnthropicApiKey(value: string): boolean {
  const key = (value ?? '').trim();
  if (!key) return false;
  if (key.length < 24) return false;
  if (!key.startsWith('sk-ant-')) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(key)) return false;
  return true;
}

/** Never reveal more than the prefix and last four characters. */
export function apiKeyHint(value: string): string {
  const key = (value ?? '').trim();
  if (!key) return '';
  if (key.length <= 12) return `${key.slice(0, 4)}${'*'.repeat(Math.max(0, key.length - 4))}`;
  return `${key.slice(0, 8)}${'*'.repeat(8)}${key.slice(-4)}`;
}

/* -------------------------------------------------------------------------- */
/* Launch options                                                              */
/* -------------------------------------------------------------------------- */

export interface OptionValidationContext {
  /** Checks whether a -Repo path looks like a git work tree root. */
  isGitRepo?(path: string): boolean;
  /** Effective profile name launch.ps1 will use (used for reset stop targeting). */
  resolvedProfile?: string;
}

function issue(field: string, severity: 'error' | 'warning', message: string): ValidationIssue {
  return { field, severity, message };
}

export function validatePorts(port: number | null, devPort: number | null): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const ports: Array<[string, number | null]> = [
    ['port', port],
    ['devPort', devPort],
  ];
  for (const [field, value] of ports) {
    if (value === null) continue;
    if (!Number.isInteger(value) || value < 1024 || value > 65535) {
      issues.push(issue(field, 'error', 'Use a port between 1024 and 65535.'));
      continue;
    }
    if (RESERVED_PORTS.includes(value)) {
      issues.push(issue(field, 'error', `Port ${value} is reserved for other dev servers (launch.ps1 rejects it).`));
    }
  }
  if (port !== null && devPort !== null && port === devPort) {
    issues.push(issue('port', 'error', 'Foreman port and DevBridge port must be different.'));
  }
  return issues;
}

export function validateLaunchOptions(
  options: LaunchOptions,
  context: OptionValidationContext = {},
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const backend = effectiveBackend(options);

  issues.push(...validatePorts(options.port, options.devPort));

  if (options.foremanProfile && !PROFILE_NAME_PATTERN.test(options.foremanProfile)) {
    issues.push(
      issue('foremanProfile', 'error', 'Letters, digits, "-" and "_" only (launch.ps1 names the profile from it).'),
    );
  }

  if (options.showcase && options.backend !== 'sim') {
    issues.push(
      issue(
        'showcase',
        'error',
        'The showcase holds a scripted state, so it only runs on the sim backend (launch.ps1 forces it).',
      ),
    );
  }

  if (options.notify && options.noNotify) {
    issues.push(issue('noNotify', 'warning', '-NoNotify wins in launch.ps1, so -Notify has no effect.'));
  }

  if (options.dev && options.notify && !options.noNotify) {
    issues.push(issue('dev', 'warning', '-Dev already disables agent toasts, so -Notify has no effect.'));
  }

  if (options.useClaudeLogin && backend === 'sim') {
    issues.push(
      issue('useClaudeLogin', 'warning', 'The sim backend never calls Claude, so your claude.ai login is unused.'),
    );
  }

  if (options.noGame && options.noForeman) {
    issues.push(issue('noGame', 'warning', 'With -NoGame and -NoForeman there is nothing to start.'));
  }

  if (options.noForeman && options.reset) {
    issues.push(issue('reset', 'warning', '-Reset only reaches the Foreman, which -NoForeman skips.'));
  }

  if (options.speed !== null) {
    if (!Number.isFinite(options.speed) || options.speed <= 0) {
      issues.push(issue('speed', 'error', 'Speed must be a positive number.'));
    }
  }

  if (!Number.isInteger(options.timeoutSec) || options.timeoutSec < 10) {
    issues.push(issue('timeoutSec', 'error', 'Timeout must be at least 10 seconds.'));
  }

  if (options.repo.length) {
    const probe = context.isGitRepo;
    for (const entry of options.repo) {
      for (const raw of entry.split(',')) {
        const path = raw.trim();
        if (!path) continue;
        if (!probe) continue;
        if (!probe(path)) {
          issues.push(issue('repo', 'error', `${path} is not a git repository root (launch.ps1 rejects it).`));
        }
      }
    }
  }

  if (options.agentHome.trim() && !/^[A-Za-z]:[\\/]/.test(options.agentHome.trim())) {
    issues.push(issue('agentHome', 'warning', 'Use an absolute path for the agent home folder.'));
  }

  return issues;
}

export function hasErrors(issues: readonly ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}

/* -------------------------------------------------------------------------- */
/* Operation planning (the Reset flow)                                         */
/* -------------------------------------------------------------------------- */

export interface OperationPlan {
  steps: Array<{ kind: 'stop' | 'launch'; label: string }>;
  notes: string[];
}

/**
 * `launch.ps1 -Reset` is ignored while a Foreman is already running for the profile
 * (it prints "-Reset ignored for a running Foreman"), so a real reset has to stop the
 * Foreman first and only then relaunch with -Reset.
 */
export function planReset(
  options: LaunchOptions,
  current: { foremanRunning: boolean; gameRunning: boolean },
  resolvedProfile: string,
): OperationPlan {
  const steps: OperationPlan['steps'] = [];
  const notes: string[] = [];

  if (current.foremanRunning) {
    steps.push({ kind: 'stop', label: `Stop Foreman '${resolvedProfile}' (reset is ignored on a live Foreman)` });
  }
  steps.push({ kind: 'launch', label: `Start with -Reset (backend ${effectiveBackend(options)}, profile ${resolvedProfile})` });

  if (!current.foremanRunning) {
    notes.push('No live Foreman found, so -Reset will apply on a fresh start.');
  }
  if (current.gameRunning) {
    notes.push('Minecraft keeps running; launch.ps1 reuses the client that is already up.');
  }

  return { steps, notes };
}

export interface RestartPlan extends OperationPlan {}

/** Restart = stop everything this checkout started, then launch again. */
export function planRestart(
  options: LaunchOptions,
  current: { foremanRunning: boolean; gameRunning: boolean },
  resolvedProfile: string,
): RestartPlan {
  const steps: OperationPlan['steps'] = [];
  const notes: string[] = [];

  if (current.foremanRunning || current.gameRunning) {
    steps.push({ kind: 'stop', label: 'Stop game and Foreman (tools\\stop.ps1)' });
  } else {
    notes.push('Nothing is running, so this is a plain start.');
  }
  steps.push({ kind: 'launch', label: `Start (backend ${effectiveBackend(options)}, profile ${resolvedProfile})` });

  return { steps, notes };
}