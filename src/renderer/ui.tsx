import type { ReactNode } from 'react';
import type { ValidationIssue } from '../shared/types';

/* -------------------------------------------------------------------------- */
/* Primitives                                                                  */
/* -------------------------------------------------------------------------- */

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className = '',
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel flex min-h-0 flex-col ${className}`}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-3 border-b border-edge px-4 py-3">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold text-slate-100">{title}</h2>}
            {subtitle && <p className="mt-0.5 truncate text-xs text-slate-400">{subtitle}</p>}
          </div>
          {actions && <div className="flex flex-none items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="min-h-0 flex-1 p-4">{children}</div>
    </section>
  );
}

export function Switch({
  checked,
  disabled,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange(next: boolean): void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="switch" title={hint}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        {label}
        {hint && <span className="ml-1 text-[11px] text-slate-500">{hint}</span>}
      </span>
    </label>
  );
}

export function TextField({
  value,
  onChange,
  placeholder,
  type = 'text',
  disabled,
  mono,
}: {
  value: string;
  onChange(next: string): void;
  placeholder?: string;
  type?: string;
  disabled?: boolean;
  mono?: boolean;
}) {
  return (
    <input
      className={`input ${mono ? 'font-mono' : ''}`}
      value={value}
      type={type}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function Chip({ tone, children }: { tone: 'ok' | 'warn' | 'bad' | 'plain'; children: ReactNode }) {
  const cls = tone === 'plain' ? '' : `chip-${tone}`;
  return <span className={`chip ${cls}`}>{children}</span>;
}

export function Dot({ tone }: { tone: 'ok' | 'warn' | 'bad' | 'idle' }) {
  const color =
    tone === 'ok' ? 'bg-emerald-400' : tone === 'warn' ? 'bg-amber-400' : tone === 'bad' ? 'bg-rose-400' : 'bg-slate-600';
  return <span className={`inline-block h-2 w-2 flex-none rounded-full ${color}`} aria-hidden="true" />;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

export function IssueList({ issues }: { issues: ValidationIssue[] }) {
  if (!issues.length) return null;
  return (
    <ul className="mt-2 space-y-1">
      {issues.map((issue, index) => (
        <li
          key={`${issue.field}-${index}`}
          className={`flex items-start gap-2 text-xs ${issue.severity === 'error' ? 'text-rose-300' : 'text-amber-300'}`}
        >
          <span className="mt-0.5 flex-none">
            {issue.severity === 'error' ? '✕' : '!'}
          </span>
          <span>{issue.message}</span>
        </li>
      ))}
    </ul>
  );
}

export function Row({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-xs">
      <span className="flex-none text-slate-500">{label}</span>
      <span className={`truncate text-right text-slate-200 ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}