import { useState } from 'react';
import type { ApiKeyState } from '../shared/types';
import { Chip, Panel, Switch } from './ui';

export function ApiKeyPanel({ state }: { state: ApiKeyState }) {
  const [value, setValue] = useState('');
  const [remember, setRemember] = useState(state.remember);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const tone =
    state.status === 'validated' ? 'ok' : state.status === 'invalid' ? 'bad' : state.status === 'unavailable' ? 'warn' : 'plain';

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!value.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await window.launcher.setApiKey(value, remember);
      setMessage(result.message);
      if (result.ok) setValue('');
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await window.launcher.validateApiKey();
      setMessage(result.message);
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    try {
      const result = await window.launcher.clearApiKey();
      setMessage(result.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Anthropic API key"
      subtitle="Only the claude backend needs one. The sim backend never calls Claude."
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Chip tone={tone}>{state.status}</Chip>
          {state.hint && <code className="font-mono text-[11px] text-slate-400">{state.hint}</code>}
          {state.validatedAt && (
            <span className="text-[11px] text-slate-500">checked {new Date(state.validatedAt).toLocaleTimeString()}</span>
          )}
        </div>

        <p className="text-xs leading-relaxed text-slate-400">{state.message}</p>

        <form onSubmit={submit} className="space-y-2">
          <input
            className="input font-mono"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-ant-…"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={busy}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <Switch
                checked={remember}
                disabled={busy || !state.canPersist}
                onChange={setRemember}
                label="Remember on this PC"
                hint={state.canPersist ? '(DPAPI)' : '(unavailable)'}
              />
              <Switch
                checked
                disabled
                onChange={() => undefined}
                label="Use claude.ai login instead"
                hint="(-UseClaudeLogin)"
              />
            </div>
            <div className="flex gap-2">
              <button type="submit" className="btn btn-primary" disabled={busy || !value.trim()}>
                Save key
              </button>
              <button type="button" className="btn" onClick={verify} disabled={busy || !state.hint}>
                Validate
              </button>
              <button type="button" className="btn btn-danger" onClick={clear} disabled={busy || !state.hint}>
                Clear
              </button>
            </div>
          </div>
        </form>

        {message && <p className="text-xs text-sky-300">{message}</p>}

        <p className="text-[11px] leading-relaxed text-slate-500">
          Validation sends one <code className="font-mono">GET /v1/models</code> request with the key in the{' '}
          <code className="font-mono">x-api-key</code> header; it costs no tokens. When remembered, the key is
          encrypted with Windows DPAPI and stored only in the launcher's own user-data folder. It is never written
          to the AgentCraft checkout, a log, a command line or this repository.
        </p>
      </div>
    </Panel>
  );
}