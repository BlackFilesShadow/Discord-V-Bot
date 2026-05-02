/**
 * Debug Tools — P4.
 * V8-Heap-Stats, EventLoop-Lag, Resource-Usage + Heap-Snapshot-Trigger (StepUp).
 * Backend: GET /api/v2/dev/stubs/debug, POST /api/v2/dev/stubs/debug/heap-snapshot.
 */
import { useEffect, useState, useCallback } from 'react';
import { Bug, Camera, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { StatCard } from '@/components/ui/StatCard';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { DataTable, type Column } from '@/components/ui/Table';
import { StepUpModal, type StepUpRequest } from '@/components/ui/StepUpModal';

interface HeapSpace { name: string; size: number; used: number; available: number }
interface HeapStats {
  total_heap_size: number; used_heap_size: number; heap_size_limit: number;
  malloced_memory: number; external_memory: number;
  number_of_native_contexts: number; number_of_detached_contexts: number;
}
interface DebugPayload {
  heap: HeapStats;
  heapSpaces: HeapSpace[];
  eventLoopDelay: { minMs: number; maxMs: number; meanMs: number; p50Ms: number; p95Ms: number; p99Ms: number };
  resourceUsage: { userCPU: number; systemCPU: number; maxRSS: number; fsRead: number; fsWrite: number };
  perfNow: number; nodeVersion: string; generatedAt: string;
}

const fmtBytes = (b: number) => b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : b < 1e9 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${(b / 1e9).toFixed(2)} GB`;

export default function Page(): JSX.Element {
  const [data, setData] = useState<DebugPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [stepUp, setStepUp] = useState<StepUpRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const reload = useCallback(async () => {
    setLoading(true);
    try { setData(await api.get<DebugPayload>('/api/v2/dev/stubs/debug')); }
    catch (e) { toast.push({ variant: 'danger', title: 'Fehler', desc: (e as Error).message }); }
    finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { void reload(); const t = setInterval(() => { void reload(); }, 10_000); return () => clearInterval(t); }, [reload]);

  const cols: Column<HeapSpace>[] = [
    { id: 'name', header: 'Space', cell: r => <span className="font-mono text-xs">{r.name}</span> },
    { id: 'size', header: 'Size', numeric: true, cell: r => fmtBytes(r.size) },
    { id: 'used', header: 'Used', numeric: true, cell: r => fmtBytes(r.used) },
    { id: 'avail', header: 'Available', numeric: true, cell: r => fmtBytes(r.available) },
  ];

  const triggerSnapshot = () => {
    setStepUp({
      action: 'debug.heapSnapshot',
      title: 'Heap-Snapshot erzeugen',
      description: 'Schreibt einen V8-Heap-Snapshot in das tmp-Verzeichnis. Operation kann den Bot kurz blockieren (mehrere 100 MB!).',
      severity: 'warn',
    });
  };

  const onConfirm = async ({ reason, reAuth }: { reason: string; reAuth: string }) => {
    setBusy(true);
    try {
      const r = await api.post<{ ok: boolean; file: string }>('/api/v2/dev/stubs/debug/heap-snapshot', { reason, reAuth });
      toast.push({ variant: 'success', title: 'Snapshot erstellt', desc: r.file });
      setStepUp(null);
    } catch (e) {
      toast.push({ variant: 'danger', title: 'Snapshot fehlgeschlagen', desc: (e as Error).message });
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Debug Tools"
        desc="Heap, EventLoop-Lag, Resource-Usage. Heap-Snapshot fuer Forensik."
        icon={<Bug className="h-5 w-5" />}
        actions={
          <>
            <Button variant="ghost" onClick={() => void reload()} disabled={loading}><RefreshCw className="h-4 w-4 mr-1" />Refresh</Button>
            <Button variant="danger" onClick={triggerSnapshot}><Camera className="h-4 w-4 mr-1" />Heap-Snapshot</Button>
          </>
        }
      />
      {!data ? <Skeleton className="h-32" /> : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard label="Heap used" value={fmtBytes(data.heap.used_heap_size)} />
            <StatCard label="Heap limit" value={fmtBytes(data.heap.heap_size_limit)} />
            <StatCard label="External" value={fmtBytes(data.heap.external_memory)} />
            <StatCard label="Detached ctx" value={data.heap.number_of_detached_contexts} accent={data.heap.number_of_detached_contexts > 0 ? 'warn' : 'ok'} />
            <StatCard label="EvtLoop p50" value={`${data.eventLoopDelay.p50Ms.toFixed(2)}ms`} />
            <StatCard label="EvtLoop p95" value={`${data.eventLoopDelay.p95Ms.toFixed(2)}ms`} accent={data.eventLoopDelay.p95Ms > 50 ? 'warn' : 'ok'} />
            <StatCard label="EvtLoop p99" value={`${data.eventLoopDelay.p99Ms.toFixed(2)}ms`} accent={data.eventLoopDelay.p99Ms > 100 ? 'danger' : 'ok'} />
            <StatCard label="Max RSS" value={fmtBytes(data.resourceUsage.maxRSS * 1024)} />
          </div>
          <Card>
            <CardHeader><CardTitle>V8 Heap-Spaces</CardTitle><CardDesc>Detailaufschluesselung pro Space.</CardDesc></CardHeader>
            <DataTable rows={data.heapSpaces} columns={cols} rowKey={r => r.name} />
          </Card>
        </>
      )}
      <StepUpModal open={!!stepUp} request={stepUp} onClose={() => setStepUp(null)} onConfirm={onConfirm} loading={busy} />
    </div>
  );
}
