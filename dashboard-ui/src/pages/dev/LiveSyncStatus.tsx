/**
 * Live Sync Status — P4.
 * Nitrado-Outbox-Aggregate + EconomyLink-Verteilung.
 * Backend: GET /api/v2/dev/stubs/sync.
 */
import { useEffect, useState, useCallback } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatCard } from '@/components/ui/StatCard';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { DataTable, type Column } from '@/components/ui/Table';

interface SyncPayload {
  nitrado: {
    byStatus: { status: string; count: number }[];
    byOperation: { operation: string; count: number }[];
    recentFailed: { id: string; guildId: string; operation: string; attempts: number; lastError: string | null; updatedAt: string }[];
  };
  economyLinks: { byGuild: { guildId: string; count: number }[]; total: number };
  generatedAt: string;
}

const statusBadge = (s: string) => {
  if (s === 'DONE') return <Badge variant="ok">{s}</Badge>;
  if (s === 'PENDING' || s === 'RUNNING') return <Badge variant="info">{s}</Badge>;
  if (s === 'FAILED') return <Badge variant="warn">{s}</Badge>;
  if (s === 'DEAD') return <Badge variant="danger">{s}</Badge>;
  return <Badge>{s}</Badge>;
};

export default function Page(): JSX.Element {
  const [data, setData] = useState<SyncPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const toast = useToast();

  const reload = useCallback(async () => {
    setLoading(true);
    try { setData(await api.get<SyncPayload>('/api/v2/dev/stubs/sync')); }
    catch (e) { toast.push({ variant: 'danger', title: 'Fehler', desc: (e as Error).message }); }
    finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { void reload(); const t = setInterval(() => { void reload(); }, 15_000); return () => clearInterval(t); }, [reload]);

  const statusCols: Column<{ status: string; count: number }>[] = [
    { id: 'status', header: 'Status', cell: r => statusBadge(r.status) },
    { id: 'count', header: 'Jobs', numeric: true, cell: r => r.count },
  ];
  const opCols: Column<{ operation: string; count: number }>[] = [
    { id: 'op', header: 'Operation', cell: r => <span className="font-mono">{r.operation}</span> },
    { id: 'count', header: 'Total', numeric: true, cell: r => r.count },
  ];
  const failCols: Column<SyncPayload['nitrado']['recentFailed'][number]>[] = [
    { id: 'op', header: 'Operation', cell: r => <span className="font-mono">{r.operation}</span> },
    { id: 'guild', header: 'Guild', cell: r => <span className="font-mono text-xs">{r.guildId}</span> },
    { id: 'tries', header: 'Tries', numeric: true, cell: r => r.attempts },
    { id: 'err', header: 'Letzter Fehler', cell: r => <span className="text-xs text-danger truncate inline-block max-w-[400px]">{r.lastError ?? '-'}</span> },
    { id: 'when', header: 'Wann', cell: r => new Date(r.updatedAt).toLocaleString() },
  ];
  const linkCols: Column<{ guildId: string; count: number }>[] = [
    { id: 'guild', header: 'Guild', cell: r => <span className="font-mono text-xs">{r.guildId}</span> },
    { id: 'count', header: 'Links', numeric: true, cell: r => r.count },
  ];

  const totalNitrado = data ? data.nitrado.byStatus.reduce((s, r) => s + r.count, 0) : 0;
  const failed = data ? (data.nitrado.byStatus.find(s => s.status === 'FAILED')?.count ?? 0) : 0;
  const dead = data ? (data.nitrado.byStatus.find(s => s.status === 'DEAD')?.count ?? 0) : 0;
  const pending = data ? (data.nitrado.byStatus.find(s => s.status === 'PENDING')?.count ?? 0) : 0;

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Live Sync Status"
        desc="Nitrado-Outbox + Economy-Link-Bestand pro Guild."
        icon={<RefreshCw className="h-5 w-5" />}
        actions={<Button variant="ghost" onClick={() => void reload()} disabled={loading}><RefreshCw className="h-4 w-4 mr-1" />Refresh</Button>}
      />
      {!data ? <Skeleton className="h-32" /> : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard label="Nitrado-Jobs gesamt" value={totalNitrado} />
            <StatCard label="Pending" value={pending} accent={pending > 50 ? 'warn' : 'neutral'} />
            <StatCard label="Failed" value={failed} accent={failed > 0 ? 'warn' : 'ok'} />
            <StatCard label="Dead" value={dead} accent={dead > 0 ? 'danger' : 'ok'} />
            <StatCard label="EconomyLinks gesamt" value={data.economyLinks.total} accent="info" />
          </div>
          <Card>
            <CardHeader><CardTitle>Outbox nach Status</CardTitle><CardDesc>Aktuelle Verteilung der NitradoJob-Tabelle.</CardDesc></CardHeader>
            {data.nitrado.byStatus.length === 0 ? <EmptyState title="Keine Jobs" />
              : <DataTable rows={data.nitrado.byStatus} columns={statusCols} rowKey={r => r.status} />}
          </Card>
          <Card>
            <CardHeader><CardTitle>Top-Operations</CardTitle><CardDesc>Top 10.</CardDesc></CardHeader>
            {data.nitrado.byOperation.length === 0 ? <EmptyState title="Keine Daten" />
              : <DataTable rows={data.nitrado.byOperation} columns={opCols} rowKey={r => r.operation} />}
          </Card>
          <Card>
            <CardHeader><CardTitle>Letzte fehlgeschlagene Jobs</CardTitle><CardDesc>Top 10 nach Update.</CardDesc></CardHeader>
            {data.nitrado.recentFailed.length === 0 ? <EmptyState title="Aktuell keine Fehler" />
              : <DataTable rows={data.nitrado.recentFailed} columns={failCols} rowKey={r => r.id} />}
          </Card>
          <Card>
            <CardHeader><CardTitle>Economy-Links pro Guild</CardTitle><CardDesc>Top 20.</CardDesc></CardHeader>
            {data.economyLinks.byGuild.length === 0 ? <EmptyState title="Keine Links" />
              : <DataTable rows={data.economyLinks.byGuild} columns={linkCols} rowKey={r => r.guildId} />}
          </Card>
        </>
      )}
    </div>
  );
}
