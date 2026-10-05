/**
 * Status service: owns the in-app console ring buffer and the AgentCraft status.
 *
 * Cheap probe (`resources/probe.ps1`) every POLL_INTERVAL_MS while the window is
 * visible; deep probe (AgentCraft's own foremancli / devcli) every DEEP_INTERVAL_MS.
 * Both are skipped while an operation is running, because the operation itself already
 * reports progress.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkAgentCraftDirectory } from '../shared/validation';
import type {
  AgentCraftStatus,
  ConsoleLine,
  ForemanStatus,
  GameStatus,
  LaunchOptions,
  McWorldSummary,
  OperationState,
} from '../shared/types';
import { effectiveAgentHome, effectiveProfile, type PowerShellCommand } from '../shared/command-builder';
import { redact } from '../shared/redact';
import { runNode, runPowerShell, resolveNode } from './powershell';
import { createFsProbe } from './fs-probe';

const MAX_LINES = 3000;
const POLL_INTERVAL_MS = 2500;
const DEEP_INTERVAL_MS = 15_000;
const PROBE_TIMEOUT_MS = 20_000;
const DEEP_TIMEOUT_MS = 25_000;

export interface ConsoleSink {
  /** `text` is the redacted form shown to the user; `raw` is what the script printed. */
  append(raw: string, stream: ConsoleLine['stream'], text?: string): void;
  system(text: string): void;
  read(): { lines: ConsoleLine[]; truncated: boolean };
  clear(): void;
}

export interface StatusSink {
  snapshot(): AgentCraftStatus;
  setOperation(operation: OperationState | null): void;
  refreshNow(): Promise<void>;
}

interface ProbeForeman {
  profile: string;
  pid: number;
  port: number | null;
  backend: string | null;
  home: string | null;
  startTime: string;
  alive: boolean;
  portOpen: boolean;
  owned: boolean;
}

interface ProbeGame {
  running: boolean;
  gamePid: number | null;
  gradlePid: number | null;
  wrapperPid: number | null;
  devPort: number | null;
  foremanPort: number | null;
  ready: boolean;
}

interface ProbeResult {
  ok: boolean;
  error: string | null;
  root?: string;
  logsDir?: string | null;
  runDir?: string | null;
  foremen?: ProbeForeman[];
  game?: ProbeGame | null;
  strayGame?: number | null;
  liveProfile?: { profile: string; pid: number; port: number | null; backend: string | null; home: string } | null;
}

export interface StatusServiceDeps {
  agentcraftDir: () => string;
  launchOptions: () => LaunchOptions;
  apiKey: () => string | null;
  isBusy: () => boolean;
}

export class StatusService implements ConsoleSink, StatusSink {
  private lines: ConsoleLine[] = [];
  private dropped = 0;
  private seq = 0;

  private status: AgentCraftStatus = {
    agentcraftDir: '',
    valid: false,
    reason: null,
    foremen: [],
    game: null,
    strayGamePid: null,
    lastCheckAt: 0,
    checking: false,
  };

  private timer: NodeJS.Timeout | null = null;
  private deepTimer: NodeJS.Timeout | null = null;
  private probeInFlight = false;
  private deepInFlight = false;

  constructor(
    private readonly deps: StatusServiceDeps,
    private readonly emit: (channel: string, payload: unknown) => void,
  ) {}

  /* ------------------------------------------------------------------ */
  /* Console                                                             */
  /* ------------------------------------------------------------------ */

  append(raw: string, stream: ConsoleLine['stream'], text?: string): void {
    const line: ConsoleLine = {
      id: ++this.seq,
      at: Date.now(),
      stream,
      text: text ?? redact(raw),
    };
    this.lines.push(line);
    if (this.lines.length > MAX_LINES) {
      const overflow = this.lines.length - MAX_LINES;
      this.lines.splice(0, overflow);
      this.dropped += overflow;
    }
    this.emit('event:console', line);
  }

  system(text: string): void {
    this.append(text, 'system', text);
  }

  read(): { lines: ConsoleLine[]; truncated: boolean } {
    return { lines: [...this.lines], truncated: this.dropped > 0 };
  }

  clear(): void {
    this.lines = [];
    this.dropped = 0;
    this.emit('event:console-clear', null);
  }

  /* ------------------------------------------------------------------ */
  /* Status                                                              */
  /* ------------------------------------------------------------------ */

  snapshot(): AgentCraftStatus {
    return { ...this.status, foremen: [...this.status.foremen] };
  }

  setOperation(operation: OperationState | null): void {
    this.emit('event:operation', operation);
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => void this.probe(), POLL_INTERVAL_MS);
    this.deepTimer = setInterval(() => void this.deepProbe(), DEEP_INTERVAL_MS);
    void this.probe();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.deepTimer) clearInterval(this.deepTimer);
    this.timer = null;
    this.deepTimer = null;
  }

  /** Suspend polling while the window is hidden and no operation is in flight. */
  setVisible(visible: boolean): void {
    if (visible) void this.refreshNow();
  }

  async refreshNow(): Promise<void> {
    await this.probe();
    void this.deepProbe();
  }

  /* ------------------------------------------------------------------ */
  /* Cheap probe                                                         */
  /* ------------------------------------------------------------------ */

  async probe(): Promise<void> {
    if (this.probeInFlight) return;
    this.probeInFlight = true;
    this.status.checking = true;
    this.emit('event:status', this.snapshot());

    const root = this.deps.agentcraftDir();
    try {
      if (!root) {
        this.status = { ...this.status, agentcraftDir: '', valid: false, reason: 'No AgentCraft directory selected.' };
        return;
      }

      const probe = createFsProbe();
      const dirCheck = checkAgentCraftDirectory(root, probe);
      if (!dirCheck.ok) {
        this.status = {
          ...this.status,
          agentcraftDir: root,
          valid: false,
          reason: dirCheck.message,
        };
        return;
      }

      const options = this.deps.launchOptions();
      const out = path.join(os.tmpdir(), `agentcraft-probe-${process.pid}.json`);
      const command: PowerShellCommand = {
        exe: powershellExeOrThrow(),
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          probeScriptPath(),
          '-Root',
          root,
          '-Out',
          out,
          '-Profile',
          effectiveProfile(options),
          '-AgentHomePath',
          effectiveAgentHome(options),
        ],
        scriptPath: probeScriptPath(),
        scriptArgs: [],
        cwd: root,
      };

      const secrets = [this.deps.apiKey() ?? ''];
      const result = await runPowerShell(command, {
        timeoutMs: PROBE_TIMEOUT_MS,
        // A probe that fails is worth showing, but a silent success stays silent.
        onStderr: (line) => this.append(line, 'stderr', redact(line, { secrets })),
      });

      if (result.timedOut || result.spawnError || result.code !== 0) {
        this.status = {
          ...this.status,
          agentcraftDir: root,
          valid: true,
          lastCheckAt: Date.now(),
          checking: false,
          reason: result.timedOut ? 'Status probe timed out.' : null,
        };
        return;
      }

      const raw = fs.readFileSync(out, 'utf8');
      fs.rmSync(out, { force: true });
      const parsed = JSON.parse(raw) as ProbeResult;
      this.applyProbe(parsed, root);
    } catch (error) {
      this.status = {
        ...this.status,
        valid: false,
        reason: (error as Error).message,
        lastCheckAt: Date.now(),
        checking: false,
      };
    } finally {
      this.status.checking = false;
      // Must be cleared here: every early return above (no directory, bad directory,
      // probe failure) still passes through this block. Leaving the latch set made the
      // very first probe permanent, so status froze at whatever it saw at startup and
      // neither polling nor picking a folder afterwards ever updated the UI again.
      this.probeInFlight = false;
      this.emit('event:status', this.snapshot());
    }
  }

  private applyProbe(parsed: ProbeResult, root: string): void {
    // Keep the deep-probe fields across cheap polls; only the cheap fields change.
    const previous = new Map(this.status.foremen.map((f) => [f.pid, f]));
    const previousGame = this.status.game;
    const foremen: ForemanStatus[] = (parsed.foremen ?? []).map((entry) => {
      const before = previous.get(entry.pid);
      return {
        profile: entry.profile,
        pid: entry.pid,
        port: entry.port,
        backend: entry.backend,
        home: entry.home,
        startTime: entry.startTime,
        alive: entry.alive,
        portOpen: entry.portOpen,
        ownedByLauncher: entry.owned,
        auth: before?.auth ?? null,
        authMessage: before?.authMessage ?? null,
        model: before?.model ?? null,
        account: before?.account ?? null,
        costUsd: before?.costUsd ?? null,
        agents: before?.agents ?? null,
        activeAgents: before?.activeAgents ?? null,
        tasks: before?.tasks ?? null,
        openDecisions: before?.openDecisions ?? null,
        showcase: before?.showcase ?? false,
      };
    });

    const game: GameStatus | null = parsed.game
      ? {
          running: true,
          gamePid: parsed.game.gamePid,
          gradlePid: parsed.game.gradlePid,
          wrapperPid: parsed.game.wrapperPid,
          devPort: parsed.game.devPort,
          foremanPort: parsed.game.foremanPort,
          ready: parsed.game.ready,
          world: this.status.game?.world ?? null,
        }
      : null;

    this.status = {
      agentcraftDir: root,
      valid: parsed.ok,
      reason: parsed.error,
      foremen,
      game,
      strayGamePid: parsed.strayGame ?? null,
      lastCheckAt: Date.now(),
      checking: false,
    };

    // Announce live-set changes. Without this the console stayed completely silent
    // whenever a probe succeeded, so a Foreman that came up or died between polls was
    // only visible as a silent number changing in the status panel.
    const nowAlive = foremen.filter((f) => f.alive);
    const beforeAlive = [...previous.values()].filter((f) => f.alive);
    const appeared = nowAlive.filter((f) => !beforeAlive.some((b) => b.pid === f.pid));
    const vanished = beforeAlive.filter((b) => !nowAlive.some((f) => f.pid === b.pid));
    for (const f of appeared) {
      this.system(
        `Foreman detected: profile ${f.profile}, pid ${f.pid}, port ${f.port ?? '?'}, backend ${f.backend}` +
          (f.ownedByLauncher ? '' : ' (not started by this launcher)'),
      );
    }
    for (const f of vanished) {
      this.system(`Foreman gone: profile ${f.profile}, pid ${f.pid}`);
    }
    if (game && !previousGame) {
      this.system(`Minecraft detected: pid ${game.gamePid}, devbridge port ${game.devPort ?? '?'}`);
    } else if (!game && previousGame) {
      this.system(`Minecraft stopped: pid ${previousGame.gamePid}`);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Deep probe                                                          */
  /* ------------------------------------------------------------------ */

  async deepProbe(): Promise<void> {
    if (this.deepInFlight || this.deps.isBusy()) return;
    const root = this.deps.agentcraftDir();
    if (!root || !this.status.valid) return;

    const gameUp = this.status.game?.running ?? false;
    const foremanUp = this.status.foremen.some((f) => f.alive && f.portOpen);
    if (!gameUp && !foremanUp) return;

    const nodeExe = resolveNode();
    if (!nodeExe) {
      this.system('Node.js was not found on PATH; deep status is unavailable.');
      return;
    }
    this.deepInFlight = true;

    const secrets = [this.deps.apiKey() ?? ''];

    try {
      for (const foreman of this.status.foremen) {
        if (!foreman.alive || !foreman.port) continue;
        const tool = path.join(root, 'tools', 'foremancli.mjs');
        if (!fs.existsSync(tool)) continue;
        const result = await runNode(
          nodeExe,
          tool,
          ['status', '--port', String(foreman.port), '--timeout', '20'],
          root,
          DEEP_TIMEOUT_MS,
        );
        if (!result.ok) continue;
        const parsed = parseForemanStatus(result.stdout);
        if (!parsed) continue;
        const target = this.status.foremen.find((f) => f.pid === foreman.pid);
        if (target) {
          const authenticated = parsed.auth?.authenticated;
          target.auth = authenticated === true ? 'ok' : authenticated === false ? 'failed' : 'unknown';
          target.authMessage = parsed.auth?.detail ?? parsed.auth?.authLabel ?? null;
          target.model = parsed.model;
          target.account = parsed.account;
          target.costUsd = parsed.costUsd;
          target.agents = parsed.counts?.agents ?? target.agents;
          target.activeAgents = parsed.counts?.activeAgents ?? target.activeAgents;
          target.tasks = parsed.counts?.tasks ?? target.tasks;
          target.openDecisions = parsed.counts?.openDecisions ?? target.openDecisions;
          target.showcase = parsed.counts?.showcase ?? target.showcase;
        }
      }

      if (gameUp && this.status.game?.devPort) {
        const tool = path.join(root, 'tools', 'devcli.mjs');
        if (fs.existsSync(tool)) {
          const result = await runNode(
            nodeExe,
            tool,
            ['state', '--port', String(this.status.game.devPort)],
            root,
            DEEP_TIMEOUT_MS,
          );
          if (result.ok) {
            const world = parseGameState(result.stdout);
            if (world && this.status.game) this.status.game.world = world;
          }
        }
      }

      this.emit('event:status', this.snapshot());
    } catch (error) {
      this.system(`Deep status failed: ${redact((error as Error).message, { secrets })}`);
    } finally {
      this.deepInFlight = false;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Payload parsing for the deep probes                                        */
/* -------------------------------------------------------------------------- */

/**
 * The AgentCraft CLIs print a JSON summary, but they also print human lines around it,
 * so fall back to extracting the outermost braces.
 */
export function parseJsonLoose(stdout: string): unknown | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through to brace extraction */
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

interface ParsedForemanStatus {
  auth: {
    authenticated: boolean | null;
    authLabel: string | null;
    detail: string | null;
  } | null;
  counts: {
    agents: number | null;
    activeAgents: number | null;
    tasks: number | null;
    openDecisions: number | null;
    showcase: boolean | null;
  } | null;
  /** `foreman.message`, e.g. "Claude (lead opus, workers sonnet)". */
  model: string | null;
  /** `foreman.account`, e.g. "… · Claude Pro". */
  account: string | null;
  /** `foreman.costUsd`, the session spend the Foreman reports. */
  costUsd: number | null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function players(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((p): p is string => typeof p === 'string').slice(0, 64);
}

export function parseForemanStatus(stdout: string): ParsedForemanStatus | null {
  const parsed = parseJsonLoose(stdout) as Record<string, unknown> | null;
  if (!parsed) return null;

  const source = ((parsed.summary as Record<string, unknown>) ?? parsed) as Record<string, unknown>;

  // `foremancli.mjs status --json` nests the identity block under `foreman` and reports
  // auth as a plain string ("ok"), not as an object. Reading auth off the root left it
  // permanently null, so the status panel showed "?" for auth and never showed which
  // models the Foreman is driving.
  const foreman = (source.foreman as Record<string, unknown> | undefined) ?? undefined;

  const authRaw = source.auth as Record<string, unknown> | string | null | undefined;
  const authOk = (value: string) => (value === 'ok' ? true : value === 'failed' ? false : null);

  let auth: ParsedForemanStatus['auth'] = null;
  if ('authenticated' in source) {
    // Legacy flat shape: an explicit boolean plus a label such as "api-key".
    auth = {
      authenticated: typeof source.authenticated === 'boolean' ? source.authenticated : null,
      authLabel: typeof authRaw === 'string' ? authRaw : str(authRaw),
      detail: str(source.detail) === null ? null : redact(source.detail as string),
    };
  } else if (authRaw && typeof authRaw === 'object') {
    auth = {
      authenticated: typeof authRaw.authenticated === 'boolean' ? authRaw.authenticated : null,
      authLabel: str(authRaw.label),
      detail: (() => {
        const detail = str(authRaw.detail);
        return detail === null ? null : redact(detail);
      })(),
    };
  } else if (typeof authRaw === 'string') {
    // Current foremancli shape: `foreman.auth` is the string "ok"/"failed".
    auth = {
      authenticated: authOk(authRaw),
      authLabel: authRaw,
      detail: (() => {
        const detail = str(foreman?.message);
        return detail === null ? null : redact(detail);
      })(),
    };
  } else if (foreman && typeof foreman.auth === 'string') {
    auth = {
      authenticated: authOk(foreman.auth),
      authLabel: foreman.auth,
      detail: (() => {
        const detail = str(foreman.message);
        return detail === null ? null : redact(detail);
      })(),
    };
  }

  const counters = source.counters as Record<string, unknown> | undefined;
  const countsSource = counters ?? source;
  const hasCounts = Object.keys(countsSource).some((key) =>
    ['agents', 'activeAgents', 'tasks', 'openDecisions', 'showcase'].includes(key),
  );
  // `openDecisions` is a list of pending items, not a number.
  const decisionCount = (() => {
    const raw = countsSource.openDecisions;
    if (Array.isArray(raw)) return raw.length;
    return num(raw);
  })();

  return {
    auth,
    counts: hasCounts
      ? {
          agents: num(countsSource.agents),
          activeAgents: num(countsSource.activeAgents),
          tasks: num(countsSource.tasks),
          openDecisions: decisionCount,
          showcase: typeof countsSource.showcase === 'boolean' ? countsSource.showcase : null,
        }
      : null,
    model: (() => {
      const message = str(foreman?.message);
      return message === null ? null : redact(message);
    })(),
    account: (() => {
      const account = str(foreman?.account);
      return account === null ? null : redact(account);
    })(),
    costUsd: num(foreman?.costUsd),
  };
}

export function parseGameState(stdout: string): McWorldSummary | null {
  const parsed = parseJsonLoose(stdout) as Record<string, unknown> | null;
  if (!parsed) return null;
  const summary = (parsed.summary as Record<string, unknown>) ?? parsed;
  const state = (summary.state as Record<string, unknown> | undefined) ?? undefined;
  return {
    address: str(summary.address),
    online: typeof summary.online === 'boolean' ? summary.online : null,
    mode: str(state?.mode),
    level: str(state?.level),
    phase: str(state?.phase),
    players: players(state?.players),
  };
}

/* -------------------------------------------------------------------------- */
/* Resource resolution                                                        */
/* -------------------------------------------------------------------------- */

function powershellExeOrThrow(): string {
  const system = process.env.SystemRoot ?? 'C:\\Windows';
  return path.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export function probeScriptPath(): string {
  const candidates = [
    path.join(__dirname, '..', '..', 'resources', 'probe.ps1'),
    path.join(process.resourcesPath ?? '', 'probe.ps1'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return candidates[0]!;
}