import { Database, RefreshCw, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useDevStatus } from '@/lib/useDevStatus';

interface DbStatus {
  ok: boolean;
  pingMs: number;
  pingError?: string;
  sizePretty: string | null;
  sizeBytes: number | null;
  migrationsApplied: number;
  connections: Array<{ state: string; count: number }>;
  topTables: Array<{ name: string; liveRows: number; deadRows: number }>;
}

export default function DatabaseStatus() {
  const { data, loading, error, reload, lastFetchedAt } = useDevStatus<DbStatus>('/api/v2/dev/status/database', 15000);

  return (
    <div className="space-y-4">
      <Card glow>
        <CardHeader>
          <CardTitle><Database className="h-4 w-4 inline mr-1 text-accent" /> Datenbank Status</CardTitle>
          <CardDesc>Postgres-Health, Pool, Migrations, Top-Tabellen.</CardDesc>
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
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
              <Stat label="Health" value={data.ok ? <span className="text-ok">OK</span> : <span className="text-danger">FEHLER</span>} icon={data.ok ? <CheckCircle2 className="h-3.5 w-3.5 text-ok" /> : <AlertTriangle className="h-3.5 w-3.5 text-danger" />} />
              <Stat label="Ping" value={`${data.pingMs} ms`} />
              <Stat label="DB-Groesse" value={data.sizePretty ?? '?'} />
              <Stat label="Migrations" value={data.migrationsApplied} />
            </div>
            {data.pingError && <div className="text-xs text-danger mt-2">Ping-Fehler: {data.pingError}</div>}
          </Card>

          <Card>
            <CardHeader><CardTitle>Verbindungen</CardTitle></CardHeader>
            <table className="w-full text-xs">
              <thead className="text-muted"><tr><th className="text-left">Status</th><th className="text-right">Anzahl</th></tr></thead>
              <tbody>
                {data.connections.map(c => (
                  <tr key={c.state ?? 'null'} className="border-t border-border/20">
                    <td className="py-1 font-mono">{c.state ?? '(idle in transaction)'}</td>
                    <td className="text-right">{c.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card>
            <CardHeader><CardTitle>Top 25 Tabellen</CardTitle><CardDesc>Sortiert nach Live-Rows. Hohe Dead-Rows = VACUUM noetig.</CardDesc></CardHeader>
            <table className="w-full text-xs">
              <thead className="text-muted"><tr><th className="text-left">Tabelle</th><th className="text-right">Live</th><th className="text-right">Dead</th></tr></thead>
              <tbody>
                {data.topTables.map(t => (
                  <tr key={t.name} className="border-t border-border/20">
                    <td className="py-1 font-mono">{t.name}</td>
                    <td className="text-right">{t.liveRows.toLocaleString()}</td>
                    <td className={`text-right ${t.deadRows > t.liveRows * 0.2 ? 'text-warn' : 'text-muted'}`}>{t.deadRows.toLocaleString()}</td>
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

function Stat({ label, value, icon }: { label: string; value: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border/30 px-2 py-1.5">
      <div className="text-[10px] text-muted uppercase tracking-wide flex items-center gap-1">{icon}{label}</div>
      <div className="text-base font-semibold">{value}</div>
    </div>
  );
}
