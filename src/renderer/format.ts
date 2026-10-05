/** Small formatting helpers shared by the panels. */

export function formatClock(at: number): string {
  if (!at) return '--:--:--';
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '--';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

export function formatSince(at: number, now: number): string {
  if (!at) return 'never';
  return `${formatDuration(now - at)} ago`;
}

export function shortenPath(value: string, keep = 2): string {
  if (!value) return '';
  const parts = value.split('\\').filter(Boolean);
  if (parts.length <= keep) return value;
  return `…\\${parts.slice(-keep).join('\\')}`;
}