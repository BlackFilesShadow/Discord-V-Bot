import { useState, type ReactNode } from 'react';
import { twMerge } from 'tailwind-merge';

export interface Tab {
  id: string;
  label: string;
  /** Optional: Badge-Inhalt (Count etc.) */
  badge?: ReactNode;
}

interface TabsProps {
  tabs: ReadonlyArray<Tab>;
  /** Controlled (optional). */
  value?: string;
  /** Default-Tab fuer uncontrolled Mode. */
  defaultValue?: string;
  onChange?: (id: string) => void;
  className?: string;
  children: (activeId: string) => ReactNode;
}

export function Tabs({ tabs, value, defaultValue, onChange, className, children }: TabsProps) {
  const [internal, setInternal] = useState(defaultValue ?? tabs[0]?.id ?? '');
  const active = value ?? internal;

  const setActive = (id: string): void => {
    if (value === undefined) setInternal(id);
    onChange?.(id);
  };

  return (
    <div className={className}>
      <div role="tablist" className="flex items-center gap-1 border-b border-white/[0.06] mb-4 -mx-1 px-1 overflow-x-auto">
        {tabs.map(t => {
          const isActive = t.id === active;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={isActive}
              onClick={() => setActive(t.id)}
              type="button"
              className={twMerge(
                'relative inline-flex items-center gap-2 px-3 py-2 text-xs font-medium transition-colors focus-ring rounded-t-md',
                isActive ? 'text-white' : 'text-muted hover:text-white',
              )}
            >
              {t.label}
              {t.badge !== undefined && (
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-white/[0.06] text-muted">{t.badge}</span>
              )}
              {isActive && (
                <span className="absolute left-2 right-2 -bottom-px h-px bg-gradient-to-r from-transparent via-accent to-transparent shadow-[0_0_8px_rgba(239,68,68,0.6)]" />
              )}
            </button>
          );
        })}
      </div>
      <div role="tabpanel">{children(active)}</div>
    </div>
  );
}
