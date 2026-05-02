/**
 * Self-Audit-Widget: zeigt die letzten lokal getrackten User-Aktionen.
 *
 * Komplett client-seitig (sessionStorage). Der echte Audit-Trail bleibt
 * server-seitig in der Audit-DB und ist via /dev/audit-logs einsehbar.
 */
import { useState } from 'react';
import { History, Trash2 } from 'lucide-react';
import { useRecentActions } from '@/lib/recentActions';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { Button } from '@/components/ui/Button';

function rel(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return `${Math.round(diff)}s`;
  if (diff < 3600) return `${Math.round(diff / 60)}m`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h`;
  return `${Math.round(diff / 86400)}d`;
}

export function RecentActionsWidget() {
  const { actions, clear } = useRecentActions();
  const [expanded, setExpanded] = useState(false);
  const items = expanded ? actions : actions.slice(0, 5);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2 flex-1">
          <div>
            <CardTitle><History className="h-4 w-4 inline mr-1.5" /> Recent Actions</CardTitle>
            <CardDesc>Self-Audit-View (sessionStorage). Echter Trail: <span className="font-mono">/dev/audit-logs</span>.</CardDesc>
          </div>
          {actions.length > 0 && (
            <Button variant="ghost" size="sm" onClick={clear} aria-label="Verlauf loeschen">
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </CardHeader>

      {actions.length === 0 ? (
        <EmptyState
          icon={History}
          title="Noch keine Aktionen"
          desc="Sobald du eine sensitive DEV-Aktion ausfuehrst, erscheint sie hier."
        />
      ) : (
        <ul className="divide-y divide-white/[0.04]">
          {items.map((a, i) => (
            <li key={i} className="flex items-center gap-2 py-2">
              <Badge variant={a.severity === 'danger' ? 'danger' : a.severity === 'warn' ? 'warn' : 'info'}>
                {a.kind}
              </Badge>
              <span className="text-xs text-white/85 flex-1 truncate">{a.label}</span>
              <span className="text-[10px] font-mono text-muted">{rel(a.at)}</span>
            </li>
          ))}
        </ul>
      )}

      {actions.length > 5 && !expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-3 text-[11px] text-muted hover:text-white focus-ring rounded"
        >
          Alle {actions.length} anzeigen…
        </button>
      )}
    </Card>
  );
}
