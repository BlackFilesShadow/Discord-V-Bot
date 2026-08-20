import { Database, RefreshCw, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useDevStatus } from '@/lib/useDevStatus';

interface DbStatus {
  ok: boolean;
  degraded?: boolean;
  pingMs: number;
  pingError?: string | null;
  sizePretty: string | null;
  sizeBytes: number | null;
  migrationsApplied: number | null;
  connections: Array<{ state: string | null; count: number }>;
  topTables: Array<{ name: string; liveRows: number; deadRows: number }>;
  errors?: Record<string, string | null>;
}

export default function DatabaseStatus() {
  const { data, loading, error, reload, lastFetchedAt } = useDevStatus<DbStatus>('/api/v2/dev/status/database', 15000);

  const degradedErrors = data?.errors
    ? Object.entries(data.errors).filter(([, value]) => Boolean(value))
    : [];

  return (
    <div className="space-y-4 min-w-0">
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

      {error && <Card><div role="alert" className="text-xs text-danger flex gap-2 break-words"><AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" /> {error}</div></Card>}

      {data && (
        <>
          {data.degraded && (
            <Card>
              <div role="alert" className="text-xs text-warn flex gap-2 min-w-0">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <div className="font-semibold">Diagnose teilweise nicht verfuegbar.</div>
                  {degradedErrors.map(([key, value]) => (
                    <div key={key} className="break-words"><span className="font-mono">{key}</span>: {value}</div>
                  ))}
                </div>
              </div>
            </Card>
          )}
          <Card>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
              <Stat label="Health" value={data.ok ? <span className="text-ok">OK</span> : <span className="text-danger">FEHLER</span>} icon={data.ok ? <CheckCircle2 className="h-3.5 w-3.5 text-ok" /> : <AlertTriangle className="h-3.5 w-3.5 text-danger" />} />
              <Stat label="Ping" value={`${data.pingMs} ms`} />
              <Stat label="DB-Groesse" value={data.sizePretty ?? '?'} />
              <Stat label="Migrations" value={data.migrationsApplied ?? '?'} />
            </div>
            {data.pingError && <div className="text-xs text-danger mt-2 break-words">Ping-Fehler: {data.pingError}</div>}
          </Card>

          <Card>
            <CardHeader><CardTitle>Verbindungen</CardTitle></CardHeader>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[360px] text-xs">
                <thead className="text-muted"><tr><th className="text-left">Status</th><th className="text-right">Anzahl</th></tr></thead>
                <tbody>
                  {data.connections.map(c => (
                    <tr key={c.state ?? 'null'} className="border-t border-border/20">
                      <td className="py-1 font-mono break-words">{c.state ?? '(idle in transaction)'}</td>
                      <td className="text-right">{c.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card>
            <CardHeader><CardTitle>Top 25 Tabellen</CardTitle><CardDesc>Sortiert nach Live-Rows. Hohe Dead-Rows = VACUUM noetig.</CardDesc></CardHeader>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-xs">
                <thead className="text-muted"><tr><th className="text-left">Tabelle</th><th className="text-right">Live</th><th className="text-right">Dead</th></tr></thead>
                <tbody>
                  {data.topTables.map(t => (
                    <tr key={t.name} className="border-t border-border/20">
                      <td className="py-1 font-mono break-words">{t.name}</td>
                      <td className="text-right">{t.liveRows.toLocaleString()}</td>
                      <td className={`text-right ${t.deadRows > t.liveRows * 0.2 ? 'text-warn' : 'text-muted'}`}>{t.deadRows.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, icon }: { label: string; value: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border/30 px-2 py-1.5 min-w-0">
      <div className="text-[10px] text-muted uppercase tracking-wide flex items-center gap-1">{icon}{label}</div>
      <div className="text-base font-semibold break-words">{value}</div>
    </div>
  );
}
