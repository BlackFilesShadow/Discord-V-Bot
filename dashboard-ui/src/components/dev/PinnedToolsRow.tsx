/**
 * Pinned-Tools-Quick-Row.
 *
 * Zeigt bis zu 8 angepinnte DEV-Tools in einer kompakten Reihe ueber
 * dem Sidebar-Menue. Klick navigiert direkt; X entpinnt.
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
      <ul className="space-y-1">
        {pinned.map(slug => {
          const t = findTool(slug);
          if (!t) return null;
          const Icon = t.icon;
          return (
            <li key={slug} className="group">
              <Link
                to={`/dev/${slug}`}
                className="flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs text-muted hover:text-white hover:bg-bg-elev/60 focus-ring"
              >
                <Icon className="h-3.5 w-3.5 text-accent/70 shrink-0" />
                <span className="truncate flex-1">{t.label}</span>
                <button
                  type="button"
                  onClick={e => { e.preventDefault(); e.stopPropagation(); toggle(slug); }}
                  className="opacity-0 group-hover:opacity-100 text-muted hover:text-danger p-0.5 rounded focus-ring"
                  aria-label={`${t.label} entpinnen`}
                >
                  <X className="h-3 w-3" />
                </button>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
