/**
 * The operation controller: the only place that runs launch.ps1 / stop.ps1.
 *
 * Every operation is serialized. The renderer may start the game, reset, restart or
 * stop at any time, but exactly one script runs at a time and a second request made
 * while one is in flight is rejected with a clear message rather than interleaved.
 */
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import {
  buildLaunchCommand,
  buildStopCommand,
  commandDisplay,
  effectiveAgentHome,
  effectiveProfile,
  type PowerShellCommand,
} from '../shared/command-builder';
import { DEFAULT_LAUNCH_OPTIONS, type LaunchOptions, type OperationKind, type StopOptions } from '../shared/types';
import type { ActionResult, StartRequest } from '../shared/ipc';
import { redact } from '../shared/redact';
import { resolvePowerShell, runPowerShell, type RunResult } from './powershell';
import type { ConsoleSink, StatusSink } from './status-service';

export interface ControllerDeps {
  agentcraftDir: () => string;
  /** Mirrors the current launch options so a stop can target what a start created. */
  launchOptions: () => LaunchOptions;
  console: ConsoleSink;
  status: StatusSink;
  apiKey: () => string | null;
}

export class AgentCraftController {
  private tail: Promise<unknown> = Promise.resolve();
  private running = false;
  private activeKind: OperationKind | null = null;

  /** Set by ipc.ts whenever the settings change. */
  private options: LaunchOptions = { ...DEFAULT_LAUNCH_OPTIONS };

  constructor(private readonly deps: ControllerDeps) {}

  setOptions(next: LaunchOptions): void {
    this.options = next;
  }

  get busy(): boolean {
    return this.running;
  }

  get currentKind(): OperationKind | null {
    return this.activeKind;
  }

  /* ---------------------------------------------------------------------- */
  /* Public operations                                                      */
  /* ---------------------------------------------------------------------- */

  start(request: StartRequest): Promise<ActionResult> {
    return this.enqueue('start', () => this.doStart(request, false));
  }

  restart(request: StartRequest): Promise<ActionResult> {
    return this.enqueue('restart', async () => {
      const stopped = await this.doStop(this.defaultStop(), true);
      if (!stopped.ok && !this.nothingRunning()) return stopped;
      return this.doStart(request, true);
    });
  }

  /**
   * `launch.ps1 -Reset` is ignored while a Foreman is already alive, so the Foreman is
   * stopped first and only then is the launch issued with -Reset.
   */
  reset(request: StartRequest): Promise<ActionResult> {
    return this.enqueue('reset', async () => {
      const stopped = await this.doStop(
        { ...this.defaultStop(), foreman: true, game: true, foremanProfile: effectiveProfile(request.options) },
        true,
      );
      if (!stopped.ok) return stopped;
      return this.doStart({ ...request, options: { ...request.options, reset: true } }, true);
    });
  }

  stopAll(overrides: Partial<StopOptions> = {}): Promise<ActionResult> {
    return this.enqueue('stop', () => this.doStop(this.defaultStop(overrides), true));
  }

  stopForeman(overrides: Partial<StopOptions> = {}): Promise<ActionResult> {
    return this.enqueue('stop', () =>
      this.doStop({ ...this.defaultStop(overrides), foreman: true, game: false }, true),
    );
  }

  stopGame(overrides: Partial<StopOptions> = {}): Promise<ActionResult> {
    return this.enqueue('stop', () =>
      this.doStop({ ...this.defaultStop(overrides), game: true, foreman: false }, true),
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Queue                                                                  */
  /* ---------------------------------------------------------------------- */

  private enqueue<T>(kind: OperationKind, task: () => Promise<T>): Promise<T> {
    if (this.running) {
      return Promise.reject(new Error(`A "${this.activeKind}" operation is already running.`));
    }
    this.running = true;
    this.activeKind = kind;
    this.deps.status.setOperation({
      kind,
      progress: null,
      startedAt: Date.now(),
      message: kind === 'stop' ? 'stopping…' : `${kind} in progress…`,
    });

    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );

    return result.finally(() => {
      this.running = false;
      this.activeKind = null;
      this.deps.status.setOperation(null);
      void this.deps.status.refreshNow();
    }) as Promise<T>;
  }

  /* ---------------------------------------------------------------------- */
  /* Stop targeting                                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * A stop must name the same profile and agent home the launch used, otherwise
   * stop.ps1 cannot match the Foreman it started.
   */
  private defaultStop(overrides: Partial<StopOptions> = {}): StopOptions {
    return {
      game: true,
      foreman: true,
      stopDaemon: false,
      foremanProfile: effectiveProfile(this.options),
      agentHome: effectiveAgentHome(this.options),
      port: this.options.port,
      timeoutSec: 30,
      ...overrides,
    };
  }

  private nothingRunning(): boolean {
    const status = this.deps.status.snapshot();
    return !status.game?.running && !status.foremen.some((f) => f.alive);
  }

  /* ---------------------------------------------------------------------- */
  /* Launch                                                                  */
  /* ---------------------------------------------------------------------- */

  private async doStart(request: StartRequest, alreadyStopped: boolean): Promise<ActionResult> {
    const options = request.options;
    const root = this.deps.agentcraftDir();
    if (!root) return { ok: false, message: 'No AgentCraft folder selected.', summary: null };

    const summaryPath = path.join(
      app.getPath('temp'),
      `agentcraft-summary-${process.pid}-${Date.now()}.json`,
    );
    const command = buildLaunchCommand({
      powershellExe: powershellExe(),
      scriptPath: path.join(root, 'tools', 'launch.ps1'),
      cwd: root,
      options,
      summaryJsonPath: summaryPath,
    });

    this.deps.console.append('', 'command', `${alreadyStopped ? 'Start' : 'Launch'}: ${commandDisplay(command.exe, command.args)}`);

    // launch.ps1 blocks until Minecraft is ready or -TimeoutSec elapses, so the child
    // budget is the script timeout plus room for the Gradle build itself.
    const result = await this.execute(command, options.timeoutSec * 1000 + 180_000);
    const summary = readSummary(summaryPath);

    if (result.spawnError) {
      return { ok: false, message: `Could not start PowerShell: ${result.spawnError.message}`, summary: null };
    }
    if (result.timedOut) {
      return {
        ok: false,
        message: `launch.ps1 did not finish within ${options.timeoutSec}s. The Foreman log has the detail.`,
        summary,
      };
    }
    if (result.code !== 0) {
      return {
        ok: false,
        message: `launch.ps1 exited with code ${result.code}. The console above explains why.`,
        summary,
      };
    }
    return { ok: true, message: 'AgentCraft launched.', summary };
  }

  /* ---------------------------------------------------------------------- */
  /* Stop                                                                    */
  /* ---------------------------------------------------------------------- */

  private async doStop(stop: StopOptions, quietWhenIdle: boolean): Promise<ActionResult> {
    const root = this.deps.agentcraftDir();
    if (!root) return { ok: false, message: 'No AgentCraft folder selected.', summary: null };

    const command = buildStopCommand({
      powershellExe: powershellExe(),
      scriptPath: path.join(root, 'tools', 'stop.ps1'),
      cwd: root,
      options: stop,
    });

    this.deps.console.append('', 'command', `Stop (${stopLabel(stop)}): ${commandDisplay(command.exe, command.args)}`);

    const result = await this.execute(command, stop.timeoutSec * 1000 + 60_000);

    if (result.spawnError) {
      return { ok: false, message: `Could not start PowerShell: ${result.spawnError.message}`, summary: null };
    }
    if (result.timedOut) {
      return { ok: false, message: `stop.ps1 did not finish within ${stop.timeoutSec}s.`, summary: null };
    }
    if (result.code !== 0) {
      return { ok: false, message: `stop.ps1 exited with code ${result.code}.`, summary: null };
    }
    // Nothing was running is still a successful stop.
    if (quietWhenIdle && this.nothingRunning()) {
      return { ok: true, message: 'Nothing was running for this checkout.', summary: null };
    }
    return { ok: true, message: `Stopped ${stopLabel(stop)}.`, summary: null };
  }

  /* ---------------------------------------------------------------------- */
  /* Execution                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * The only place a PowerShell child is spawned for an operation. The API key is
   * passed exclusively through the child's environment, never on the command line, and
   * every captured line is redacted before it reaches the console.
   */
  private execute(command: PowerShellCommand, timeoutMs: number): Promise<RunResult> {
    const key = this.deps.apiKey();
    const secrets = key ? [key] : [];
    return runPowerShell(command, {
      timeoutMs,
      onStdout: (line) => this.deps.console.append(line, 'stdout', redact(line, { secrets })),
      onStderr: (line) => this.deps.console.append(line, 'stderr', redact(line, { secrets })),
      env: key ? { ANTHROPIC_API_KEY: key } : {},
    });
  }
}

function stopLabel(stop: StopOptions): string {
  if (stop.game && stop.foreman) return 'game + Foreman';
  if (stop.foreman) return 'Foreman';
  if (stop.game) return 'game';
  return 'nothing selected';
}

/** launch.ps1 writes -SummaryJson; read it once and clean it up. */
function readSummary(summaryPath: string): unknown | null {
  try {
    const raw = fs.readFileSync(summaryPath, 'utf8');
    fs.rmSync(summaryPath, { force: true });
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function powershellExe(): string {
  const resolved = resolvePowerShell();
  if ('error' in resolved) throw new Error(resolved.error);
  return resolved.exe;
}