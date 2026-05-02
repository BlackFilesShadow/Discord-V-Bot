/**
 * Audit Logs — P4.
 * Globale Volltext-Suche im AuditLog (pg_trgm-Index).
 * Backend: GET /api/v2/dev/observability/audit/search
 */
import { useEffect, useState, useCallback } from 'react';
import { ScrollText, Search, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { DataTable, type Column } from '@/components/ui/Table';

interface AuditEntry {
  id: string; action: string; category: string; guildId: string | null;
  createdAt: string;
  actor: { discordId: string; username: string } | null;
  target: { discordId: string; username: string } | null;
  channelId: string | null; ipAddress: string | null;
  details: unknown;
}
interface SearchResp { entries: AuditEntry[]; limit: number; hasMore: boolean }

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
  const toast = useToast();

  const search = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (q.trim()) params.set('q', q.trim());
      if (category) params.set('category', category);
      if (guildId.trim()) params.set('guildId', guildId.trim());
      setData(await api.get<SearchResp>(`/api/v2/dev/observability/audit/search?${params.toString()}`));
    } catch (e) {
      toast.push({ variant: 'danger', title: 'Suche fehlgeschlagen', desc: (e as Error).message });
    } finally { setLoading(false); }
  }, [q, category, guildId, toast]);

  useEffect(() => { void search(); /* initial */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cols: Column<AuditEntry>[] = [
    { id: 'when', header: 'Zeit', cell: r => <span className="text-xs">{new Date(r.createdAt).toLocaleString()}</span> },
    { id: 'cat', header: 'Cat', cell: r => <Badge variant="info">{r.category}</Badge> },
    { id: 'a', header: 'Action', cell: r => <span className="font-mono text-xs">{r.action}</span> },
    { id: 'actor', header: 'Actor', cell: r => r.actor ? <span className="text-xs">{r.actor.username}</span> : '-' },
    { id: 'guild', header: 'Guild', cell: r => <span className="font-mono text-[10px]">{r.guildId ?? '-'}</span> },
    { id: 'ip', header: 'IP', cell: r => <span className="font-mono text-[10px]">{r.ipAddress ?? '-'}</span> },
  ];

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Audit Logs"
        desc="Volltextsuche ueber alle AuditLog-Eintraege (pg_trgm)."
        icon={<ScrollText className="h-5 w-5" />}
      />
      <Card>
        <CardHeader><CardTitle>Filter</CardTitle><CardDesc>q ist case-insensitiv auf action.</CardDesc></CardHeader>
        <div className="flex flex-wrap gap-2">
          <input
            value={q} onChange={e => setQ(e.target.value)}
            placeholder="Substring (min. 2)"
            className="flex-1 min-w-[200px] rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
            onKeyDown={e => { if (e.key === 'Enter') void search(); }}
          />
          <select value={category} onChange={e => setCategory(e.target.value)} className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm">
            {CATEGORIES.map(c => <option key={c} value={c}>{c || 'alle Kategorien'}</option>)}
          </select>
          <input
            value={guildId} onChange={e => setGuildId(e.target.value)}
            placeholder="GuildId (optional)"
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm font-mono"
          />
          <Button onClick={() => void search()} disabled={loading}>
            <Search className="h-4 w-4 mr-1" /> Suchen
          </Button>
          <Button variant="ghost" onClick={() => void search()} disabled={loading}>
            <RefreshCw className="h-4 w-4 mr-1" /> Refresh
          </Button>
        </div>
      </Card>
      <Card>
        <CardHeader><CardTitle>Treffer</CardTitle><CardDesc>{data ? `${data.entries.length} Treffer (limit ${data.limit}${data.hasMore ? ', mehr verfuegbar' : ''})` : ''}</CardDesc></CardHeader>
        {!data ? <Skeleton className="h-32" />
          : data.entries.length === 0 ? <EmptyState title="Keine Treffer" />
            : <DataTable rows={data.entries} columns={cols} rowKey={r => r.id} />}
      </Card>
    </div>
  );
}
