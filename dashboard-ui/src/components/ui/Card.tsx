import { type HTMLAttributes, type ReactNode } from 'react';
import { twMerge } from 'tailwind-merge';

export function Card({ className, children, ...rest }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return (
    <div
      {...rest}
      className={twMerge(
        'bg-bg-card border border-border rounded-lg p-5 hover:border-accent/40 transition-colors',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={twMerge('mb-3 flex items-center gap-3', className)}>{children}</div>;
}

export function CardTitle({ className, children }: { className?: string; children: ReactNode }) {
  return <h3 className={twMerge('text-lg font-semibold text-white', className)}>{children}</h3>;
}
