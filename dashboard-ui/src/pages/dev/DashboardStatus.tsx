/**
 * Dashboard Status — P4.
 * Live-Snapshot des Express-Servers + Sockets + Top-Prisma-Buckets.
 * Backend: GET /api/v2/dev/stubs/server-stats (Polling 10s).
 */
import { useEffect, useState, useCallback } from 'react';
import { LayoutDashboard, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { StatCard } from '@/components/ui/StatCard';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { DataTable, type Column } from '@/components/ui/Table';

interface PrismaBucket {
  key: string; count: number; totalCount: number; errorCount: number; errorRate: number;
  p50: number; p95: number; p99: number; lastTs: number | null;
}
interface ServerStats {
  uptimeSec: number; nodeVersion: string; pid: number;
  memory: { rss: number; heapUsed: number; heapTotal: number; external: number };
  cpu: { userMs: number; systemMs: number };
  sessions: { http: number; dev: number };
  sockets: { dev: number; guild: number };
  topPrisma: PrismaBucket[];
  generatedAt: string;
}

const fmtBytes = (b: number) => b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : b < 1e9 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${(b / 1e9).toFixed(2)} GB`;
const fmtUptime = (s: number) => {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
};

export default function Page(): JSX.Element {
  const [data, setData] = useState<ServerStats | null>(null);
  const [loading, setLoading] = useState(false);
  const toast = useToast();

  const reload = useCallback(async () => {
    setLoading(true);
    try { setData(await api.get<ServerStats>('/api/v2/dev/stubs/server-stats')); }
    catch (e) { toast.push({ variant: 'danger', title: 'Fehler', desc: (e as Error).message }); }
    finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { void reload(); const t = setInterval(() => { void reload(); }, 10_000); return () => clearInterval(t); }, [reload]);

  const cols: Column<PrismaBucket>[] = [
    { id: 'key', header: 'model:action', cell: r => <span className="font-mono">{r.key}</span> },
    { id: 'count', header: 'count', numeric: true, cell: r => r.count },
    { id: 'p95', header: 'p95', numeric: true, cell: r => `${r.p95}ms` },
    { id: 'err', header: 'err%', numeric: true, cell: r => `${(r.errorRate * 100).toFixed(1)}%` },
  ];

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Dashboard Status"
        desc="Express-Server, Sessions, aktive Sockets, Top-DB-Queries."
        icon={<LayoutDashboard className="h-5 w-5" />}
        actions={<Button variant="ghost" onClick={() => void reload()} disabled={loading}><RefreshCw className="h-4 w-4 mr-1" />Refresh</Button>}
      />
      {!data ? <Skeleton className="h-32" /> : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard label="Uptime" value={fmtUptime(data.uptimeSec)} />
            <StatCard label="HTTP-Sessions" value={data.sessions.http} accent="info" />
            <StatCard label="DEV-Sessions" value={data.sessions.dev} accent="warn" />
            <StatCard label="Heap" value={fmtBytes(data.memory.heapUsed)} />
            <StatCard label="RSS" value={fmtBytes(data.memory.rss)} />
            <StatCard label="Sockets /dev" value={data.sockets.dev} />
            <StatCard label="Sockets /guild" value={data.sockets.guild} />
            <StatCard label="Node" value={data.nodeVersion} />
          </div>
          <Card>
            <CardHeader><CardTitle>Top Prisma-Queries</CardTitle><CardDesc>nach Sample-Count.</CardDesc></CardHeader>
            <DataTable rows={data.topPrisma} columns={cols} rowKey={r => r.key} empty="Noch keine Queries gemessen." />
          </Card>
        </>
      )}
    </div>
  );
}
