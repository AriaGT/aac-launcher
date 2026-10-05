import type { AgentCraftStatus, ForemanStatus, LaunchOptions, OperationState } from '../shared/types';
import { formatSince } from './format';
import { Chip, Dot, Panel, Row } from './ui';

const AUTH_LABEL: Record<string, { tone: 'ok' | 'bad' | 'warn'; text: string }> = {
  ok: { tone: 'ok', text: 'authenticated' },
  failed: { tone: 'bad', text: 'auth failed' },
  unknown: { tone: 'warn', text: 'auth unknown' },
};

function ForemanCard({ foreman }: { foreman: ForemanStatus }) {
  const auth = foreman.auth ? (AUTH_LABEL[foreman.auth] ?? AUTH_LABEL.unknown) : null;
  return (
    <article
      className={`rounded-lg border p-3 ${foreman.alive && foreman.portOpen ? 'border-emerald-700/50 bg-emerald-950/20' : 'border-edge bg-[#0d1526]'}`}
    >
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Dot tone={foreman.alive && foreman.portOpen ? 'ok' : foreman.alive ? 'warn' : 'bad'} />
          <span className="text-sm font-semibold text-slate-100">{foreman.profile || 'foreman'}</span>
          {foreman.backend && <Chip tone="plain">{foreman.backend}</Chip>}
          {foreman.showcase && <Chip tone="plain">showcase</Chip>}
        </div>
        {auth && <Chip tone={auth.tone}>{auth.text}</Chip>}
      </header>

      <div className="mt-2 divide-y divide-edge/60">
        <Row label="pid" value={foreman.pid} mono />
        <Row label="port" value={foreman.port ?? '—'} mono />
        <Row label="reachable" value={foreman.portOpen ? 'yes' : 'no'} />
        <Row label="process" value={foreman.alive ? 'alive' : 'gone'} />
        <Row label="stoppable" value={foreman.ownedByLauncher ? 'yes (run file)' : 'no (not ours)'} />
        <Row label="models" value={foreman.model ?? '—'} />
        <Row label="account" value={foreman.account ?? '—'} />
        <Row
          label="session cost"
          value={foreman.costUsd === null ? '—' : `$${foreman.costUsd.toFixed(3)}`}
          mono
        />
        <Row label="agents" value={foreman.agents ?? '—'} mono />
        <Row label="active" value={foreman.activeAgents ?? '—'} mono />
        <Row label="tasks" value={foreman.tasks ?? '—'} mono />
        <Row label="open decisions" value={foreman.openDecisions ?? '—'} mono />
        <Row label="home" value={foreman.home ?? '—'} mono />
      </div>
    </article>
  );
}

export function StatusPanel({
  status,
  operation,
  options,
  now,
}: {
  status: AgentCraftStatus;
  operation: OperationState | null;
  options: LaunchOptions;
  now: number;
}) {
  const game = status.game;
  const world = game?.world ?? null;

  return (
    <Panel
      title="Status"
      subtitle={status.agentcraftDir ? `polled ${formatSince(status.lastCheckAt, now)}` : 'no checkout selected'}
      actions={
        operation ? (
          <Chip tone="warn">{operation.message}</Chip>
        ) : (
          <Chip tone={status.checking ? 'plain' : 'ok'}>{status.checking ? 'checking…' : 'live'}</Chip>
        )
      }
    >
      <div className="space-y-3">
        {status.reason && (
          <p className="rounded-md border border-amber-700/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-200">
            {status.reason}
          </p>
        )}

        {status.foremen.length === 0 ? (
          <p className="rounded-md border border-edge bg-[#0d1526] px-3 py-4 text-center text-xs text-slate-500">
            No Foreman is running for this checkout.
          </p>
        ) : (
          <div className="space-y-2">
            {status.foremen.map((foreman) => (
              <ForemanCard key={`${foreman.profile}-${foreman.pid}`} foreman={foreman} />
            ))}
          </div>
        )}

        <article
          className={`rounded-lg border p-3 ${game?.running ? 'border-sky-700/50 bg-sky-950/20' : 'border-edge bg-[#0d1526]'}`}
        >
          <header className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Dot tone={game?.running ? (game.ready ? 'ok' : 'warn') : 'idle'} />
              <span className="text-sm font-semibold text-slate-100">Minecraft</span>
            </div>
            {game?.running ? (
              <Chip tone={game.ready ? 'ok' : 'warn'}>{game.ready ? 'connected' : 'starting'}</Chip>
            ) : (
              <Chip tone="plain">stopped</Chip>
            )}
          </header>

          <div className="mt-2 divide-y divide-edge/60">
            <Row label="game pid" value={game?.gamePid ?? '—'} mono />
            <Row label="gradle pid" value={game?.gradlePid ?? '—'} mono />
            <Row label="wrapper pid" value={game?.wrapperPid ?? '—'} mono />
            <Row label="devbridge port" value={game?.devPort ?? '—'} mono />
            <Row label="foreman port" value={game?.foremanPort ?? options.port ?? '—'} mono />
            {world && <Row label="mode" value={world.mode ?? '—'} />}
            {world && <Row label="level" value={world.level ?? '—'} />}
            {world && <Row label="players" value={world.players.length ? world.players.join(', ') : '0'} />}
          </div>

          {status.strayGamePid && (
            <p className="mt-2 rounded-md border border-amber-700/40 bg-amber-950/20 px-2 py-1.5 text-[11px] text-amber-200">
              A Minecraft client of this checkout (pid {status.strayGamePid}) is running but was not started by
              launch.ps1. “Stop game” will end it.
            </p>
          )}
        </article>
      </div>
    </Panel>
  );
}