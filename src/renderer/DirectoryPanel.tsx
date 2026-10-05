import { useState } from 'react';
import type { DirectoryCheck } from '../shared/types';

export function DirectoryPanel({
  check,
  busy,
  onChoose,
  onValidate,
}: {
  check: DirectoryCheck | null;
  busy: boolean;
  onChoose(): void;
  onValidate(path: string): void;
}) {
  const [manual, setManual] = useState('');
  const ok = check?.ok ?? false;

  return (
    <section className="panel">
      <header className="flex items-center justify-between gap-3 border-b border-edge px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-slate-100">AgentCraft folder</h2>
          <p className="mt-0.5 truncate font-mono text-xs text-slate-400">
            {check?.resolved || check?.directory || 'not selected'}
          </p>
        </div>
        <button type="button" className="btn btn-primary flex-none" onClick={onChoose} disabled={busy}>
          Browse…
        </button>
      </header>

      <div className="space-y-2 p-4">
        <p className={`text-xs ${ok ? 'text-emerald-300' : 'text-amber-300'}`}>
          {check?.message ?? 'Choose the folder that contains tools\launch.ps1 and tools\stop.ps1.'}
        </p>

        {check && (
          <div className="flex flex-wrap gap-2 text-[11px]">
            <span className={`chip ${check.exists ? 'chip-ok' : 'chip-bad'}`}>
              {check.exists ? 'folder found' : 'no folder'}
            </span>
            <span className={`chip ${check.hasLaunchScript ? 'chip-ok' : 'chip-bad'}`}>
              {check.hasLaunchScript ? 'launch.ps1' : 'no launch.ps1'}
            </span>
            <span className={`chip ${check.hasStopScript ? 'chip-ok' : 'chip-bad'}`}>
              {check.hasStopScript ? 'stop.ps1' : 'no stop.ps1'}
            </span>
          </div>
        )}

        <details className="text-xs">
          <summary className="cursor-pointer text-slate-500 hover:text-slate-300">Type the path instead</summary>
          <div className="mt-2 flex gap-2">
            <input
              className="input font-mono"
              placeholder="C:\code\agentcraft"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              disabled={busy}
            />
            <button
              type="button"
              className="btn flex-none"
              disabled={busy || !manual.trim()}
              onClick={() => {
                onValidate(manual.trim());
                setManual('');
              }}
            >
              Use
            </button>
          </div>
        </details>
      </div>
    </section>
  );
}