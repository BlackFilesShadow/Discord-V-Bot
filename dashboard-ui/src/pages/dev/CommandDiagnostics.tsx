/**
 * Command Diagnostics — P4.
 * Liest die Slash-Command-Registry des laufenden Discord-Clients.
 * Backend: GET /api/v2/dev/stubs/commands.
 */
import { useEffect, useState, useCallback, useMemo } from 'react';
import { TerminalSquare, RefreshCw } from 'lucide-react';
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

interface Cmd { name: string; description: string; cooldownMs: number | null }
interface Resp { ready: boolean; count: number; commands: Cmd[] }

export default function Page(): JSX.Element {
  const [data, setData] = useState<Resp | null>(null);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const toast = useToast();

  const reload = useCallback(async () => {
    setLoading(true);
    try { setData(await api.get<Resp>('/api/v2/dev/stubs/commands')); }
    catch (e) { toast.push({ variant: 'danger', title: 'Fehler', desc: (e as Error).message }); }
    finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { void reload(); }, [reload]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const n = filter.trim().toLowerCase();
    return n ? data.commands.filter(c => c.name.toLowerCase().includes(n) || c.description.toLowerCase().includes(n)) : data.commands;
  }, [data, filter]);

  const cols: Column<Cmd>[] = [
    { id: 'name', header: 'Name', cell: r => <span className="font-mono text-sm">/{r.name}</span> },
    { id: 'desc', header: 'Beschreibung', cell: r => <span className="text-xs">{r.description || <em className="text-muted">keine</em>}</span> },
    { id: 'cd', header: 'Cooldown', numeric: true, cell: r => r.cooldownMs == null ? '-' : `${r.cooldownMs}ms` },
  ];

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Command Diagnose"
        desc="Slash-Command-Registry des laufenden Bots."
        icon={<TerminalSquare className="h-5 w-5" />}
        actions={<Button variant="ghost" onClick={() => void reload()} disabled={loading}><RefreshCw className="h-4 w-4 mr-1" />Refresh</Button>}
      />
      {!data ? <Skeleton className="h-32" />
        : !data.ready ? <EmptyState title="Bot nicht verbunden" desc="Discord-Client noch nicht initialisiert." />
          : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <StatCard label="Commands gesamt" value={data.count} accent="ok" />
                <StatCard label="Mit Cooldown" value={data.commands.filter(c => c.cooldownMs != null).length} />
                <StatCard label="Sichtbar" value={filtered.length} />
              </div>
              <Card>
                <CardHeader>
                  <CardTitle>Slash-Commands</CardTitle>
                  <CardDesc>Status: <Badge variant="ok">live</Badge></CardDesc>
                </CardHeader>
                <input
                  value={filter} onChange={e => setFilter(e.target.value)}
                  placeholder="Filter (Name oder Beschreibung)"
                  className="mb-3 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
                />
                {filtered.length === 0 ? <EmptyState title="Keine Treffer" />
                  : <DataTable rows={filtered} columns={cols} rowKey={r => r.name} />}
              </Card>
            </>
          )}
    </div>
  );
}
