import type { LucideIcon } from 'lucide-react';

export interface SectionTabItem<T extends string> {
  key: T;
  label: string;
  icon?: LucideIcon;
  badge?: string;
}

export function SectionTabs<T extends string>({
  value,
  items,
  onChange,
  ariaLabel,
}: {
  value: T;
  items: ReadonlyArray<SectionTabItem<T>>;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <nav
      className="flex max-w-full gap-1.5 overflow-x-auto rounded-2xl border border-border/70 bg-bg-card/70 p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] backdrop-blur-sm"
      aria-label={ariaLabel}
    >
      {items.map(item => {
        const active = value === item.key;
        const Icon = item.icon;
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => onChange(item.key)}
            aria-current={active ? 'page' : undefined}
            className={`group relative shrink-0 rounded-xl border px-3.5 py-2 text-sm font-medium transition-all focus-ring ${
              active
                ? 'border-accent/35 bg-accent/15 text-white shadow-[0_10px_28px_-20px_rgb(var(--color-accent-glow)/0.9)]'
                : 'border-transparent text-muted hover:border-border/70 hover:bg-bg-elev/70 hover:text-white'
            }`}
          >
            <span className="inline-flex items-center gap-2 whitespace-nowrap">
              {Icon && <Icon className={`h-4 w-4 ${active ? 'text-accent' : 'text-muted group-hover:text-white'}`} />}
              <span>{item.label}</span>
              {item.badge && (
                <span className={`rounded-md border px-1.5 py-0.5 text-[10px] ${active ? 'border-accent/25 bg-accent/10 text-accent' : 'border-border/60 text-muted'}`}>
                  {item.badge}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
