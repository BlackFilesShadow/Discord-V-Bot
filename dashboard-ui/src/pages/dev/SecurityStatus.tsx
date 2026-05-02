/**
 * Security Status — P4.
 * 24h-Snapshot: SecurityEvents, Brute-Force, Login-Failures, DevSessions.
 * Backend: GET /api/v2/dev/stubs/security.
 */
import { useEffect, useState, useCallback } from 'react';
import { ShieldCheck, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatCard } from '@/components/ui/StatCard';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { DataTable, type Column } from '@/components/ui/Table';

interface EventGroup { eventType: string; severity: string; count: number }
interface RecentEvent {
  id: string; eventType: string; severity: string; description: string;
  ipAddress: string | null; createdAt: string;
}
interface SecurityPayload {
  windowHours: number; activeDevSessions: number;
  bruteForceLast24h: number; loginFailLast24h: number;
  eventsByType: EventGroup[];
  recentEvents: RecentEvent[];
  generatedAt: string;
}

const sevBadge = (s: string) => {
  if (s === 'CRITICAL' || s === 'HIGH') return <Badge variant="danger">{s}</Badge>;
  if (s === 'MEDIUM') return <Badge variant="warn">{s}</Badge>;
  if (s === 'LOW') return <Badge variant="info">{s}</Badge>;
  return <Badge>{s}</Badge>;
};

export default function Page(): JSX.Element {
  const [data, setData] = useState<SecurityPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const toast = useToast();

  const reload = useCallback(async () => {
    setLoading(true);
    try { setData(await api.get<SecurityPayload>('/api/v2/dev/stubs/security')); }
    catch (e) { toast.push({ variant: 'danger', title: 'Fehler', desc: (e as Error).message }); }
    finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { void reload(); const t = setInterval(() => { void reload(); }, 15_000); return () => clearInterval(t); }, [reload]);

  const groupCols: Column<EventGroup>[] = [
    { id: 't', header: 'Event-Typ', cell: r => <span className="font-mono">{r.eventType}</span> },
    { id: 's', header: 'Severity', cell: r => sevBadge(r.severity) },
    { id: 'c', header: 'Anzahl', numeric: true, cell: r => r.count },
  ];
  const eventCols: Column<RecentEvent>[] = [
    { id: 't', header: 'Typ', cell: r => <span className="font-mono">{r.eventType}</span> },
    { id: 's', header: 'Sev', cell: r => sevBadge(r.severity) },
    { id: 'd', header: 'Beschreibung', cell: r => <span className="text-xs">{r.description}</span> },
    { id: 'ip', header: 'IP', cell: r => <span className="font-mono text-xs">{r.ipAddress ?? '-'}</span> },
    { id: 'when', header: 'Zeit', cell: r => new Date(r.createdAt).toLocaleString() },
  ];

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Sicherheitsstatus"
        desc="24h-Snapshot der SecurityEvents-Tabelle + aktive DEV-Sessions."
        icon={<ShieldCheck className="h-5 w-5" />}
        actions={<Button variant="ghost" onClick={() => void reload()} disabled={loading}><RefreshCw className="h-4 w-4 mr-1" />Refresh</Button>}
      />
      {!data ? <Skeleton className="h-32" /> : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard label="Aktive DEV-Sessions" value={data.activeDevSessions} accent="warn" />
            <StatCard label="Brute-Force 24h" value={data.bruteForceLast24h} accent={data.bruteForceLast24h > 0 ? 'danger' : 'ok'} />
            <StatCard label="Login-Failures 24h" value={data.loginFailLast24h} accent={data.loginFailLast24h > 5 ? 'warn' : 'neutral'} />
            <StatCard label="Events 24h" value={data.eventsByType.reduce((s, r) => s + r.count, 0)} />
          </div>
          <Card>
            <CardHeader><CardTitle>Events nach Typ + Severity</CardTitle><CardDesc>Letzte 24h.</CardDesc></CardHeader>
            {data.eventsByType.length === 0 ? <EmptyState title="Keine Events" />
              : <DataTable rows={data.eventsByType} columns={groupCols} rowKey={r => `${r.eventType}-${r.severity}`} />}
          </Card>
          <Card>
            <CardHeader><CardTitle>Letzte 50 Events</CardTitle><CardDesc>Sortiert nach Zeit.</CardDesc></CardHeader>
            {data.recentEvents.length === 0 ? <EmptyState title="Keine Events" />
              : <DataTable rows={data.recentEvents} columns={eventCols} rowKey={r => r.id} />}
          </Card>
        </>
      )}
    </div>
  );
}
