import { useMemo, useState } from 'react';
import type { LaunchOptions, OperationState, ValidationIssue } from '../shared/types';
import type { SettingsSnapshot } from '../shared/ipc';
import { hasErrors, planReset } from '../shared/validation';
import { RESERVED_PORTS } from '../shared/types';
import { Chip, Field, IssueList, Panel, Switch, TextField } from './ui';

type Tab = 'run' | 'options';

const BACKEND_CARDS: Array<{ id: LaunchOptions['backend']; name: string; blurb: string }> = [
  { id: 'sim', name: 'Simulated', blurb: 'No API key, no Claude calls. The Foreman follows a scripted plan.' },
  { id: 'claude', name: 'Claude', blurb: 'Real agents drive the world through the Anthropic API.' },
];

interface PortFieldProps {
  label: string;
  field: 'port' | 'devPort';
  value: number | null;
  placeholder: string;
  disabled: boolean;
  issues: ValidationIssue[];
  onChange(next: number | null): void;
}

function PortField({ label, field, value, placeholder, disabled, issues, onChange }: PortFieldProps) {
  return (
    <Field label={label}>
      <div className="flex items-center gap-2">
        <TextField
          mono
          type="number"
          value={value === null ? '' : String(value)}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(raw) => {
            if (raw.trim() === '') {
              onChange(null);
              return;
            }
            const parsed = Number(raw);
            onChange(Number.isFinite(parsed) ? Math.trunc(parsed) : null);
          }}
        />
        <button
          type="button"
          className="btn flex-none px-2 py-1 text-xs"
          disabled={disabled}
          onClick={() => onChange(null)}
          title="Let launch.ps1 pick the default"
        >
          auto
        </button>
      </div>
      <p className="mt-1 text-[11px] text-slate-500">
        Blank = launch.ps1 default. Reserved: {RESERVED_PORTS.join(', ')}.
      </p>
      <IssueList issues={issues.filter((issue) => issue.field === field)} />
    </Field>
  );
}

export function OptionsPanel({
  snapshot,
  operation,
  onPatch,
  onSelectBackend,
  onStart,
  onRestart,
  onReset,
  onStopAll,
  onStopForeman,
  onStopGame,
  onOpenLogs,
}: {
  snapshot: SettingsSnapshot;
  operation: OperationState | null;
  onPatch(patch: Record<string, unknown>): void;
  onSelectBackend(backend: LaunchOptions['backend']): void;
  onStart(): void;
  onRestart(): void;
  onReset(): void;
  onStopAll(): void;
  onStopForeman(): void;
  onStopGame(): void;
  onOpenLogs(): void;
}) {
  const [tab, setTab] = useState<Tab>('run');
  const options = snapshot.options;
  const issues = snapshot.issues;
  const blocked = hasErrors(issues) || !snapshot.directory?.ok;
  const busy = operation !== null;

  const foremanRunning = useMemo(
    () => snapshot.__foremen?.some((f) => f.alive) ?? false,
    [snapshot.__foremen],
  );

  const set = <K extends keyof LaunchOptions>(key: K, value: LaunchOptions[K]): void => {
    onPatch({ [key]: value } as Record<string, unknown>);
  };

  const resetPlan = planReset(
    options,
    { foremanRunning, gameRunning: snapshot.__gameRunning ?? false },
    options.foremanProfile || options.backend,
  );

  return (
    <Panel
      title="Control"
      subtitle={blocked ? 'Fix the highlighted fields to enable the actions.' : 'Ready.'}
      actions={
        <div className="flex rounded-lg border border-edge p-0.5">
          {(['run', 'options'] as Tab[]).map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`rounded-md px-3 py-1 text-xs font-semibold transition ${
                tab === id ? 'bg-sky-600 text-slate-950' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {id === 'run' ? 'Run' : 'Options'}
            </button>
          ))}
        </div>
      }
    >
      {tab === 'run' ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            {BACKEND_CARDS.map((card) => {
              const selected = (options.showcase ? 'sim' : options.backend) === card.id;
              return (
                <button
                  key={card.id}
                  type="button"
                  disabled={busy}
                  onClick={() => onSelectBackend(card.id)}
                  className={`rounded-lg border p-3 text-left transition disabled:opacity-50 ${
                    selected
                      ? 'border-sky-500 bg-sky-950/30'
                      : 'border-edge bg-[#0d1526] hover:border-slate-600'
                  }`}
                >
                  <span className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-slate-100">{card.name}</span>
                    {selected && <Chip tone="ok">active</Chip>}
                  </span>
                  <span className="mt-1 block text-[11px] leading-relaxed text-slate-400">{card.blurb}</span>
                </button>
              );
            })}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Foreman port">
              <TextField
                mono
                type="number"
                disabled={busy}
                value={options.port === null ? '' : String(options.port)}
                placeholder="auto (7878)"
                onChange={(raw) => set('port', raw.trim() === '' ? null : Math.trunc(Number(raw)) || null)}
              />
            </Field>
            <Field label="DevBridge port">
              <TextField
                mono
                type="number"
                disabled={busy}
                value={options.devPort === null ? '' : String(options.devPort)}
                placeholder="auto (7879)"
                onChange={(raw) => set('devPort', raw.trim() === '' ? null : Math.trunc(Number(raw)) || null)}
              />
            </Field>
          </div>
          <IssueList issues={issues.filter((i) => i.field === 'port' || i.field === 'devPort')} />

          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            <Switch checked={options.dev} disabled={busy} onChange={(v) => set('dev', v)} label="Dev mode (-Dev)" />
            <Switch
              checked={options.autostart}
              disabled={busy}
              onChange={(v) => set('autostart', v)}
              label="Autostart (-Autostart)"
            />
            <Switch
              checked={options.showcase}
              disabled={busy}
              onChange={(v) => set('showcase', v)}
              label="Showcase (-Showcase)"
              hint="sim only"
            />
            <Switch
              checked={options.showcaseAt === 'late'}
              disabled={busy || !options.showcase}
              onChange={(v) => set('showcaseAt', v ? 'late' : 'busy')}
              label="Showcase late"
            />
            <Switch
              checked={options.useClaudeLogin}
              disabled={busy}
              onChange={(v) => set('useClaudeLogin', v)}
              label="claude.ai login"
            />
            <Switch checked={options.notify} disabled={busy} onChange={(v) => set('notify', v)} label="Toasts (-Notify)" />
          </div>
          <IssueList issues={issues.filter((i) => ['showcase', 'dev', 'useClaudeLogin', 'noNotify'].includes(i.field))} />

          <Field label="Goal (-Goal)">
            <TextField
              disabled={busy}
              value={options.goal}
              placeholder="Ship the block palette…"
              onChange={(v) => set('goal', v)}
            />
          </Field>

          <div className="flex flex-wrap gap-2 border-t border-edge pt-3">
            <button type="button" className="btn btn-primary" disabled={blocked || busy} onClick={onStart}>
              Start
            </button>
            <button type="button" className="btn" disabled={blocked || busy} onClick={onRestart}>
              Restart
            </button>
            <button type="button" className="btn" disabled={blocked || busy} onClick={onReset} title="Stop the Foreman, then launch with -Reset">
              Reset
            </button>
            <button type="button" className="btn btn-danger" disabled={busy || !snapshot.__anyRunning} onClick={onStopAll}>
              Stop all
            </button>
            <button type="button" className="btn btn-danger" disabled={busy || !foremanRunning} onClick={onStopForeman}>
              Stop Foreman
            </button>
            <button type="button" className="btn btn-danger" disabled={busy || !snapshot.__gameRunning} onClick={onStopGame}>
              Stop game
            </button>
            <button type="button" className="btn ml-auto" onClick={onOpenLogs}>
              Open logs
            </button>
          </div>

          {tab === 'run' && (
            <div className="rounded-md border border-edge bg-[#0d1526] px-3 py-2 text-[11px] leading-relaxed text-slate-400">
              <p className="mb-1 font-semibold text-slate-300">What Reset does</p>
              <ol className="list-inside list-decimal space-y-0.5">
                {resetPlan.steps.map((step, index) => (
                  <li key={index}>{step.label}</li>
                ))}
              </ol>
              {resetPlan.notes.map((note, index) => (
                <p key={index} className="mt-1 text-amber-300/90">
                  {note}
                </p>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <Field label="Foreman profile (-ForemanProfile)">
            <TextField
              mono
              disabled={busy}
              value={options.foremanProfile}
              placeholder="auto (from backend)"
              onChange={(v) => set('foremanProfile', v)}
            />
          </Field>
          <IssueList issues={issues.filter((i) => i.field === 'foremanProfile')} />

          <div className="grid grid-cols-2 gap-3">
            <PortField
              label="Foreman port"
              field="port"
              value={options.port}
              placeholder="auto"
              disabled={busy}
              issues={issues}
              onChange={(v) => set('port', v)}
            />
            <PortField
              label="DevBridge port"
              field="devPort"
              value={options.devPort}
              placeholder="auto"
              disabled={busy}
              issues={issues}
              onChange={(v) => set('devPort', v)}
            />
          </div>

          <Field label="Agent home (-AgentHome)">
            <TextField
              mono
              disabled={busy}
              value={options.agentHome}
              placeholder="auto (%USERPROFILE%\.agentcraft)"
              onChange={(v) => set('agentHome', v)}
            />
          </Field>
          <IssueList issues={issues.filter((i) => i.field === 'agentHome')} />

          <Field label="Gradle home (-GradleHome)">
            <TextField
              mono
              disabled={busy}
              value={options.gradleHome}
              placeholder="auto"
              onChange={(v) => set('gradleHome', v)}
            />
          </Field>

          <Field label="Repositories (-Repo, comma separated)">
            <TextField
              mono
              disabled={busy}
              value={options.repo.join(', ')}
              placeholder="C:\code\my-game"
              onChange={(v) => set('repo', v.split(',').map((s) => s.trim()).filter(Boolean))}
            />
          </Field>
          <IssueList issues={issues.filter((i) => i.field === 'repo')} />

          <div className="grid grid-cols-3 gap-3">
            <Field label="Speed (-Speed)">
              <TextField
                mono
                type="number"
                disabled={busy}
                value={options.speed === null ? '' : String(options.speed)}
                placeholder="auto"
                onChange={(v) => set('speed', v.trim() === '' ? null : Number(v) || null)}
              />
            </Field>
            <Field label="Launch timeout (s)">
              <TextField
                mono
                type="number"
                disabled={busy}
                value={String(options.timeoutSec)}
                onChange={(v) => set('timeoutSec', Math.trunc(Number(v)) || 600)}
              />
            </Field>
            <Field label="Stop timeout (s)">
              <TextField
                mono
                type="number"
                disabled={busy}
                value={String(snapshot.stop.timeoutSec)}
                onChange={(v) => onPatch({ stopTimeoutSec: Math.trunc(Number(v)) || 30 })}
              />
            </Field>
          </div>
          <IssueList issues={issues.filter((i) => i.field === 'speed' || i.field === 'timeoutSec')} />

          <details className="rounded-md border border-edge bg-[#0d1526] px-3 py-2">
            <summary className="cursor-pointer text-xs font-semibold text-slate-300">
              Advanced switches that change what actually starts
            </summary>
            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2">
              <Switch
                checked={options.noGame}
                disabled={busy}
                onChange={(v) => set('noGame', v)}
                label="Foreman only (-NoGame)"
              />
              <Switch
                checked={options.noForeman}
                disabled={busy}
                onChange={(v) => set('noForeman', v)}
                label="Game only (-NoForeman)"
              />
              <Switch
                checked={options.noNotify}
                disabled={busy}
                onChange={(v) => set('noNotify', v)}
                label="Suppress toasts (-NoNotify)"
              />
              <Switch checked={options.reset} disabled={busy} onChange={(v) => set('reset', v)} label="Pass -Reset" />
              <Switch
                checked={options.noWait}
                disabled={busy}
                onChange={(v) => set('noWait', v)}
                label="Do not wait for readiness (-NoWait)"
              />
              <Switch
                checked={snapshot.stop.stopDaemon}
                disabled={busy}
                onChange={(v) => onPatch({ stopDaemon: v })}
                label="Stop daemon too"
              />
            </div>
            <IssueList issues={issues} />
          </details>
        </div>
      )}
    </Panel>
  );
}