import { describe, expect, it } from 'vitest';
import { parseForemanStatus, parseGameState, parseJsonLoose } from '../src/main/status-service';

describe('parseJsonLoose', () => {
  it('parses plain JSON', () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
  });

  it('extracts the outermost object from chatty output', () => {
    const out = 'checking...\n{"ok":true,"a":1}\ndone';
    expect(parseJsonLoose(out)).toEqual({ ok: true, a: 1 });
  });

  it('returns null for unusable output', () => {
    expect(parseJsonLoose('')).toBeNull();
    expect(parseJsonLoose('not json at all')).toBeNull();
    expect(parseJsonLoose('{broken')).toBeNull();
  });
});

describe('parseForemanStatus', () => {
  it('reads the nested auth object', () => {
    const out = JSON.stringify({
      summary: {
        auth: { authenticated: true, label: 'claude-login', detail: 'claude.ai subscription' },
        counters: { agents: 5, activeAgents: 2, tasks: 11, openDecisions: 1, showcase: false },
      },
    });
    const parsed = parseForemanStatus(out);
    expect(parsed?.auth).toEqual({
      authenticated: true,
      authLabel: 'claude-login',
      detail: 'claude.ai subscription',
    });
    expect(parsed?.counts).toEqual({
      agents: 5,
      activeAgents: 2,
      tasks: 11,
      openDecisions: 1,
      showcase: false,
    });
  });

  it('reads a flat authenticated field', () => {
    const parsed = parseForemanStatus(JSON.stringify({ authenticated: false, auth: 'api-key', detail: 'no key' }));
    expect(parsed?.auth?.authenticated).toBe(false);
    expect(parsed?.auth?.authLabel).toBe('api-key');
  });

  it('reports unknown authentication rather than guessing', () => {
    const parsed = parseForemanStatus(JSON.stringify({ summary: {} }));
    expect(parsed?.auth).toBeNull();
  });

  it('ignores non-numeric counters', () => {
    const parsed = parseForemanStatus(JSON.stringify({ counters: { agents: 'five' } }));
    expect(parsed?.counts?.agents).toBeNull();
  });

  it('redacts a secret that leaks into the auth detail', () => {
    const key = 'sk-ant-api03-' + 'S'.repeat(50);
    const parsed = parseForemanStatus(
      JSON.stringify({ summary: { auth: { authenticated: false, label: 'api-key', detail: `failed with ${key}` } } }),
    );
    expect(parsed?.auth?.detail).toContain('failed with');
    expect(parsed?.auth?.detail).not.toContain(key);
  });
});

describe('parseGameState', () => {
  it('reads the mode, level and players', () => {
    const out = JSON.stringify({
      summary: {
        address: '127.0.0.1:25565',
        online: true,
        state: { mode: 'survival', level: 'world-1', players: ['ada', 'bob', 7] },
      },
    });
    const parsed = parseGameState(out);
    expect(parsed?.address).toBe('127.0.0.1:25565');
    expect(parsed?.mode).toBe('survival');
    expect(parsed?.level).toBe('world-1');
    expect(parsed?.players).toEqual(['ada', 'bob']);
  });

  it('survives a missing state block', () => {
    const parsed = parseGameState(JSON.stringify({ summary: { online: false } }));
    expect(parsed?.online).toBe(false);
    expect(parsed?.mode).toBeNull();
    expect(parsed?.players).toEqual([]);
  });

  it('returns null for empty output', () => {
    expect(parseGameState('')).toBeNull();
  });
});