import { type ReactNode } from 'react';
import { twMerge } from 'tailwind-merge';

interface StatCardProps {
  label: string;
  value: ReactNode;
  /** Akzentfarbe fuer den Wert (Default: white). */
  accent?: 'ok' | 'warn' | 'danger' | 'info' | 'neutral';
  /** Optional: Vorzeichen-Indikator (Trend). */
  delta?: { value: string; positive: boolean };
  /** Optional: Icon links. */
  icon?: ReactNode;
  className?: string;
}

const accentCls: Record<NonNullable<StatCardProps['accent']>, string> = {
  ok:      'text-ok',
  warn:    'text-warn',
  danger:  'text-danger',
  info:    'text-info',
  neutral: 'text-white',
};

export function StatCard({ label, value, accent = 'neutral', delta, icon, className }: StatCardProps) {
  return (
    <div className={twMerge('card-premium p-4', className)}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-[10px] uppercase tracking-widest text-muted">{label}</span>
        {icon && <span className="text-muted">{icon}</span>}
      </div>
      <div className={twMerge('text-2xl font-semibold tabular-nums tracking-tight', accentCls[accent])}>{value}</div>
      {delta && (
        <div className={twMerge(
          'mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium tabular-nums',
          delta.positive ? 'text-ok' : 'text-danger',
        )}>
          {delta.positive ? '▲' : '▼'} {delta.value}
        </div>
      )}
    </div>
  );
}
