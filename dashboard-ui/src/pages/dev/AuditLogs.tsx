/**
 * Audit Logs — Dashboard-2E hardened global DEV audit search.
 * Backend: GET /api/v2/dev/observability/audit/search
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { AlertTriangle, ScrollText, Search, RefreshCw } from 'lucide-react';
import { api, describeApiError } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { DataTable, type Column } from '@/components/ui/Table';

interface AuditEntry {
  id: string;
  action: string;
  category: string;
  guildId: string | null;
  createdAt: string;
  actor: { discordId: string; username: string } | null;
  target: { discordId: string; username: string } | null;
  channelId: string | null;
  ipAddress: string | null;
  details: unknown;
}

interface SearchResp {
  entries: AuditEntry[];
  limit: number;
  hasMore: boolean;
  nextCursor: string | null;
}

interface AppliedFilters {
  q: string;
  category: string;
  guildId: string;
}

const CATEGORIES = ['', 'AUTH', 'SECURITY', 'ADMIN', 'SYSTEM', 'CONFIG', 'GDPR', 'AI',
  'TICKET', 'NITRADO', 'ECONOMY', 'CASINO', 'DASHBOARD', 'WHITELIST', 'FACTION',
  'MODERATION', 'GIVEAWAY', 'LEVEL', 'ROLE', 'POLL', 'UPLOAD', 'DOWNLOAD',
  'REGISTRATION', 'FEED', 'APPEAL', 'SERVER_SETTINGS'];

export default function Page(): JSX.Element {
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [guildId, setGuildId] = useState('');
  const [data, setData] = useState<SearchResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const appliedFilters = useRef<AppliedFilters>({ q: '', category: '', guildId: '' });
  const requestSeq = useRef(0);
  const toast = useToast();

  const search = useCallback(async (cursor?: string, append = false) => {
    const requestId = ++requestSeq.current;
    const filters = append
      ? appliedFilters.current
      : { q: q.trim(), category, guildId: guildId.trim() };

    if (!append) appliedFilters.current = filters;
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({ limit: '50' });
      if (filters.q) params.set('q', filters.q);
      if (filters.category) params.set('category', filters.category);
      if (filters.guildId) params.set('guildId', filters.guildId);
      if (cursor) params.set('cursor', cursor);

      const next = await api.get<SearchResp>(`/api/v2/dev/observability/audit/search?${params.toString()}`);
      if (requestId !== requestSeq.current) return;

      setData(prev => append && prev
        ? {
            ...next,
            entries: [...prev.entries, ...next.entries],
          }
        : next);
    } catch (e) {
      if (requestId !== requestSeq.current) return;
      const described = describeApiError(e);
      // Privilegierte Audit-Snapshots werden nach einem Fehler nicht stale
      // weiter angezeigt. Das entspricht useDevStatus auf den Diagnose-Seiten.
      setData(null);
      setError(described.desc);
      toast.push({ variant: 'danger', title: described.title, desc: described.desc });
    } finally {
      if (requestId === requestSeq.current) setLoading(false);
    }
  }, [q, category, guildId, toast]);

  useEffect(() => {
    void search(); // initial
    // Die Initialsuche soll nur beim Mount laufen; Filter werden bewusst erst
    // durch Suchen/Enter angewendet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cols: Column<AuditEntry>[] = [
    { id: 'when', header: 'Zeit', cell: r => <span className="text-xs">{new Date(r.createdAt).toLocaleString()}</span> },
    { id: 'cat', header: 'Cat', cell: r => <Badge variant="info">{r.category}</Badge> },
    { id: 'a', header: 'Action', cell: r => <span className="font-mono text-xs break-all">{r.action}</span> },
    { id: 'actor', header: 'Actor', cell: r => r.actor ? <span className="text-xs break-words">{r.actor.username}</span> : '-' },
    { id: 'guild', header: 'Guild', cell: r => <span className="font-mono text-[10px] break-all">{r.guildId ?? '-'}</span> },
    { id: 'ip', header: 'IP', cell: r => <span className="font-mono text-[10px] break-all">{r.ipAddress ?? '-'}</span> },
  ];

  return (
    <div className="space-y-6 min-w-0">
      <SectionHeader
        title="Audit Logs"
        desc="Globale DEV-Suche ueber AuditLog-Eintraege. Pagination ist verlustfrei ueber createdAt + id."
        icon={<ScrollText className="h-5 w-5" />}
      />

      <Card>
        <CardHeader>
          <CardTitle>Filter</CardTitle>
          <CardDesc>q sucht case-insensitiv in action (min. 2 Zeichen).</CardDesc>
        </CardHeader>
        <div className="flex flex-wrap gap-2 min-w-0">
          <input
            aria-label="Audit-Suche"
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Substring (min. 2)"
            className="min-h-11 min-w-[200px] flex-1 rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
            onKeyDown={e => { if (e.key === 'Enter') void search(); }}
          />
          <select
            aria-label="Audit-Kategorie"
            value={category}
            onChange={e => setCategory(e.target.value)}
            className="min-h-11 rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
          >
            {CATEGORIES.map(c => <option key={c} value={c}>{c || 'alle Kategorien'}</option>)}
          </select>
          <input
            aria-label="Guild-ID"
            value={guildId}
            onChange={e => setGuildId(e.target.value)}
            placeholder="GuildId (optional)"
            className="min-h-11 min-w-[200px] rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm font-mono"
          />
          <Button onClick={() => void search()} disabled={loading}>
            <Search className="h-4 w-4 mr-1" /> Suchen
          </Button>
          <Button variant="ghost" onClick={() => void search()} disabled={loading}>
            <RefreshCw className="h-4 w-4 mr-1" /> Refresh
          </Button>
        </div>
      </Card>

      {error && (
        <Card>
          <div role="alert" className="flex min-w-0 gap-2 text-sm text-danger">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="break-words">{error}</span>
          </div>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Treffer</CardTitle>
          <CardDesc>{data ? `${data.entries.length} geladen (Seitenlimit ${data.limit}${data.hasMore ? ', mehr verfuegbar' : ''})` : ''}</CardDesc>
        </CardHeader>
        {!data && loading ? <Skeleton className="h-32" />
          : !data ? <EmptyState title="Keine Audit-Daten geladen" />
            : data.entries.length === 0 ? <EmptyState title="Keine Treffer" />
              : <DataTable rows={data.entries} columns={cols} rowKey={r => r.id} />}

        {data?.hasMore && data.nextCursor && (
          <div className="mt-3 flex justify-center">
            <Button
              variant="ghost"
              onClick={() => void search(data.nextCursor ?? undefined, true)}
              disabled={loading}
            >
              Mehr laden
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
