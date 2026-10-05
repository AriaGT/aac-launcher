import { describe, expect, it } from 'vitest';
import {
  apiKeyHint,
  checkAgentCraftDirectory,
  hasErrors,
  looksLikeAnthropicApiKey,
  planReset,
  planRestart,
  validateLaunchOptions,
  validatePorts,
  type FsProbe,
} from '../src/shared/validation';
import { DEFAULT_LAUNCH_OPTIONS, type LaunchOptions } from '../src/shared/types';

const FAKE_KEY = 'sk-ant-api03-' + 'A'.repeat(60);

function options(overrides: Partial<LaunchOptions> = {}): LaunchOptions {
  return { ...DEFAULT_LAUNCH_OPTIONS, ...overrides };
}

/** An FsProbe over a plain set of "existing" paths. */
function probeWith(existing: readonly string[], directories: readonly string[] = existing): FsProbe {
  const files = new Set(existing.map((p) => p.replace(/\//g, '\\').toLowerCase()));
  const dirs = new Set(directories.map((p) => p.replace(/\//g, '\\').toLowerCase()));
  return {
    stat(target) {
      const key = target.replace(/\//g, '\\').toLowerCase();
      return files.has(key) || dirs.has(key) ? target : null;
    },
    isDirectory(target) {
      return dirs.has(target.replace(/\//g, '\\').toLowerCase());
    },
  };
}

const GOOD_CHECKOUT = probeWith([
  'C:\\ac',
  'C:\\ac\\tools\\launch.ps1',
  'C:\\ac\\tools\\stop.ps1',
]);

describe('checkAgentCraftDirectory', () => {
  it('accepts a real checkout', () => {
    const check = checkAgentCraftDirectory('C:\\ac', GOOD_CHECKOUT);
    expect(check.ok).toBe(true);
    expect(check.hasLaunchScript).toBe(true);
    expect(check.hasStopScript).toBe(true);
    expect(check.resolved).toBe('C:\\ac');
  });

  it('rejects an empty path', () => {
    const check = checkAgentCraftDirectory('   ', GOOD_CHECKOUT);
    expect(check.ok).toBe(false);
    expect(check.message).toMatch(/Choose/i);
  });

  it('names the missing script when a folder is not a checkout', () => {
    const check = checkAgentCraftDirectory('C:\\other', probeWith(['C:\\other', 'C:\\other\\tools\\stop.ps1']));
    expect(check.ok).toBe(false);
    expect(check.hasStopScript).toBe(true);
    expect(check.hasLaunchScript).toBe(false);
    expect(check.message).toContain('launch.ps1');
  });

  it('reports a path that is not a folder', () => {
    const check = checkAgentCraftDirectory('C:\\missing', GOOD_CHECKOUT);
    expect(check.ok).toBe(false);
    expect(check.exists).toBe(false);
  });
});

describe('validatePorts', () => {
  it('rejects the ports launch.ps1 reserves', () => {
    for (const port of [3000, 5173, 8080]) {
      expect(hasErrors(validatePorts(port, null))).toBe(true);
    }
  });

  it('requires the two ports to differ', () => {
    expect(hasErrors(validatePorts(9000, 9000))).toBe(true);
  });

  it('accepts the defaults as null', () => {
    expect(validatePorts(null, null)).toEqual([]);
  });

  it('accepts an ordinary pair', () => {
    expect(validatePorts(7878, 7879)).toEqual([]);
  });

  it('rejects privileged and out-of-range ports', () => {
    expect(hasErrors(validatePorts(80, null))).toBe(true);
    expect(hasErrors(validatePorts(70000, null))).toBe(true);
  });
});

describe('validateLaunchOptions', () => {
  it('is clean for the defaults', () => {
    expect(validateLaunchOptions(options())).toEqual([]);
  });

  it('enforces the profile character class from launch.ps1', () => {
    expect(hasErrors(validateLaunchOptions(options({ foremanProfile: 'bad name' })))).toBe(true);
    expect(validateLaunchOptions(options({ foremanProfile: 'ok-Name_1' }))).toEqual([]);
  });

  it('blocks the showcase on the claude backend', () => {
    const issues = validateLaunchOptions(options({ showcase: true, backend: 'claude' }));
    expect(hasErrors(issues)).toBe(true);
  });

  it('warns that -NoNotify beats -Notify', () => {
    const issues = validateLaunchOptions(options({ notify: true, noNotify: true }));
    expect(issues.some((i) => i.severity === 'warning')).toBe(true);
  });

  it('warns that the claude login is unused by the sim backend', () => {
    const issues = validateLaunchOptions(options({ backend: 'sim', useClaudeLogin: true }));
    expect(issues.some((i) => i.field === 'useClaudeLogin')).toBe(true);
  });

  it('rejects a non-positive speed and a too-small timeout', () => {
    expect(hasErrors(validateLaunchOptions(options({ speed: 0 })))).toBe(true);
    expect(hasErrors(validateLaunchOptions(options({ timeoutSec: 5 })))).toBe(true);
  });

  it('rejects a repository path that is not a git root', () => {
    const issues = validateLaunchOptions(options({ repo: ['C:\\not-a-repo'] }), {
      isGitRepo: (p) => p === 'C:\\repo',
    });
    expect(hasErrors(issues)).toBe(true);
    expect(issues[0]?.message).toContain('git repository');
  });

  it('accepts a repository path that is a git root, including comma splitting', () => {
    const issues = validateLaunchOptions(options({ repo: ['C:\\repo,C:\\other'] }), {
      isGitRepo: (p) => p === 'C:\\repo' || p === 'C:\\other',
    });
    expect(issues).toEqual([]);
  });
});

describe('planReset', () => {
  it('stops the Foreman before launching, because -Reset is ignored on a live one', () => {
    const plan = planReset(options(), { foremanRunning: true, gameRunning: true }, 'claude');
    expect(plan.steps[0]?.kind).toBe('stop');
    expect(plan.steps[1]?.kind).toBe('launch');
    expect(plan.steps[1]?.label).toContain('-Reset');
  });

  it('does not schedule a stop when no Foreman is alive', () => {
    const plan = planReset(options(), { foremanRunning: false, gameRunning: false }, 'sim');
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.kind).toBe('launch');
    expect(plan.notes.join(' ')).toMatch(/fresh start/i);
  });
});

describe('planRestart', () => {
  it('stops first when something is running', () => {
    const plan = planRestart(options(), { foremanRunning: true, gameRunning: false }, 'sim');
    expect(plan.steps.map((s) => s.kind)).toEqual(['stop', 'launch']);
  });

  it('starts directly when nothing is running', () => {
    const plan = planRestart(options(), { foremanRunning: false, gameRunning: false }, 'sim');
    expect(plan.steps.map((s) => s.kind)).toEqual(['launch']);
    expect(plan.notes.join(' ')).toMatch(/plain start/i);
  });
});

describe('API key shape checks', () => {
  it('accepts a console key and rejects other shapes', () => {
    expect(looksLikeAnthropicApiKey(FAKE_KEY)).toBe(true);
    expect(looksLikeAnthropicApiKey('sk-ant-api03-short')).toBe(false);
    expect(looksLikeAnthropicApiKey('sk-proj-whatever')).toBe(false);
    expect(looksLikeAnthropicApiKey('')).toBe(false);
  });

  it('never hints more than the prefix and the last four characters', () => {
    const hint = apiKeyHint(FAKE_KEY);
    expect(hint.startsWith('sk-ant-a')).toBe(true);
    expect(hint.endsWith(FAKE_KEY.slice(-4))).toBe(true);
    expect(hint).not.toContain(FAKE_KEY.slice(10, 30));
    expect(hint).toContain('*');
  });

  it('masks a short value entirely', () => {
    expect(apiKeyHint('abcd')).toBe('abcd');
    expect(apiKeyHint('abcde')).not.toContain('abcde');
  });
});