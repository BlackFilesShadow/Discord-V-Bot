import { type ReactNode } from 'react';
import { twMerge } from 'tailwind-merge';

export type BadgeVariant = 'ok' | 'warn' | 'danger' | 'info' | 'neutral';

interface BadgeProps {
  variant?: BadgeVariant;
  children: ReactNode;
  className?: string;
  /** Optional: kleines Glow + Animations-Indikator (z. B. live). */
  pulse?: boolean;
}

const cls: Record<BadgeVariant, string> = {
  ok: 'pill-glow-ok',
  warn: 'pill-glow-warn',
  danger: 'pill-glow-danger',
  info: 'pill-glow-info',
  neutral: 'pill-glow-neutral',
};

export function Badge({ variant = 'neutral', children, className, pulse }: BadgeProps) {
  return (
    <span
      className={twMerge(
        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10.5px] font-medium tracking-wide',
        cls[variant],
        className,
      )}
    >
      {pulse && (
        <span className="relative inline-flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full rounded-full bg-current opacity-60 animate-ping" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
        </span>
      )}
      {children}
    </span>
  );
}
