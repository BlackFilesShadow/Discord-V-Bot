import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Shell } from '@/components/Shell';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Server, Ticket, Shield, Users, Plug } from 'lucide-react';

interface DashboardState {
  guildId: string;
  alias5: string;
  slots: Array<{
    id: string;
    slot: number;
    alias: string;
    alias5: string;
    nitradoServerId: string | null;
    status: string;
  }>;
}

type Tab = 'nitrado' | 'tickets' | 'aliases' | 'permissions';

export default function ServerPage() {
  const { guildId } = useParams<{ guildId: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('nitrado');
  const [token, setToken] = useState('');
  const [alias, setAlias] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['dashboard', guildId],
    queryFn: () => api.get<DashboardState>(`/api/v2/guilds/${guildId}/dashboard`),
    enabled: !!guildId,
  });

  const connect = useMutation({
    mutationFn: (body: { alias: string; token: string }) =>
      api.post(`/api/v2/guilds/${guildId}/nitrado`, body),
    onSuccess: () => {
      setToken(''); setAlias('');
      void qc.invalidateQueries({ queryKey: ['dashboard', guildId] });
    },
  });

  const disconnect = useMutation({
    mutationFn: (slot: number) => api.del(`/api/v2/guilds/${guildId}/nitrado/${slot}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dashboard', guildId] }),
  });

  const sidebar = (
    <nav className="space-y-1 text-sm">
      {([
        ['nitrado', 'Nitrado Connect', Plug],
        ['tickets', 'Tickets', Ticket],
        ['aliases', 'Server-Aliase', Server],
        ['permissions', 'Permissions', Shield],
      ] as const).map(([key, label, Icon]) => (
        <button
          key={key}
          onClick={() => setTab(key)}
          className={`w-full text-left px-3 py-2 rounded-md inline-flex items-center gap-2 transition-colors ${
            tab === key ? 'bg-accent/20 text-accent' : 'text-muted hover:bg-bg-elev hover:text-white'
          }`}
          type="button"
        >
          <Icon className="h-4 w-4" />
          {label}
        </button>
      ))}
    </nav>
  );

  return (
    <Shell title={`Server ${data?.alias5 ?? ''}`} back="/servers" sidebar={sidebar}>
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-8">
          <h1 className="v-logo text-8xl font-extrabold leading-none">V</h1>
          <p className="text-muted text-sm mt-2">Dashboard fuer {guildId}</p>
        </div>

        {isLoading && <p className="text-muted">Lade…</p>}

        {tab === 'nitrado' && data && (
          <Card>
            <CardHeader><CardTitle>Nitrado-Slots</CardTitle></CardHeader>
            <div className="space-y-3 mb-6">
              {data.slots.length === 0 && (
                <p className="text-muted text-sm">Noch kein Slot verbunden.</p>
              )}
              {data.slots.map(s => (
                <div key={s.id} className="flex items-center justify-between bg-bg-elev rounded-md px-3 py-2 border border-border">
                  <div className="flex items-center gap-3">
                    <span className="text-accent font-mono text-xs px-2 py-0.5 bg-accent/10 rounded">{s.alias5}</span>
                    <span className="text-white">{s.alias}</span>
                    <span className={`text-xs ${s.status === 'ACTIVE' ? 'text-emerald-400' : 'text-amber-400'}`}>
                      {s.status}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="secondary" onClick={() => nav(`/servers/${guildId}/server/${s.slot}`)}>
                      Oeffnen
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => disconnect.mutate(s.slot)}>
                      Trennen
                    </Button>
                  </div>
                </div>
              ))}
            </div>

            {data.slots.length < 5 && (
              <div className="border-t border-border pt-4">
                <p className="text-sm text-white/80 mb-3">Neuen Nitrado-Token verbinden (Slot {data.slots.length + 1} / 5)</p>
                <div className="grid gap-3 md:grid-cols-[1fr,2fr,auto]">
                  <Input placeholder="Alias (z.B. Main)" value={alias} onChange={e => setAlias(e.target.value)} maxLength={40} />
                  <Input placeholder="Nitrado Long-Lived Token" type="password" value={token} onChange={e => setToken(e.target.value)} />
                  <Button
                    disabled={connect.isPending || !alias || token.length < 16}
                    onClick={() => connect.mutate({ alias, token })}
                  >
                    {connect.isPending ? 'Verbinde…' : 'Verbinden'}
                  </Button>
                </div>
                {connect.error && <p className="text-red-400 text-xs mt-2">{(connect.error as Error).message}</p>}
              </div>
            )}
          </Card>
        )}

        {tab === 'tickets' && (
          <Card>
            <CardHeader><CardTitle>Tickets</CardTitle></CardHeader>
            <p className="text-muted text-sm">
              Bis zu 5 Ticket-Vorlagen pro Guild. CRUD ueber <code className="text-accent">/api/v2/guilds/{guildId}/tickets</code>.
            </p>
          </Card>
        )}

        {tab === 'aliases' && data && (
          <Card>
            <CardHeader><CardTitle>Server-Aliase</CardTitle></CardHeader>
            <div className="space-y-2">
              {data.slots.map(s => (
                <button
                  key={s.id}
                  onClick={() => nav(`/servers/${guildId}/server/${s.slot}`)}
                  className="w-full flex items-center gap-3 px-3 py-2 bg-bg-elev rounded-md hover:bg-border text-left"
                  type="button"
                >
                  <span className="text-accent font-mono text-xs px-2 py-0.5 bg-accent/10 rounded">{s.alias5}</span>
                  <span className="text-white">{s.alias}</span>
                  <Users className="h-4 w-4 text-muted ml-auto" />
                </button>
              ))}
              {data.slots.length === 0 && <p className="text-muted text-sm">Keine Slots.</p>}
            </div>
          </Card>
        )}

        {tab === 'permissions' && (
          <Card>
            <CardHeader><CardTitle>Permissions</CardTitle></CardHeader>
            <p className="text-muted text-sm">
              Subuser verwalten ueber <code className="text-accent">/api/v2/guilds/{guildId}/permissions</code>.
              <br />
              <span className="text-amber-400">Nitrado-Add/Delete kann nicht delegiert werden (Owner-only, hardcoded).</span>
            </p>
          </Card>
        )}
      </div>
    </Shell>
  );
}
