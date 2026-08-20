/**
 * Pinned-Tools-Quick-Row.
 *
 * Zeigt bis zu 8 angepinnte DEV-Tools in einer kompakten Reihe ueber
 * dem Sidebar-Menue. Navigation und Entpinnen sind getrennte Controls.
 */
import { Link } from 'react-router-dom';
import { Pin, X } from 'lucide-react';
import { findTool } from '@/lib/devToolsCatalog';
import { usePinnedTools } from '@/lib/pinnedTools';

export function PinnedToolsRow() {
  const { pinned, toggle } = usePinnedTools();
  if (pinned.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 px-2 text-[10px] uppercase tracking-widest text-muted">
        <Pin className="h-3 w-3" /> Pinned
      </div>
      <ul className="space-y-1" aria-label="Angepinnte DEV Tools">
        {pinned.map(slug => {
          const t = findTool(slug);
          if (!t) return null;
          const Icon = t.icon;
          return (
            <li key={slug} className="group flex items-stretch gap-1">
              <Link
                to={`/dev/${slug}`}
                className="flex min-h-11 md:min-h-8 flex-1 min-w-0 items-center gap-2 px-2.5 py-1.5 rounded-md text-xs text-muted hover:text-white hover:bg-bg-elev/60 focus-ring"
              >
                <Icon className="h-3.5 w-3.5 text-accent/70 shrink-0" />
                <span className="truncate flex-1">{t.label}</span>
              </Link>
              <button
                type="button"
                onClick={() => toggle(slug)}
                className="inline-flex min-h-11 min-w-11 md:min-h-8 md:min-w-8 items-center justify-center opacity-100 md:opacity-0 md:group-hover:opacity-100 text-muted hover:text-danger rounded focus-ring"
                aria-label={`${t.label} entpinnen`}
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
