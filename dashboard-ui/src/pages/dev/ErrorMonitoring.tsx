/**
 * Error Monitoring — P4.
 * Aggregierte Fehler-Counter (prom-client) + letzte error-Log-Lines.
 * Backend: GET /api/v2/dev/stubs/errors.
 */
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useDevStatus } from '@/lib/useDevStatus';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatCard } from '@/components/ui/StatCard';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { DataTable, type Column } from '@/components/ui/Table';

interface SourceCount { source: string; count: number }
interface LogEntry { ts: number; level: string; message: string; meta?: string }
interface ErrorPayload {
  bySource: SourceCount[]; totalCount: number;
  recent: LogEntry[]; webhookEnabled: boolean; generatedAt: string;
}

export default function Page(): JSX.Element {
  const { data, loading, error, reload } = useDevStatus<ErrorPayload>('/api/v2/dev/stubs/errors', 15_000);

  const cols: Column<SourceCount>[] = [
    { id: 'source', header: 'Source', cell: r => <span className="font-mono">{r.source}</span> },
    { id: 'count', header: 'Errors', numeric: true, cell: r => r.count },
  ];

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Error Monitoring"
        desc="Live-Fehler aus errorSink + Prom-Counter."
        icon={<AlertTriangle className="h-5 w-5" />}
        actions={<Button variant="ghost" onClick={() => void reload()} disabled={loading}><RefreshCw className="h-4 w-4 mr-1" />Refresh</Button>}
      />
      {error && !data && <EmptyState title="Fehler beim Laden" desc={error} />}
      {!data && !error ? <Skeleton className="h-32" /> : !data ? null : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <StatCard label="Errors gesamt" value={data.totalCount} accent={data.totalCount > 0 ? 'danger' : 'ok'} />
            <StatCard label="Quellen" value={data.bySource.length} />
            <StatCard label="Webhook" value={data.webhookEnabled ? 'aktiv' : 'aus'} accent={data.webhookEnabled ? 'ok' : 'neutral'} />
          </div>
          <Card>
            <CardHeader><CardTitle>Errors pro Quelle</CardTitle><CardDesc>Counter laufen seit Bot-Start.</CardDesc></CardHeader>
            {data.bySource.length === 0 ? <EmptyState title="Keine Errors registriert" />
              : <DataTable rows={data.bySource} columns={cols} rowKey={r => r.source} />}
          </Card>
          <Card>
            <CardHeader><CardTitle>Letzte Error-Logs</CardTitle><CardDesc>Aus dem In-Memory-Ring (max 200).</CardDesc></CardHeader>
            {data.recent.length === 0 ? <EmptyState title="Keine Eintraege" />
              : (
                <div className="max-h-96 overflow-auto rounded border border-zinc-800 bg-zinc-950 font-mono text-xs">
                  {data.recent.map((l, i) => (
                    <div key={i} className="border-b border-zinc-900 px-2 py-1">
                      <span className="text-zinc-500">{new Date(l.ts).toISOString().slice(11, 23)} </span>
                      <Badge variant="danger">{l.level}</Badge>
                      <span className="ml-2 text-zinc-200">{l.message}</span>
                      {l.meta && <span className="text-zinc-500"> {l.meta}</span>}
                    </div>
                  ))}
                </div>
              )}
          </Card>
        </>
      )}
    </div>
  );
}
