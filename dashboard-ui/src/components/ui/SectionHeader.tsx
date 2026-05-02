import { type ReactNode } from 'react';
import { twMerge } from 'tailwind-merge';

interface SectionHeaderProps {
  title: string;
  desc?: string;
  /** Rechte Action-Slot (z. B. Buttons). */
  actions?: ReactNode;
  /** Optional: Eyebrow ueber dem Titel (z. B. Kategorie). */
  eyebrow?: string;
  /** Optional: Icon links vom Titel. */
  icon?: ReactNode;
  className?: string;
}

export function SectionHeader({ title, desc, actions, eyebrow, icon, className }: SectionHeaderProps) {
  return (
    <div className={twMerge('flex items-start justify-between gap-4 mb-5', className)}>
      <div className="min-w-0">
        {eyebrow && (
          <div className="text-[10px] uppercase tracking-[0.18em] text-accent/90 font-semibold mb-1.5">{eyebrow}</div>
        )}
        <h1 className="text-lg sm:text-xl font-semibold text-white tracking-tight inline-flex items-center gap-2">
          {icon}{title}
        </h1>
        {desc && <p className="text-xs sm:text-sm text-muted mt-1 max-w-2xl">{desc}</p>}
      </div>
      {actions && <div className="shrink-0 flex items-center gap-2">{actions}</div>}
    </div>
  );
}
