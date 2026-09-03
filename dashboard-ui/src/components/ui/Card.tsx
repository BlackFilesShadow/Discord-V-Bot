import { isValidElement, type HTMLAttributes, type ReactNode } from 'react';
import { twMerge } from 'tailwind-merge';
import { functionHelpFor } from '@/lib/functionHelp';
import { FunctionHelpButton } from './FunctionHelpButton';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  /** glassmorphism + dezenter Top-Highlight */
  glow?: boolean;
  /** Hover-Border-Akzent nur fuer tatsaechlich interaktive Karten. */
  interactive?: boolean;
}

export function Card({ className, children, glow = false, interactive = false, ...rest }: CardProps) {
  return (
    <div
      {...rest}
      data-interactive={interactive || undefined}
      className={twMerge(
        'card-premium p-5 focus-within:z-[60]',
        glow && 'bg-card-gradient anim-rise',
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

function titleText(children: ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(titleText).join(' ');
  if (isValidElement<{ children?: ReactNode }>(children)) return titleText(children.props.children);
  return '';
}

export function CardTitle({ className, children }: { className?: string; children: ReactNode }) {
  const help = functionHelpFor(titleText(children));
  return (
    <div className="inline-flex min-w-0 items-center gap-2">
      <h3 className={twMerge('text-base sm:text-lg font-semibold text-white tracking-tight', className)}>{children}</h3>
      <FunctionHelpButton title={help.title} text={help.text} />
    </div>
  );
}

export function CardDesc({ className, children }: { className?: string; children: ReactNode }) {
  return <p className={twMerge('text-xs text-muted', className)}>{children}</p>;
}
