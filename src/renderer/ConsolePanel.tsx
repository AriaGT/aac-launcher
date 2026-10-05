import { useEffect, useRef } from 'react';
import type { ConsoleLine } from '../shared/types';
import { formatClock } from './format';

const STREAM_CLASS: Record<ConsoleLine['stream'], string> = {
  command: 'text-sky-300',
  stdout: 'text-slate-200',
  stderr: 'text-rose-300',
  system: 'text-slate-400 italic',
  result: 'text-emerald-300',
};

export function ConsolePanel({
  lines,
  truncated,
  onClear,
}: {
  lines: ConsoleLine[];
  truncated: boolean;
  onClear(): void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Follow the tail only while the user is already at the bottom.
  useEffect(() => {
    const node = scroller.current;
    if (!node || !pinned.current) return;
    node.scrollTop = node.scrollHeight;
  }, [lines]);

  const onScroll = () => {
    const node = scroller.current;
    if (!node) return;
    pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
  };

  return (
    <section className="panel flex min-h-0 flex-1 flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-edge px-4 py-2">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-semibold text-slate-100">Console</h2>
          <span className="text-[11px] text-slate-500">{lines.length} lines</span>
          {truncated && <span className="text-[11px] text-amber-400">older lines dropped</span>}
        </div>
        <button type="button" className="btn px-2 py-1 text-xs" onClick={onClear}>
          Clear
        </button>
      </header>

      <div
        ref={scroller}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto bg-[#070c18] px-3 py-2 font-mono text-[11.5px] leading-[1.55]"
      >
        {lines.length === 0 ? (
          <p className="px-1 py-2 text-slate-600">
            Nothing yet. Start AgentCraft and its script output appears here.
          </p>
        ) : (
          lines.map((line) => (
            <div key={line.id} className="flex gap-2 whitespace-pre-wrap break-all">
              <span className="flex-none text-slate-700">{formatClock(line.at)}</span>
              <span className={`flex-1 ${STREAM_CLASS[line.stream]}`}>{line.text}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}