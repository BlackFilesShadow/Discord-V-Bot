import { Brain, RefreshCw, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useDevStatus } from '@/lib/useDevStatus';

interface ProviderRow {
  provider: string;
  configured: boolean;
  successCount: number;
  failureCount: number;
  rateLimitCount: number;
  avgLatencyMs: number;
  successRate: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
}

interface Anomaly {
  provider: string;
  reason: 'high_failure_rate' | 'high_rate_limit' | 'high_latency' | 'stale' | 'no_calls';
  severity: 'warn' | 'error';
  details: Record<string, unknown>;
}

interface AiStats {
  providers: ProviderRow[];
  anomalies: Anomaly[];
  thresholds: { highFailureRatio: number; highRateLimitRatio: number; highLatencyMs: number; staleHours: number };
}

const REASON_LABEL: Record<Anomaly['reason'], string> = {
  high_failure_rate: 'Hohe Fehlerquote',
  high_rate_limit: 'Haeufige Rate-Limits',
  high_latency: 'Hohe Latenz',
  stale: 'Inaktiv',
  no_calls: 'Keine Aufrufe',
};

export default function AiProviderStats() {
  const { data, loading, error, reload, lastFetchedAt } = useDevStatus<AiStats>('/api/v2/dev/status/ai-providers', 30000);

  return (
    <div className="space-y-4">
      <Card glow>
        <CardHeader>
          <CardTitle><Brain className="h-4 w-4 inline mr-1 text-accent" /> AI Provider Stats</CardTitle>
          <CardDesc>Erfolgsquote, Latenz und Anomalie-Detection ueber alle AI-Provider.</CardDesc>
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
            <CardHeader>
              <CardTitle>
                {data.anomalies.length === 0
                  ? <><CheckCircle2 className="h-4 w-4 inline mr-1 text-ok" /> Keine Anomalien</>
                  : <><AlertTriangle className="h-4 w-4 inline mr-1 text-warn" /> {data.anomalies.length} Anomalie(n) erkannt</>}
              </CardTitle>
              <CardDesc>
                Schwellen: Failure ≥ {(data.thresholds.highFailureRatio * 100).toFixed(0)}%,
                Rate-Limit ≥ {(data.thresholds.highRateLimitRatio * 100).toFixed(0)}%,
                Latenz ≥ {data.thresholds.highLatencyMs} ms,
                Stale ≥ {data.thresholds.staleHours} h.
              </CardDesc>
            </CardHeader>
            {data.anomalies.length > 0 && (
              <ul className="space-y-1.5 text-xs">
                {data.anomalies.map((a, i) => (
                  <li key={i} className={`rounded-md border px-2 py-1.5 ${a.severity === 'error' ? 'border-danger/40 bg-danger/5' : 'border-warn/40 bg-warn/5'}`}>
                    <div>
                      <strong className={a.severity === 'error' ? 'text-danger' : 'text-warn'}>{REASON_LABEL[a.reason]}</strong>
                      {' · '}
                      <span className="font-mono">{a.provider}</span>
                    </div>
                    <pre className="mt-1 text-[10px] font-mono text-muted">{JSON.stringify(a.details, null, 2)}</pre>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader><CardTitle>Provider-Uebersicht</CardTitle></CardHeader>
            <table className="w-full text-xs">
              <thead className="text-muted">
                <tr>
                  <th className="text-left">Provider</th>
                  <th className="text-left">Konfig.</th>
                  <th className="text-right">Erfolg</th>
                  <th className="text-right">Fehler</th>
                  <th className="text-right">Rate-Lim.</th>
                  <th className="text-right">Avg Latenz</th>
                  <th className="text-right">Erfolgsquote</th>
                  <th className="text-left">Letzter Fehler</th>
                </tr>
              </thead>
              <tbody>
                {data.providers.map(p => (
                  <tr key={p.provider} className="border-t border-border/20">
                    <td className="py-1 font-mono">{p.provider}</td>
                    <td>{p.configured ? <span className="text-ok">ja</span> : <span className="text-muted">nein</span>}</td>
                    <td className="text-right">{p.successCount}</td>
                    <td className="text-right text-danger">{p.failureCount}</td>
                    <td className="text-right text-warn">{p.rateLimitCount}</td>
                    <td className="text-right">{p.avgLatencyMs} ms</td>
                    <td className={`text-right ${p.successRate >= 0.95 ? 'text-ok' : p.successRate >= 0.7 ? 'text-warn' : 'text-danger'}`}>
                      {(p.successRate * 100).toFixed(1)}%
                    </td>
                    <td className="text-muted text-[10px] break-all">{p.lastError ?? '-'}</td>
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
