/**
 * Backup Status — P4.
 * Live-Snapshot des Backup-Verzeichnisses.
 * Backend: GET /api/v2/dev/observability/backup/status.
 */
import { HardDrive, RefreshCw } from 'lucide-react';
import { useDevStatus } from '@/lib/useDevStatus';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatCard } from '@/components/ui/StatCard';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { DataTable, type Column } from '@/components/ui/Table';

interface BackupEntry { name: string; bytes: number; files: number; mtimeMs: number; ageMs: number }
interface BackupStatus {
  dir: string; exists: boolean; count: number; totalBytes: number;
  newest: BackupEntry | null; oldest: BackupEntry | null; entries: BackupEntry[];
}

const fmtBytes = (b: number) => b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : b < 1e9 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${(b / 1e9).toFixed(2)} GB`;
const fmtAge = (ms: number) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
};

export default function Page(): JSX.Element {
  const { data, loading, error, reload } = useDevStatus<BackupStatus>('/api/v2/dev/observability/backup/status', 30_000);

  const cols: Column<BackupEntry>[] = [
    { id: 'name', header: 'Name', cell: r => <span className="font-mono text-xs">{r.name}</span> },
    { id: 'files', header: 'Dateien', numeric: true, cell: r => r.files },
    { id: 'bytes', header: 'Groesse', numeric: true, cell: r => fmtBytes(r.bytes) },
    { id: 'age', header: 'Alter', numeric: true, cell: r => fmtAge(r.ageMs) },
  ];

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Backup Status"
        desc="Verzeichnis-Snapshot, sortiert nach mtime."
        icon={<HardDrive className="h-5 w-5" />}
        actions={<Button variant="ghost" onClick={() => void reload()} disabled={loading}><RefreshCw className="h-4 w-4 mr-1" />Refresh</Button>}
      />
      {error && !data && <EmptyState title="Fehler beim Laden" desc={error} />}
      {!data && !error ? <Skeleton className="h-32" />
        : !data ? null
          : !data.exists ? <EmptyState title="Backup-Verzeichnis fehlt" desc={data.dir} />
          : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <StatCard label="Backups" value={data.count} accent={data.count > 0 ? 'ok' : 'warn'} />
                <StatCard label="Total" value={fmtBytes(data.totalBytes)} />
                <StatCard label="Neuestes" value={data.newest ? fmtAge(data.newest.ageMs) : '-'} accent={data.newest && data.newest.ageMs > 86400000 ? 'warn' : 'ok'} />
                <StatCard label="Aeltestes" value={data.oldest ? fmtAge(data.oldest.ageMs) : '-'} />
              </div>
              <Card>
                <CardHeader><CardTitle>Backups</CardTitle><CardDesc className="font-mono">{data.dir}</CardDesc></CardHeader>
                {data.entries.length === 0 ? <EmptyState title="Noch keine Backups" />
                  : <DataTable rows={data.entries} columns={cols} rowKey={r => r.name} />}
              </Card>
            </>
          )}
    </div>
  );
}
