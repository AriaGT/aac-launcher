/**
 * Real validation of an Anthropic console API key.
 *
 * Uses the official Models API, `GET https://api.anthropic.com/v1/models`, with the
 * `x-api-key` and `anthropic-version` headers documented for the Claude API. That
 * endpoint authenticates the key and bills no tokens, so it is the right check here:
 * a Messages API call would cost money just to prove the key works.
 *
 * The key is only ever a request header. It is never logged, never printed and never
 * placed in a command line.
 */
import type { ApiKeyValidationResult } from '../shared/ipc';
import { looksLikeAnthropicApiKey } from '../shared/validation';

const MODELS_URL = 'https://api.anthropic.com/v1/models';
const ANTHROPIC_VERSION = '2023-06-01';
const TIMEOUT_MS = 15_000;

export async function validateAnthropicApiKey(
  apiKey: string,
  signal?: AbortSignal,
): Promise<ApiKeyValidationResult> {
  const key = (apiKey ?? '').trim();
  const at = Date.now();

  if (!key) {
    return { status: 'empty', message: 'No API key configured.', at };
  }
  if (!looksLikeAnthropicApiKey(key)) {
    return {
      status: 'invalid',
      message: 'That does not look like an Anthropic console key (expected an sk-ant-... value).',
      at,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

  try {
    const response = await fetch(MODELS_URL, {
      method: 'GET',
      headers: {
        'x-api-key': key,
        'anthropic-version': ANTHROPIC_VERSION,
        accept: 'application/json',
      },
      signal: controller.signal,
    });

    if (response.status === 200) {
      return { status: 'validated', message: 'The key was accepted by the Anthropic API.', at };
    }
    if (response.status === 401 || response.status === 403) {
      return { status: 'invalid', message: 'Anthropic rejected this key (401/403).', at };
    }
    if (response.status === 429) {
      return {
        status: 'validated',
        message: 'The key was accepted, but the account is rate limited right now (429).',
        at,
      };
    }
    if (response.status >= 500) {
      return {
        status: 'unavailable',
        message: `Anthropic returned ${response.status}; the key could not be checked.`,
        at,
      };
    }
    return { status: 'invalid', message: `Anthropic returned ${response.status} for this key.`, at };
  } catch (error) {
    const reason = (error as Error).name === 'AbortError' ? 'the request timed out' : (error as Error).message;
    return {
      status: 'unavailable',
      message: `Could not reach the Anthropic API (${reason}). The key was not checked.`,
      at,
    };
  } finally {
    clearTimeout(timer);
  }
}