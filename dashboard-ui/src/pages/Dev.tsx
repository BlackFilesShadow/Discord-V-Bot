/**
 * DEV-Konsole — Layout mit Sidebar (Search + Categories + Pinned + Recent)
 * und geschuetzter DEV-Session.
 */
import { useMemo, useState } from 'react';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import {
  AlertTriangle, Lock, Unlock, LogOut, Search, Star, X as XIcon, TerminalSquare,
} from 'lucide-react';
import { Shell } from '@/components/Shell';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { useAuth } from '@/lib/auth';
import { useDevSession } from '@/lib/devSession';
import { usePinnedTools } from '@/lib/pinnedTools';
import {
  DEV_TOOLS as DEV_TOOLS_CATALOG, CATEGORY_LABEL, CATEGORY_ORDER,
  type DevTool, type DevToolCategory,
} from '@/lib/devToolsCatalog';
import { PinnedToolsRow } from '@/components/dev/PinnedToolsRow';

export type { DevTool } from '@/lib/devToolsCatalog';
export const DEV_TOOLS = DEV_TOOLS_CATALOG;

export default function DevLayout() {
  const { user } = useAuth();
  const dev = useDevSession();

  if (!user || user.role !== 'DEVELOPER') {
    return (
      <Shell title="Dev-Konsole" back="/servers">
        <Card glow className="max-w-md mx-auto"><CardHeader><CardTitle><AlertTriangle className="h-4 w-4 inline mr-1 text-danger" /> Kein Zugriff</CardTitle><CardDesc>Diese Konsole ist auf DEVELOPER-Konten beschraenkt.</CardDesc></CardHeader></Card>
      </Shell>
    );
  }

  // Der sessionStorage-Hinweis ist ausschliesslich optimistisch. Bevor die
  // serverseitige /dev/status-Wahrheit feststeht, darf kein DEV-Tool gerendert
  // und damit auch kein privilegierter Tool-Read angestossen werden.
  if (dev.loading) {
    return (
      <Shell title="Dev-Konsole" back="/servers">
        <Card glow className="max-w-md mx-auto"><CardHeader><CardTitle><Lock className="h-4 w-4 inline mr-1" /> DEV-Status wird geprueft</CardTitle><CardDesc>Die serverseitige DEV-Session wird bestaetigt.</CardDesc></CardHeader></Card>
      </Shell>
    );
  }

  if (!dev.active) {
    return (
      <Shell title="Dev-Konsole" back="/servers">
        <Card glow className="max-w-md mx-auto"><CardHeader><CardTitle><Lock className="h-4 w-4 inline mr-1" /> DEV-Session erforderlich</CardTitle><CardDesc>Bitte melde dich ueber das DEV Login Panel auf der Server-Uebersicht an. Direkter URL-Zugriff ohne aktive Session ist serverseitig blockiert.</CardDesc></CardHeader><a href="/servers" className="inline-block"><Button size="sm">Zur Server-Uebersicht</Button></a></Card>
      </Shell>
    );
  }

  return <Shell title="Dev-Konsole" back="/servers" sidebar={<DevSidebar />}><div className="max-w-content mx-auto"><Outlet /></div></Shell>;
}

function DevSidebar() {
  const dev = useDevSession();
  const loc = useLocation();
  const { isPinned, toggle, pinned } = usePinnedTools();
  const [query, setQuery] = useState('');

  const grouped = useMemo<Array<{ cat: DevToolCategory; items: DevTool[] }>>(() => {
    const q = query.trim().toLowerCase();
    const filter = (t: DevTool): boolean => {
      if (!q) return true;
      return [t.label, t.slug, t.desc, ...(t.keywords ?? [])].join(' ').toLowerCase().includes(q);
    };
    const map = new Map<DevToolCategory, DevTool[]>();
    DEV_TOOLS_CATALOG.filter(filter).forEach(t => { const arr = map.get(t.category) ?? []; arr.push(t); map.set(t.category, arr); });
    return CATEGORY_ORDER.map(cat => ({ cat, items: map.get(cat) ?? [] })).filter(g => g.items.length > 0);
  }, [query]);

  const commandCenterActive = loc.pathname === '/dev/command-center';
  const secureExportActive = loc.pathname === '/dev/secure-export';
  return (
    <nav aria-label="DEV Tools" className="space-y-4">
      <div className="flex items-center justify-between px-1"><span className="text-[10px] uppercase tracking-widest text-muted">DEV Tools</span><Badge variant="ok" pulse><Unlock className="h-3 w-3" /> ON</Badge></div>

      <div className="space-y-1">
        <NavLink to="/dev/command-center" className={[
          'flex min-h-11 md:min-h-9 items-center gap-2.5 px-2.5 py-2 rounded-md text-xs font-semibold transition-colors focus-ring border',
          commandCenterActive ? 'bg-accent/15 text-white border-accent/30' : 'text-accent border-accent/20 hover:bg-accent/10',
        ].join(' ')}>
          <TerminalSquare className="h-4 w-4" /><span>DEV Command Center</span>
        </NavLink>
        <NavLink to="/dev/secure-export" className={[
          'flex min-h-11 md:min-h-9 items-center gap-2.5 px-2.5 py-2 rounded-md text-xs font-semibold transition-colors focus-ring border',
          secureExportActive ? 'bg-accent/15 text-white border-accent/30' : 'text-accent border-accent/20 hover:bg-accent/10',
        ].join(' ')}>
          <Lock className="h-4 w-4" /><span>Sichere Exporte</span>
        </NavLink>
      </div>

      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted" />
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Tools suchen…" className="input-premium w-full h-11 md:h-8 rounded-md text-xs text-white pl-8 pr-11 md:pr-9 placeholder:text-muted/70 focus:outline-none" aria-label="Tools suchen" />
        {query && <button type="button" onClick={() => setQuery('')} className="absolute right-0 top-1/2 -translate-y-1/2 inline-flex h-11 w-11 md:h-8 md:w-8 items-center justify-center text-muted hover:text-white rounded focus-ring" aria-label="Suche leeren"><XIcon className="h-3 w-3" /></button>}
      </div>

      {pinned.length > 0 && !query && <PinnedToolsRow />}

      <div className="space-y-4">
        {grouped.length === 0 && <div className="px-2 py-3 text-[11px] text-muted text-center">Keine Treffer.</div>}
        {grouped.map(group => (
          <div key={group.cat} className="space-y-1">
            <div className="px-2 text-[10px] uppercase tracking-widest text-muted">{CATEGORY_LABEL[group.cat]}</div>
            <ul className="space-y-0.5">
              {group.items.map(t => {
                const Icon = t.icon; const to = `/dev/${t.slug}`; const isActive = loc.pathname === to; const isP = isPinned(t.slug);
                return (
                  <li key={t.slug} className="group flex items-stretch gap-1">
                    <NavLink to={to} className={['relative flex min-h-11 md:min-h-8 flex-1 min-w-0 items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs transition-colors focus-ring', isActive ? 'bg-accent/15 text-white border border-accent/30' : 'text-muted hover:text-white hover:bg-bg-elev/60 border border-transparent'].join(' ')}>
                      <Icon className="h-3.5 w-3.5 shrink-0"/><span className="truncate flex-1">{t.label}</span>{t.status === 'stub' && <span className="text-[9px] uppercase tracking-wider text-muted/70">soon</span>}
                    </NavLink>
                    <button
                      type="button"
                      onClick={() => toggle(t.slug)}
                      className={['inline-flex min-h-11 min-w-11 md:min-h-8 md:min-w-8 items-center justify-center rounded focus-ring transition-colors', isP ? 'text-accent opacity-100' : 'text-muted opacity-100 md:opacity-0 md:group-hover:opacity-100 hover:text-accent'].join(' ')}
                      aria-label={isP ? `${t.label} entpinnen` : `${t.label} pinnen`}
                    >
                      <Star className={`h-3 w-3 ${isP ? 'fill-current' : ''}`}/>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>

      <div className="pt-3 border-t border-border"><Button size="sm" variant="ghost" className="w-full min-h-11 md:min-h-9 justify-start text-muted hover:text-danger" onClick={() => { void dev.logout(); }}><LogOut className="h-3.5 w-3.5" /> DEV-Logout</Button></div>
    </nav>
  );
}
