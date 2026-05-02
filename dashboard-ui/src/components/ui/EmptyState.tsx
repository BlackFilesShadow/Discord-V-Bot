import { type ReactNode } from 'react';
import { twMerge } from 'tailwind-merge';
import { Inbox } from 'lucide-react';

interface EmptyStateProps {
  icon?: typeof Inbox;
  title: string;
  desc?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon: Icon = Inbox, title, desc, action, className }: EmptyStateProps) {
  return (
    <div
      className={twMerge(
        'flex flex-col items-center justify-center text-center px-6 py-12 rounded-xl border border-dashed border-white/10 bg-white/[0.015]',
        className,
      )}
    >
      <div className="relative mb-3">
        <span className="absolute inset-0 rounded-full bg-accent/10 blur-2xl" aria-hidden="true" />
        <Icon className="relative h-8 w-8 text-muted" />
      </div>
      <h3 className="text-sm font-semibold text-white">{title}</h3>
      {desc && <p className="text-xs text-muted mt-1.5 max-w-sm">{desc}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
