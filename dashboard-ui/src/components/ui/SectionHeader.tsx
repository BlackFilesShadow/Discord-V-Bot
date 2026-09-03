import { type ReactNode } from 'react';
import { twMerge } from 'tailwind-merge';
import { FunctionHelpButton } from './FunctionHelpButton';

interface SectionHeaderProps {
  title: string;
  desc?: string;
  /** Rechte Action-Slot (z. B. Buttons). */
  actions?: ReactNode;
  /** Optional: Eyebrow ueber dem Titel (z. B. Kategorie). */
  eyebrow?: string;
  /** Optional: Icon links vom Titel. */
  icon?: ReactNode;
  /** Kurze Erklärung, die über den Hilfe-Button neben dem Titel erreichbar ist. */
  help?: string[];
  className?: string;
}

export function SectionHeader({ title, desc, actions, eyebrow, icon, help, className }: SectionHeaderProps) {
  const helpText = help ?? [desc ?? 'Hier findest du die Einstellungen und Aktionen für diesen Bereich.'];

  return (
    <div className={twMerge('flex flex-col items-start justify-between gap-4 mb-5 sm:flex-row', className)}>
      <div className="min-w-0">
        {eyebrow && (
          <div className="text-[10px] uppercase tracking-[0.18em] text-accent/90 font-semibold mb-1.5">{eyebrow}</div>
        )}
        <div className="flex max-w-full min-w-0 items-center gap-2">
          <h1 className="min-w-0 break-words text-lg sm:text-xl font-semibold text-white tracking-tight">
            {icon}{title}
          </h1>
          <FunctionHelpButton title={title} text={helpText} />
        </div>
        {desc && <p className="text-xs sm:text-sm text-muted mt-1 max-w-2xl">{desc}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
