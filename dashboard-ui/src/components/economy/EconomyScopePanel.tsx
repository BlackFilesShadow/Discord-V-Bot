import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, DatabaseZap, RefreshCw } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Select } from '@/components/ui/Select';

interface EconomyScopeStatus {
  required: boolean;
  state: {
    status: 'MIGRATION_REQUIRED' | 'RESOLVED';
    primaryNitradoConnId: string | null;
    detectedActiveServerCount: number;
    resolvedAt: string | null;
  } | null;
  servers: Array<{ id: string; slot: number; alias: string; nitradoServerId: string }>;
}

export function EconomyScopePanel({ guildId, slot }: { guildId: string; slot: string }) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const status = useQuery({
    queryKey: ['economy-scope-status', guildId],
    queryFn: () => api.get<EconomyScopeStatus>(`/api/v2/guilds/${guildId}/economy-scope/status`),
    retry: false,
  });

  const suggested = useMemo(() => {
    const servers = status.data?.servers ?? [];
    return servers.find(server => String(server.slot) === slot) ?? servers[0] ?? null;
  }, [status.data, slot]);

  useEffect(() => {
    if (status.data?.required && !selected && suggested) setSelected(suggested.id);
  }, [status.data?.required, selected, suggested]);

  const resolve = useMutation({
    mutationFn: () => api.post<{ ok: boolean; alreadyResolved: boolean; primaryNitradoConnId: string; updatedRows: number }>(
      `/api/v2/guilds/${guildId}/economy-scope/resolve`,
      { nitradoConnId: selected },
    ),
    onSuccess: async result => {
      setMessage(result.alreadyResolved
        ? 'Legacy-Economy war bereits korrekt zugeordnet.'
        : `Legacy-Economy zugeordnet (${result.updatedRows} bestehende Zeilen). Andere Slots starten getrennt mit eigenem Bestand.`);
      await status.refetch();
      await qc.invalidateQueries();
    },
    onError: (error: Error) => setMessage(error.message),
  });

  if (status.isLoading) return null;
  if (status.isError) {
    if (status.error instanceof ApiError && status.error.status === 403) return null;
    return (
      <Card>
        <CardHeader><CardTitle><span className="inline-flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-warning" />Economy-Scope pruefen</span></CardTitle></CardHeader>
        <p className="text-sm text-danger">Migrationsstatus konnte nicht geladen werden: {(status.error as Error).message}</p>
      </Card>
    );
  }
  if (!status.data?.required) return null;

  return (
    <Card className="border-warning/40 bg-warning/5">
      <CardHeader><CardTitle><span className="inline-flex items-center gap-2"><DatabaseZap className="h-4 w-4 text-warning" />Einmalige Economy-Zuordnung erforderlich</span></CardTitle></CardHeader>
      <div className="space-y-3">
        <p className="text-sm text-muted">
          Auf diesem Discord-Server existieren alte guildweite Economy-Daten aus der Zeit vor den servergetrennten Konten. Bevor Economy, Lotterie oder Schwarzmarkt starten koennen, muss der Server-Owner einmal festlegen, welchem Gameserver diese alten Daten gehoeren.
        </p>
        <p className="text-xs text-warning">
          Es werden keine Guthaben kopiert oder auf mehrere Server verteilt. Nur bestehende Legacy-Daten werden genau einem Primaerserver zugeordnet; alle anderen Slots beginnen danach als eigener Economy-Scope.
        </p>
        <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
          <label className="text-sm flex-1">
            <span className="text-muted">Legacy-Economy zuordnen zu</span>
            <Select value={selected} onChange={e => { setSelected(e.target.value); setMessage(null); }}>
              <option value="">— Gameserver waehlen —</option>
              {status.data.servers.map(server => (
                <option key={server.id} value={server.id}>Slot #{server.slot} · {server.alias || server.nitradoServerId}</option>
              ))}
            </Select>
          </label>
          <Button disabled={!selected || resolve.isPending} onClick={() => resolve.mutate()}>
            {resolve.isPending ? <><RefreshCw className="h-3.5 w-3.5 animate-spin mr-1" />Ordne zu…</> : 'Zuordnen & Economy freigeben'}
          </Button>
        </div>
        {message && <p className={`text-xs ${resolve.isError ? 'text-danger' : 'text-green-400'}`}>{message}</p>}
      </div>
    </Card>
  );
}
