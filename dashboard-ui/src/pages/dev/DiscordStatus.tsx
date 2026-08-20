import { Plug, RefreshCw, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useDevStatus } from '@/lib/useDevStatus';

interface DiscordStatus {
  ok: boolean;
  error?: string | null;
  statusCode: number | null;
  averagePingMs: number | null;
  shards: Array<{ id: number; status: number; pingMs: number }>;
  cache: { guilds: number; users: number; channels: number };
  user: { id: string; tag: string } | null;
}

const WS_STATES: Record<number, string> = {
  0: 'Ready', 1: 'Connecting', 2: 'Reconnecting', 3: 'Idle', 4: 'Nearly', 5: 'Disconnected', 6: 'WaitingForGuilds', 7: 'IdentifyingSession', 8: 'Resuming',
};

function gatewayLabel(statusCode: number | null): string {
  if (statusCode === null) return 'Offline';
  return WS_STATES[statusCode] ?? String(statusCode);
}

export default function DiscordStatus() {
  const { data, loading, error, reload, lastFetchedAt } = useDevStatus<DiscordStatus>('/api/v2/dev/status/discord', 10000);

  return (
    <div className="space-y-4 min-w-0">
      <Card glow>
        <CardHeader>
          <CardTitle><Plug className="h-4 w-4 inline mr-1 text-accent" /> Discord API Status</CardTitle>
          <CardDesc>Gateway-Latenz, Shard-Health, Cache-Sizes.</CardDesc>
        </CardHeader>
        <Button variant="ghost" size="sm" onClick={reload} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 mr-1 ${loading ? 'animate-spin' : ''}`} /> Aktualisieren
        </Button>
        {lastFetchedAt && <span className="ml-2 text-[11px] text-muted">Stand: {lastFetchedAt.toLocaleTimeString()}</span>}
      </Card>

      {error && <Card><div role="alert" className="text-xs text-danger flex gap-2 break-words"><AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" /> {error}</div></Card>}

      {data && (
        <>
          {data.error && <Card><div role="alert" className="text-xs text-warn break-words">{data.error}</div></Card>}
          <Card>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
              <div className="rounded-md border border-border/30 px-2 py-1.5 min-w-0">
                <div className="text-[10px] text-muted uppercase">Gateway</div>
                <div className="text-base font-semibold flex items-center gap-1 min-w-0">
                  {data.ok
                    ? <><CheckCircle2 className="h-3.5 w-3.5 text-ok shrink-0" /> <span className="break-words">{gatewayLabel(data.statusCode)}</span></>
                    : <><AlertTriangle className="h-3.5 w-3.5 text-danger shrink-0" /> <span className="break-words">{gatewayLabel(data.statusCode)}</span></>}
                </div>
              </div>
              <SimpleStat label="Avg-Ping" value={data.averagePingMs === null ? '?' : `${data.averagePingMs} ms`} />
              <SimpleStat label="Bot" value={data.user ? data.user.tag : '?'} />
              <SimpleStat label="Shards" value={data.shards.length} />
              <SimpleStat label="Guilds (Cache)" value={data.cache.guilds} />
              <SimpleStat label="Users (Cache)" value={data.cache.users} />
              <SimpleStat label="Channels (Cache)" value={data.cache.channels} />
            </div>
          </Card>

          <Card>
            <CardHeader><CardTitle>Shards</CardTitle></CardHeader>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[380px] text-xs">
                <thead className="text-muted"><tr><th className="text-left">ID</th><th className="text-left">Status</th><th className="text-right">Ping</th></tr></thead>
                <tbody>
                  {data.shards.length === 0 && <tr><td colSpan={3} className="text-muted py-2">Keine Shards aktiv.</td></tr>}
                  {data.shards.map(s => (
                    <tr key={s.id} className="border-t border-border/20">
                      <td className="py-1">{s.id}</td>
                      <td className={s.status === 0 ? 'text-ok' : 'text-warn'}>{WS_STATES[s.status] ?? s.status}</td>
                      <td className="text-right">{s.pingMs} ms</td>
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

function SimpleStat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border/30 px-2 py-1.5 min-w-0">
      <div className="text-[10px] text-muted uppercase">{label}</div>
      <div className="text-base font-semibold break-words">{value}</div>
    </div>
  );
}
