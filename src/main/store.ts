/**
 * Persistence for the launcher's own configuration.
 *
 * Nothing secret except an Electron `safeStorage` blob (DPAPI on Windows) is written
 * here, and the file lives in `app.getPath('userData')` - never in the AgentCraft
 * checkout, never in the repository.
 */
import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_LAUNCH_OPTIONS,
  DEFAULT_STOP_OPTIONS,
  type LaunchOptions,
  type StopOptions,
} from '../shared/types';
import { parseLaunchOptions, parseStopOptions } from '../shared/ipc';

export interface StoredConfig {
  version: 1;
  agentcraftDir: string;
  options: LaunchOptions;
  stop: StopOptions;
  windowBounds: { width: number; height: number } | null;
  rememberApiKey: boolean;
  /** base64 of safeStorage.encryptString(), or null. Never plaintext. */
  apiKeyBlob: string | null;
}

export const DEFAULT_CONFIG: StoredConfig = {
  version: 1,
  agentcraftDir: '',
  options: { ...DEFAULT_LAUNCH_OPTIONS },
  stop: { ...DEFAULT_STOP_OPTIONS },
  windowBounds: null,
  rememberApiKey: false,
  apiKeyBlob: null,
};

function configPath(): string {
  return path.join(app.getPath('userData'), 'launcher-config.json');
}

/**
 * Windows editors and PowerShell's Out-File write a UTF-8 BOM, which JSON.parse rejects
 * outright. Strip it so a hand-edited config still loads.
 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function loadConfig(): StoredConfig {
  const fallback = (): StoredConfig => ({
    ...DEFAULT_CONFIG,
    options: { ...DEFAULT_LAUNCH_OPTIONS },
    stop: { ...DEFAULT_STOP_OPTIONS },
  });

  let raw: unknown;
  try {
    raw = JSON.parse(stripBom(fs.readFileSync(configPath(), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[launcher] ignoring unreadable settings file: ${(error as Error).message}`);
    }
    return fallback();
  }
  if (typeof raw !== 'object' || raw === null) return fallback();
  const record = raw as Record<string, unknown>;

  const optionsParsed = parseLaunchOptions(record.options);
  const stopParsed = parseStopOptions(record.stop);

  const bounds =
    typeof record.windowBounds === 'object' && record.windowBounds !== null
      ? (record.windowBounds as Record<string, unknown>)
      : null;
  const width = Number(bounds?.width);
  const height = Number(bounds?.height);

  return {
    version: 1,
    agentcraftDir: typeof record.agentcraftDir === 'string' ? record.agentcraftDir : '',
    options: optionsParsed.ok ? { ...DEFAULT_LAUNCH_OPTIONS, ...optionsParsed.value } : { ...DEFAULT_LAUNCH_OPTIONS },
    stop: stopParsed.ok ? { ...DEFAULT_STOP_OPTIONS, ...stopParsed.value } : { ...DEFAULT_STOP_OPTIONS },
    windowBounds:
      Number.isFinite(width) && Number.isFinite(height) && width >= 700 && height >= 480
        ? { width, height }
        : null,
    rememberApiKey: record.rememberApiKey === true,
    apiKeyBlob: typeof record.apiKeyBlob === 'string' && record.apiKeyBlob ? record.apiKeyBlob : null,
  };
}

export function saveConfig(config: StoredConfig): void {
  const target = configPath();
  const temp = `${target}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, target);
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      /* ignore */
    }
    console.error('[launcher] could not save settings:', (error as Error).message);
  }
}

/* -------------------------------------------------------------------------- */
/* Secret storage                                                              */
/* -------------------------------------------------------------------------- */

export function canPersistSecret(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

export function encryptSecret(value: string): string | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.encryptString(value).toString('base64');
  } catch {
    return null;
  }
}

export function decryptSecret(blob: string): string | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(Buffer.from(blob, 'base64'));
  } catch {
    return null;
  }
}