import { describe, expect, it } from 'vitest';
import { redact, splitLines, stripAnsi } from '../src/shared/redact';

const SECRET = 'sk-ant-api03-' + 'K'.repeat(50);

describe('redact', () => {
  it('removes a known secret wherever it appears', () => {
    const text = `starting\nANTHROPIC_API_KEY=${SECRET}\ndone`;
    const out = redact(text, { secrets: [SECRET] });
    expect(out).not.toContain(SECRET);
    expect(out).toContain('ANTHROPIC_API_KEY=');
  });

  it('masks a key it has never been told about, by shape', () => {
    const out = redact(`key is ${SECRET} ok`);
    expect(out).not.toContain(SECRET);
    expect(out).toContain('***redacted***');
  });

  it('masks environment assignments regardless of the value', () => {
    const out = redact('ANTHROPIC_API_KEY: some-other-value');
    expect(out).not.toContain('some-other-value');
    expect(out).toContain('ANTHROPIC_API_KEY');
  });

  it('handles the other secret-bearing variables too', () => {
    expect(redact('CLAUDE_CODE_OAUTH_TOKEN=abc123')).not.toContain('abc123');
    expect(redact('ANTHROPIC_AUTH_TOKEN=abc123')).not.toContain('abc123');
  });

  it('leaves ordinary script output untouched', () => {
    const line = 'Foreman listening on http://127.0.0.1:7878';
    expect(redact(line)).toBe(line);
  });

  it('ignores very short secrets so it cannot blank out real text', () => {
    expect(redact('a-b-c', { secrets: ['a-b'] })).toBe('a-b-c');
  });

  it('is safe on empty and undefined-ish input', () => {
    expect(redact('')).toBe('');
    expect(redact(undefined as unknown as string)).toBe('');
  });
});

describe('stripAnsi', () => {
  it('removes colour sequences', () => {
    expect(stripAnsi('\u001b[32mREADY\u001b[0m')).toBe('READY');
  });

  it('runs as part of redaction', () => {
    expect(redact('\u001b[31mERROR\u001b[0m')).toBe('ERROR');
  });
});

describe('splitLines', () => {
  it('splits on CRLF and keeps the incomplete tail', () => {
    const result = splitLines('one\r\ntwo\r\nthr');
    expect(result.lines).toEqual(['one', 'two']);
    expect(result.carry).toBe('thr');
  });

  it('emits the remainder once the newline arrives', () => {
    const first = splitLines('a\nb');
    expect(first.lines).toEqual(['a']);
    const second = splitLines('c\n', first.carry);
    expect(second.lines).toEqual(['bc']);
  });

  it('handles LF and CR alone', () => {
    expect(splitLines('a\nb\n').lines).toEqual(['a', 'b']);
    expect(splitLines('a\rb\r').lines).toEqual(['a', 'b']);
  });

  it('works with an empty chunk', () => {
    expect(splitLines('')).toEqual({ lines: [], carry: '' });
  });
});