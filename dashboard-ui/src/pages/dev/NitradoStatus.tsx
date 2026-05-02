import { Server, RefreshCw, AlertTriangle } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useDevStatus } from '@/lib/useDevStatus';

interface NitradoStatus {
  counts: Record<string, number>;
  queryMs: number;
  recentFailures: Array<{ id: string; operation: string; guildId: string; status: string; attempts: number; lastError: string | null; updatedAt: string }>;
  oldestPendingAt: string | null;
  oldestPendingAgeSec: number | null;
}

const STATUS_COLORS: Record<string, string> = {
  PENDING: 'text-warn', RUNNING: 'text-accent', DONE: 'text-ok', FAILED: 'text-danger', DEAD: 'text-danger',
};

export default function NitradoStatus() {
  const { data, loading, error, reload, lastFetchedAt } = useDevStatus<NitradoStatus>('/api/v2/dev/status/nitrado', 15000);

  return (
    <div className="space-y-4">
      <Card glow>
        <CardHeader>
          <CardTitle><Server className="h-4 w-4 inline mr-1 text-accent" /> Nitrado API Status</CardTitle>
          <CardDesc>NitradoJob-Outbox-Statistik (Worker-Backlog, Fehler).</CardDesc>
        </CardHeader>
        <Button variant="ghost" size="sm" onClick={reload} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 mr-1 ${loading ? 'animate-spin' : ''}`} /> Aktualisieren
        </Button>
        {lastFetchedAt && <span className="ml-2 text-[11px] text-muted">Stand: {lastFetchedAt.toLocaleTimeString()}</span>}
      </Card>

      {error && <Card><div role="alert" className="text-xs text-danger flex gap-2"><AlertTriangle className="h-3.5 w-3.5 mt-0.5" /> {error}</div></Card>}

      {data && (
        <>
          <Card>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
              {(['PENDING', 'RUNNING', 'DONE', 'FAILED', 'DEAD'] as const).map(k => (
                <div key={k} className="rounded-md border border-border/30 px-2 py-1.5">
                  <div className={`text-[10px] uppercase ${STATUS_COLORS[k]}`}>{k}</div>
                  <div className="text-base font-semibold">{data.counts[k] ?? 0}</div>
                </div>
              ))}
            </div>
            {data.oldestPendingAgeSec != null && (
              <div className="mt-3 text-xs">
                Aeltester PENDING-Job: <strong>{Math.floor(data.oldestPendingAgeSec / 60)} min</strong>
                {data.oldestPendingAgeSec > 600 && <span className="text-warn ml-2">⚠ Worker hinkt nach</span>}
              </div>
            )}
          </Card>

          <Card>
            <CardHeader><CardTitle>Letzte Fehler</CardTitle></CardHeader>
            <table className="w-full text-xs">
              <thead className="text-muted"><tr><th className="text-left">Operation</th><th className="text-left">Guild</th><th className="text-left">Status</th><th className="text-right">Versuche</th><th className="text-left">Fehler</th></tr></thead>
              <tbody>
                {data.recentFailures.length === 0 && <tr><td colSpan={5} className="text-muted py-2">Keine Fehler.</td></tr>}
                {data.recentFailures.map(f => (
                  <tr key={f.id} className="border-t border-border/20">
                    <td className="py-1 font-mono">{f.operation}</td>
                    <td className="font-mono text-muted">{f.guildId.slice(0, 10)}…</td>
                    <td className={STATUS_COLORS[f.status] ?? ''}>{f.status}</td>
                    <td className="text-right">{f.attempts}</td>
                    <td className="text-danger break-all">{f.lastError ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  );
}
