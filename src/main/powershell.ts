/**
 * Running the AgentCraft PowerShell scripts.
 *
 * PowerShell is always launched with an absolute executable path and a fixed flag set
 * (`-NoProfile -NonInteractive -ExecutionPolicy Bypass -File <script> <args...>`). The
 * argument array comes from src/shared/command-builder; no shell string is ever built,
 * and the renderer never supplies one.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { PowerShellCommand } from '../shared/command-builder';
import { splitLines } from '../shared/redact';

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  spawnError: NodeJS.ErrnoException | null;
}

export interface RunHandlers {
  onStdout?(line: string): void;
  onStderr?(line: string): void;
  /** Extra environment for the child only (this is how ANTHROPIC_API_KEY travels). */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

let cachedEncoding: string | null = null;

/**
 * Windows PowerShell 5.1 writes to a redirected stdout with the console output code
 * page, so the parent has to decode with the same code page. Detected once with a
 * throwaway probe and cached.
 */
export async function consoleOutputEncoding(): Promise<string> {
  if (cachedEncoding) return cachedEncoding;
  const exe = powershellCandidates()[0];
  if (!exe) return 'utf-8';
  const result = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
    const child = spawn(
      exe,
      ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding.WebName'],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.on('error', () => resolve({ code: null, stdout: '' }));
    child.on('close', (code) => resolve({ code, stdout: out }));
  });
  const name = result.stdout.trim().replace(/[^A-Za-z0-9_-]/g, '');
  cachedEncoding = name || 'utf-8';
  return cachedEncoding;
}

/** Forget the cached code page (tests). */
export function resetEncodingCache(): void {
  cachedEncoding = null;
}

/** Windows PowerShell 5.1 first (AgentCraft targets it), then PowerShell 7. */
function powershellCandidates(): string[] {
  const found: string[] = [];
  const system = process.env.SystemRoot ?? 'C:\\Windows';
  found.push(path.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  const system32 = path.join(system, 'Sysnative', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  found.push(system32);
  return found.filter((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
}

export function resolvePowerShell(): { exe: string } | { error: string } {
  const candidates = powershellCandidates();
  if (candidates.length) return { exe: candidates[0] };
  return {
    error:
      'Windows PowerShell was not found (expected %SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe).',
  };
}

/** `node` from PATH, which AgentCraft itself requires (Node 22+). */
/**
 * The `node` executable used to run AgentCraft's own CLIs (foremancli.mjs, devcli.mjs).
 * The copy bundled with Electron is not exposed to the child, so prefer a real Node on
 * PATH; a portable app also needs one, because launch.ps1 requires Node 22+.
 */
export function resolveNode(): string | null {
  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir.replace(/^"|"$/g, ''), 'node.exe');
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* keep looking */
    }
  }
  // A `node` on PATH without the .exe suffix is still usable through spawn.
  return pathEnv.split(path.delimiter).length > 1 ? 'node.exe' : null;
}

function makeDecoder(encoding: string): TextDecoder {
  try {
    return new TextDecoder(encoding);
  } catch {
    return new TextDecoder('utf-8');
  }
}

export async function runPowerShell(command: PowerShellCommand, handlers: RunHandlers = {}): Promise<RunResult> {
  const startedAt = Date.now();
  const encoding = await consoleOutputEncoding();
  const decoder = makeDecoder(encoding);

  const env: NodeJS.ProcessEnv = { ...process.env, ...(handlers.env ?? {}) };
  // Keep PowerShell from paging or prompting.
  env.NO_COLOR = '1';

  let child: ReturnType<typeof spawn> & { stdout: NodeJS.ReadableStream; stderr: NodeJS.ReadableStream };
  try {
    child = spawn(command.exe, command.args, {
      cwd: command.cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    return {
      code: null,
      signal: null,
      timedOut: false,
      durationMs: Date.now() - startedAt,
      spawnError: error as NodeJS.ErrnoException,
    };
  }

  let stdoutCarry = '';
  let stderrCarry = '';
  let timedOut = false;
  let settled = false;

  const timeoutMs = handlers.timeoutMs ?? 0;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, timeoutMs)
      : null;

  const pump = (stream: NodeJS.ReadableStream, emit: ((line: string) => void) | undefined, carryKey: 'out' | 'err') => {
    let carry = carryKey === 'out' ? stdoutCarry : stderrCarry;
    stream.on('data', (chunk: Buffer) => {
      const { lines, carry: rest } = splitLines(decoder.decode(chunk, { stream: true }), carry);
      carry = rest;
      if (carryKey === 'out') stdoutCarry = rest;
      else stderrCarry = rest;
      for (const line of lines) emit?.(line);
    });
  };

  pump(child.stdout, handlers.onStdout, 'out');
  pump(child.stderr, handlers.onStderr, 'err');

  const done = new Promise<RunResult>((resolve) => {
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        code: null,
        signal: null,
        timedOut,
        durationMs: Date.now() - startedAt,
        spawnError: error,
      });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const tailOut = stdoutCarry.trim();
      if (tailOut) handlers.onStdout?.(tailOut);
      const tailErr = stderrCarry.trim();
      if (tailErr) handlers.onStderr?.(tailErr);
      resolve({ code, signal, timedOut, durationMs: Date.now() - startedAt, spawnError: null });
    });
  });

  return done;
}

/** Run a small `node <script> ...` helper such as tools/foremancli.mjs. */
export async function runNode(
  nodeExe: string,
  scriptPath: string,
  scriptArgs: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string; error: string | null }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn> & { stdout: NodeJS.ReadableStream; stderr: NodeJS.ReadableStream };
    try {
      child = spawn(nodeExe, [scriptPath, ...scriptArgs], {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ ok: false, stdout: '', error: (error as Error).message });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, stdout, error: error.message });
    });
    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: true, stdout, error: stderr.trim() || null });
    });
  });
}