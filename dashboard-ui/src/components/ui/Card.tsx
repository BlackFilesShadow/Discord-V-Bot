import { type HTMLAttributes, type ReactNode } from 'react';
import { twMerge } from 'tailwind-merge';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  /** glassmorphism + dezenter Top-Highlight */
  glow?: boolean;
  /** Hover-Border-Akzent (Default an) */
  interactive?: boolean;
}

export function Card({ className, children, glow = false, interactive = true, ...rest }: CardProps) {
  return (
    <div
      {...rest}
      className={twMerge(
        'card-premium p-5 anim-rise',
        glow && 'bg-card-gradient',
        !interactive && 'hover:!border-white/[0.06] hover:!shadow-card',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={twMerge('mb-4 flex items-center gap-3', className)}>{children}</div>;
}

export function CardTitle({ className, children }: { className?: string; children: ReactNode }) {
  return <h3 className={twMerge('text-base sm:text-lg font-semibold text-white tracking-tight', className)}>{children}</h3>;
}

export function CardDesc({ className, children }: { className?: string; children: ReactNode }) {
  return <p className={twMerge('text-xs text-muted', className)}>{children}</p>;
}
