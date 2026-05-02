/**
 * Observability Console — P3.
 *
 * Vereint vier Live-Snapshots fuer DEVELOPER:
 *   - Prisma-Latenz (p50/p95/p99 + ErrorRate je model:action)
 *   - AI-Calls (p50/p95/p99 + ErrorRate je provider:action)
 *   - Live-Logs (Ring-Buffer mit Filter level/q/since)
 *   - Backup-Status (Verzeichnis-Snapshot)
 *
 * Backend:
 *   GET /api/v2/dev/observability/metrics/prisma
 *   GET /api/v2/dev/observability/metrics/ai
 *   GET /api/v2/dev/observability/logs?level=&q=&since=&n=
 *   GET /api/v2/dev/observability/backup/status
 *
 * Polling: alle 10s. Logs zusaetzlich live nachladbar via "Refresh".
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, Brain, Database, HardDrive, RefreshCw, Search } from 'lucide-react';
import { api } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { DataTable, type Column } from '@/components/ui/Table';
import { SectionHeader } from '@/components/ui/SectionHeader';

interface PrismaBucket {
  key: string;
  count: number;
  totalCount: number;
  errorCount: number;
  errorRate: number;
  p50: number;
  p95: number;
  p99: number;
  lastTs: number | null;
}

interface AiBucket {
  provider: string;
  action: string;
  count: number;
  totalCount: number;
  errorCount: number;
  errorRate: number;
  p50: number;
  p95: number;
  p99: number;
  lastTs: number | null;
}

interface LogEntry {
  ts: number;
  level: string;
  message: string;
  meta?: string;
}

interface BackupEntry {
  name: string;
  bytes: number;
  files: number;
  mtimeMs: number;
  ageMs: number;
}

interface BackupStatus {
  dir: string;
  exists: boolean;
  count: number;
  totalBytes: number;
  newest: BackupEntry | null;
  oldest: BackupEntry | null;
  entries: BackupEntry[];
}

function fmtMs(ms: number): string {
  if (ms < 1) return '<1ms';
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(2)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtAge(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function ErrorRateBadge({ rate }: { rate: number }): JSX.Element {
  const pct = (rate * 100).toFixed(1);
  if (rate <= 0.001) return <Badge variant="ok">{pct}%</Badge>;
  if (rate <= 0.05) return <Badge variant="warn">{pct}%</Badge>;
  return <Badge variant="danger">{pct}%</Badge>;
}

export default function Observability(): JSX.Element {
  const [prisma, setPrisma] = useState<PrismaBucket[] | null>(null);
  const [ai, setAi] = useState<AiBucket[] | null>(null);
  const [backup, setBackup] = useState<BackupStatus | null>(null);
  const [logs, setLogs] = useState<LogEntry[] | null>(null);
  const [logLevel, setLogLevel] = useState('');
  const [logQ, setLogQ] = useState('');
  const [loading, setLoading] = useState(false);
  const toast = useToast();

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [p, a, b, l] = await Promise.all([
        api.get<{ buckets: PrismaBucket[] }>('/api/v2/dev/observability/metrics/prisma'),
        api.get<{ buckets: AiBucket[] }>('/api/v2/dev/observability/metrics/ai'),
        api.get<BackupStatus>('/api/v2/dev/observability/backup/status'),
        api.get<{ entries: LogEntry[] }>(
          `/api/v2/dev/observability/logs?n=200${logLevel ? `&level=${encodeURIComponent(logLevel)}` : ''}${logQ ? `&q=${encodeURIComponent(logQ)}` : ''}`,
        ),
      ]);
      setPrisma(p.buckets);
      setAi(a.buckets);
      setBackup(b);
      setLogs(l.entries);
    } catch (e) {
      toast.push({ variant: 'danger', title: 'Observability-Fehler', desc: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }, [logLevel, logQ, toast]);

  useEffect(() => {
    void reload();
    const t = setInterval(() => { void reload(); }, 10_000);
    return () => clearInterval(t);
  }, [reload]);

  const prismaCols: Column<PrismaBucket>[] = useMemo(() => [
    { id: 'key', header: 'model:action', cell: (r: PrismaBucket) => <span className="font-mono">{r.key}</span> },
    { id: 'count', header: 'count', numeric: true, cell: (r: PrismaBucket) => r.count },
    { id: 'p50', header: 'p50', numeric: true, cell: (r: PrismaBucket) => fmtMs(r.p50) },
    { id: 'p95', header: 'p95', numeric: true, cell: (r: PrismaBucket) => fmtMs(r.p95) },
    { id: 'p99', header: 'p99', numeric: true, cell: (r: PrismaBucket) => fmtMs(r.p99) },
    { id: 'err', header: 'err%', cell: (r: PrismaBucket) => <ErrorRateBadge rate={r.errorRate} /> },
  ], []);

  const aiCols: Column<AiBucket>[] = useMemo(() => [
    { id: 'provider', header: 'provider', cell: (r: AiBucket) => <span className="font-mono">{r.provider}</span> },
    { id: 'action', header: 'action', cell: (r: AiBucket) => <span className="font-mono">{r.action}</span> },
    { id: 'count', header: 'count', numeric: true, cell: (r: AiBucket) => r.count },
    { id: 'p50', header: 'p50', numeric: true, cell: (r: AiBucket) => fmtMs(r.p50) },
    { id: 'p95', header: 'p95', numeric: true, cell: (r: AiBucket) => fmtMs(r.p95) },
    { id: 'p99', header: 'p99', numeric: true, cell: (r: AiBucket) => fmtMs(r.p99) },
    { id: 'err', header: 'err%', cell: (r: AiBucket) => <ErrorRateBadge rate={r.errorRate} /> },
  ], []);

  const backupCols: Column<BackupEntry>[] = useMemo(() => [
    { id: 'name', header: 'Name', cell: (r: BackupEntry) => <span className="font-mono">{r.name}</span> },
    { id: 'files', header: 'Dateien', numeric: true, cell: (r: BackupEntry) => r.files },
    { id: 'bytes', header: 'Groesse', numeric: true, cell: (r: BackupEntry) => fmtBytes(r.bytes) },
    { id: 'age', header: 'Alter', numeric: true, cell: (r: BackupEntry) => fmtAge(r.ageMs) },
  ], []);

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Observability"
        desc="Prisma-Latenz, AI-Tracing, Live-Logs und Backup-Status (P3)."
        icon={<Activity className="h-5 w-5" />}
        actions={
          <Button variant="ghost" onClick={() => void reload()} disabled={loading}>
            <RefreshCw className="h-4 w-4 mr-1" /> Refresh
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle><Database className="h-4 w-4 inline mr-2" />Prisma-Latenz</CardTitle>
          <CardDesc>Letzte 500 Samples pro model:action.</CardDesc>
        </CardHeader>
        <div className="p-4">
          {!prisma ? <Skeleton className="h-32" />
            : prisma.length === 0 ? <EmptyState title="Noch keine Queries gemessen" />
              : <DataTable rows={prisma} columns={prismaCols} rowKey={r => r.key} />}
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle><Brain className="h-4 w-4 inline mr-2" />AI-Calls</CardTitle>
          <CardDesc>Latenz + Erfolgsrate aller getraceten AI-Aufrufe.</CardDesc>
        </CardHeader>
        <div className="p-4">
          {!ai ? <Skeleton className="h-32" />
            : ai.length === 0 ? <EmptyState title="Noch keine AI-Aufrufe" desc="Wrappe Calls mit traceAiCall()." />
              : <DataTable rows={ai} columns={aiCols} rowKey={r => `${r.provider}:${r.action}`} />}
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle><Search className="h-4 w-4 inline mr-2" />Live-Logs</CardTitle>
          <CardDesc>In-Memory-Ring der letzten 1000 Eintraege, Filter case-insensitive.</CardDesc>
        </CardHeader>
        <div className="p-4 space-y-3">
          <div className="flex flex-wrap gap-2">
            <select
              value={logLevel}
              onChange={e => setLogLevel(e.target.value)}
              className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
            >
              <option value="">alle Level</option>
              <option value="error">error</option>
              <option value="warn">warn</option>
              <option value="info">info</option>
              <option value="debug">debug</option>
            </select>
            <input
              type="text"
              value={logQ}
              onChange={e => setLogQ(e.target.value)}
              placeholder="Substring-Suche (message + meta)"
              className="flex-1 min-w-[200px] rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
            />
          </div>
          {!logs ? <Skeleton className="h-48" />
            : logs.length === 0 ? <EmptyState title="Keine Treffer" />
              : (
                <div className="max-h-96 overflow-auto rounded border border-zinc-800 bg-zinc-950 font-mono text-xs">
                  {logs.map((l, i) => (
                    <div key={i} className="border-b border-zinc-900 px-2 py-1">
                      <span className="text-zinc-500">{new Date(l.ts).toISOString().slice(11, 23)} </span>
                      <span className={
                        l.level === 'error' ? 'text-red-400'
                          : l.level === 'warn' ? 'text-amber-400'
                            : l.level === 'info' ? 'text-emerald-400'
                              : 'text-zinc-400'
                      }>{l.level.padEnd(5)} </span>
                      <span className="text-zinc-200">{l.message}</span>
                      {l.meta && <span className="text-zinc-500"> {l.meta}</span>}
                    </div>
                  ))}
                </div>
              )}
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle><HardDrive className="h-4 w-4 inline mr-2" />Backup-Status</CardTitle>
          <CardDesc>Verzeichnis-Snapshot (sortiert nach mtime).</CardDesc>
        </CardHeader>
        <div className="p-4">
          {!backup ? <Skeleton className="h-32" />
            : !backup.exists ? <EmptyState title="Backup-Verzeichnis fehlt" desc={backup.dir} />
              : backup.count === 0 ? <EmptyState title="Noch keine Backups" desc={backup.dir} />
                : (
                  <>
                    <div className="mb-3 text-sm text-zinc-400">
                      <span className="font-mono">{backup.dir}</span> · {backup.count} Backups · {fmtBytes(backup.totalBytes)} gesamt
                    </div>
                    <DataTable rows={backup.entries} columns={backupCols} rowKey={r => r.name} />
                  </>
                )}
        </div>
      </Card>
    </div>
  );
}
