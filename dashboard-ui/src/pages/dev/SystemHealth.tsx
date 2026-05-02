import { HeartPulse, RefreshCw, AlertTriangle } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useDevStatus } from '@/lib/useDevStatus';

interface SystemStatus {
  process: {
    pid: number;
    uptimeSec: number;
    nodeVersion: string;
    memory: { rss: number; heapUsed: number; heapTotal: number; external: number };
  };
  host: {
    platform: string;
    arch: string;
    hostname: string;
    uptimeSec: number;
    totalMemBytes: number;
    freeMemBytes: number;
    cpuCount: number;
    cpuModel: string;
    loadAvg: { '1m': number; '5m': number; '15m': number };
  };
  disk: { totalBytes: number; freeBytes: number } | null;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
function fmtUptime(s: number): string {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : (h > 0 ? `${h}h ${m}m` : `${m}m`);
}

export default function SystemHealth() {
  const { data, loading, error, reload, lastFetchedAt } = useDevStatus<SystemStatus>('/api/v2/dev/status/system', 10000);

  return (
    <div className="space-y-4">
      <Card glow>
        <CardHeader>
          <CardTitle><HeartPulse className="h-4 w-4 inline mr-1 text-accent" /> System Health</CardTitle>
          <CardDesc>CPU, RAM, Disk, Process-Memory, Load.</CardDesc>
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
            <CardHeader><CardTitle>Prozess</CardTitle></CardHeader>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
              <Stat label="PID" value={data.process.pid} />
              <Stat label="Uptime" value={fmtUptime(data.process.uptimeSec)} />
              <Stat label="Node" value={data.process.nodeVersion} />
              <Stat label="RSS" value={fmtBytes(data.process.memory.rss)} />
              <Stat label="Heap Used" value={fmtBytes(data.process.memory.heapUsed)} />
              <Stat label="Heap Total" value={fmtBytes(data.process.memory.heapTotal)} />
              <Stat label="External" value={fmtBytes(data.process.memory.external)} />
            </div>
          </Card>

          <Card>
            <CardHeader><CardTitle>Host</CardTitle></CardHeader>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
              <Stat label="Hostname" value={data.host.hostname} />
              <Stat label="OS" value={`${data.host.platform}/${data.host.arch}`} />
              <Stat label="Uptime" value={fmtUptime(data.host.uptimeSec)} />
              <Stat label="CPUs" value={data.host.cpuCount} />
              <Stat label="RAM total" value={fmtBytes(data.host.totalMemBytes)} />
              <Stat label="RAM frei" value={fmtBytes(data.host.freeMemBytes)} />
              <Stat label="Load 1m" value={data.host.loadAvg['1m'].toFixed(2)} />
              <Stat label="Load 15m" value={data.host.loadAvg['15m'].toFixed(2)} />
            </div>
            <div className="mt-2 text-[11px] text-muted">CPU: {data.host.cpuModel}</div>
          </Card>

          {data.disk && (
            <Card>
              <CardHeader><CardTitle>Disk</CardTitle></CardHeader>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                <Stat label="Total" value={fmtBytes(data.disk.totalBytes)} />
                <Stat label="Frei" value={fmtBytes(data.disk.freeBytes)} />
                <Stat label="Belegt" value={fmtBytes(data.disk.totalBytes - data.disk.freeBytes)} />
                <Stat label="Belegt %" value={`${((1 - data.disk.freeBytes / data.disk.totalBytes) * 100).toFixed(1)}%`} />
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border/30 px-2 py-1.5">
      <div className="text-[10px] text-muted uppercase">{label}</div>
      <div className="text-base font-semibold">{value}</div>
    </div>
  );
}
