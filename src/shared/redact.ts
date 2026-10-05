/**
 * Secret redaction for anything that reaches the in-app console, a log file or the
 * main process stdout. Keys are masked by value and by shape, so an Anthropic key can
 * never be shown even if it arrives through an unexpected channel.
 */

const REDACTED = '***redacted***';

/** Shape of a console Anthropic key: `sk-ant-` followed by base64url characters. */
const KEY_SHAPE = /sk-ant-[A-Za-z0-9_-]{6,}/g;

/** `ANTHROPIC_API_KEY = value` in any script output. */
const ENV_ASSIGNMENT = /(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_AUTH_TOKEN)(\s*[=:]\s*)("?)[^\s"']+\3/gi;

const ANSI = new RegExp(
  '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)' +
    '|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))',
  'g',
);

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** Remove a literal secret anywhere it appears in the text. */
function maskValues(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    const value = (secret ?? '').trim();
    if (value.length < 8) continue;
    out = out.split(value).join(REDACTED);
  }
  return out;
}

export interface RedactOptions {
  /** Literal values currently held in memory (the API key). */
  secrets?: readonly string[];
  /** Also strip ANSI colour escapes. */
  stripColors?: boolean;
}

export function redact(text: string, options: RedactOptions = {}): string {
  let out = String(text ?? '');
  if (options.stripColors !== false) out = stripAnsi(out);
  out = maskValues(out, options.secrets ?? []);
  out = out.replace(ENV_ASSIGNMENT, (_m, name, sep) => `${name}${sep}${REDACTED}`);
  out = out.replace(KEY_SHAPE, REDACTED);
  return out;
}

/** Split a raw stream chunk into complete lines, returning the incomplete remainder. */
export function splitLines(chunk: string, carry = ''): { lines: string[]; carry: string } {
  const text = carry + chunk;
  const parts = text.split(/\r\n|\r|\n/);
  const rest = parts.pop() ?? '';
  return { lines: parts, carry: rest };
}