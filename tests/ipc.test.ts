import { describe, expect, it } from 'vitest';
import {
  parseApiKeyInput,
  parseDirectoryPath,
  parseLaunchOptions,
  parseSettingsPatch,
  parseStopOptions,
} from '../src/shared/ipc';
import { DEFAULT_LAUNCH_OPTIONS } from '../src/shared/types';

describe('parseLaunchOptions', () => {
  it('accepts an empty object and fills the documented defaults', () => {
    const result = parseLaunchOptions({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.backend).toBe('sim');
    expect(result.value.port).toBeNull();
    expect(result.value.timeoutSec).toBe(600);
    expect(result.value.repo).toEqual([]);
  });

  it('rejects a backend outside the two real ones', () => {
    expect(parseLaunchOptions({ backend: 'gpt' }).ok).toBe(false);
    expect(parseLaunchOptions({ backend: 'SIM' }).ok).toBe(false);
  });

  it('rejects a non-object', () => {
    expect(parseLaunchOptions(null).ok).toBe(false);
    expect(parseLaunchOptions('sim').ok).toBe(false);
    expect(parseLaunchOptions([]).ok).toBe(false);
  });

  it('discards an out-of-range port rather than forwarding it', () => {
    const result = parseLaunchOptions({ port: 99999, devPort: 7879 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.port).toBeNull();
    expect(result.value.devPort).toBe(7879);
  });

  it('coerces a numeric string port', () => {
    const result = parseLaunchOptions({ port: '9000' });
    expect(result.ok && result.value.port).toBe(9000);
  });

  it('truncates a fractional port to an integer', () => {
    const result = parseLaunchOptions({ port: 9000.7 });
    expect(result.ok && result.value.port).toBe(9000);
  });

  it('keeps only string entries from repo', () => {
    const result = parseLaunchOptions({ repo: ['C:\\a', 42, null, ' C:\\b '] });
    expect(result.ok && result.value.repo).toEqual(['C:\\a', 'C:\\b']);
  });

  it('caps the repository list length', () => {
    const result = parseLaunchOptions({ repo: Array.from({ length: 200 }, (_, i) => `C:\\r${i}`) });
    expect(result.ok && result.value.repo.length).toBeLessThanOrEqual(32);
  });

  it('defaults an unknown showcaseAt to busy', () => {
    const result = parseLaunchOptions({ showcaseAt: 'nope' });
    expect(result.ok && result.value.showcaseAt).toBe('busy');
  });

  it('falls back to defaults for booleans that are not booleans', () => {
    const result = parseLaunchOptions({ dev: 'yes', notify: true });
    expect(result.ok && result.value.dev).toBe(false);
    expect(result.ok && result.value.notify).toBe(true);
  });

  it('produces a value that satisfies the LaunchOptions contract', () => {
    const result = parseLaunchOptions({ backend: 'claude', dev: true });
    expect(result.ok && result.value).toMatchObject({ backend: 'claude', dev: true });
  });
});

describe('parseStopOptions', () => {
  it('defaults to the 30 second stop timeout', () => {
    const result = parseStopOptions({});
    expect(result.ok && result.value.timeoutSec).toBe(30);
  });

  it('rejects an out-of-range stop timeout', () => {
    expect(parseStopOptions({ timeoutSec: 0 }).ok).toBe(false);
  });
});

describe('parseSettingsPatch', () => {
  it('accepts an empty patch', () => {
    expect(parseSettingsPatch({})).toEqual({ ok: true, value: {} });
  });

  it('keeps only the allowlisted keys', () => {
    const result = parseSettingsPatch({
      dev: true,
      agentcraftDir: 'C:\\ac',
      __proto__: 'polluted',
      constructor: 'nope',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value).sort()).toEqual(['agentcraftDir', 'dev']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects a non-boolean for a boolean key', () => {
    expect(parseSettingsPatch({ dev: 'true' }).ok).toBe(false);
  });

  it('rejects an invalid backend or showcaseAt', () => {
    expect(parseSettingsPatch({ backend: 'gpt' }).ok).toBe(false);
    expect(parseSettingsPatch({ showcaseAt: 'never' }).ok).toBe(false);
  });

  it('clamps a window size that is out of range', () => {
    // Too small clamps up to the minimum, too large clamps down to the maximum.
    expect(parseSettingsPatch({ windowBounds: { width: 100, height: 700 } })).toEqual({
      ok: true,
      value: { windowBounds: { width: 700, height: 700 } },
    });
    expect(parseSettingsPatch({ windowBounds: { width: 5000, height: 9000 } })).toEqual({
      ok: true,
      value: { windowBounds: { width: 1600, height: 1600 } },
    });
  });

  it('falls back to the default size when the values are not numbers', () => {
    expect(parseSettingsPatch({ windowBounds: { width: 'wide', height: null } })).toEqual({
      ok: true,
      value: { windowBounds: { width: 1180, height: 820 } },
    });
  });

  it('keeps an in-range window size untouched', () => {
    expect(parseSettingsPatch({ windowBounds: { width: 1000, height: 700 } })).toEqual({
      ok: true,
      value: { windowBounds: { width: 1000, height: 700 } },
    });
  });

  it('accepts rememberApiKey only as a boolean', () => {
    expect(parseSettingsPatch({ rememberApiKey: true }).ok).toBe(true);
    expect(parseSettingsPatch({ rememberApiKey: 'yes' }).ok).toBe(false);
  });
});

describe('parseApiKeyInput', () => {
  it('defaults remember to true', () => {
    const result = parseApiKeyInput({ apiKey: 'sk-ant-x' });
    expect(result.ok && result.value.remember).toBe(true);
  });

  it('rejects a non-string key', () => {
    expect(parseApiKeyInput({ apiKey: 123 }).ok).toBe(false);
    expect(parseApiKeyInput({}).ok).toBe(false);
  });

  it('rejects a non-boolean remember', () => {
    expect(parseApiKeyInput({ apiKey: 'x', remember: 'no' }).ok).toBe(false);
  });
});

describe('parseDirectoryPath', () => {
  it('accepts a normal path and rejects an over-long one', () => {
    expect(parseDirectoryPath({ path: 'C:\\code\\agentcraft' }).ok).toBe(true);
    expect(parseDirectoryPath({ path: 'C'.repeat(5000) }).ok).toBe(false);
    expect(parseDirectoryPath({ path: 42 }).ok).toBe(false);
  });
});

describe('defaults agree across modules', () => {
  it('parseLaunchOptions of the defaults round-trips', () => {
    const result = parseLaunchOptions(DEFAULT_LAUNCH_OPTIONS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(DEFAULT_LAUNCH_OPTIONS);
  });
});