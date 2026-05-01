import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Shell } from '@/components/Shell';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useGuildLiveUpdates } from '@/lib/useGuildLiveUpdates';
import { Server, Ticket, Shield, Users, Plug, X, Trash2 } from 'lucide-react';

interface DashboardState {
  guildId: string;
  alias5: string;
  isOwner: boolean;
  slots: Array<{
    id: string;
    slot: number;
    alias: string;
    alias5: string;
    nitradoServerId: string | null;
    status: string;
  }>;
}

interface PermissionsState {
  grants: Array<{
    userDiscordId: string;
    permissions: string[];
    grantedBy: string | null;
    updatedAt: string;
  }>;
  availableScopes: string[];
}

interface TicketsState {
  templates: Array<{ id: string; name: string }>;
  note?: string;
}

type Tab = 'nitrado' | 'tickets' | 'aliases' | 'permissions';

export default function ServerPage() {
  const { guildId } = useParams<{ guildId: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('nitrado');
  const [token, setToken] = useState('');
  const [alias, setAlias] = useState('');

  useGuildLiveUpdates(guildId);

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

        {tab === 'tickets' && guildId && <TicketsPanel guildId={guildId} />}

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

        {tab === 'permissions' && guildId && <PermissionsPanel guildId={guildId} isOwner={data?.isOwner ?? false} />}
      </div>
    </Shell>
  );
}

// ----------------------------------------------------------------------------

function TicketsPanel({ guildId }: { guildId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['tickets', guildId],
    queryFn: () => api.get<TicketsState>(`/api/v2/guilds/${guildId}/tickets`),
  });
  return (
    <Card>
      <CardHeader><CardTitle>Tickets</CardTitle></CardHeader>
      {isLoading && <p className="text-muted">Lade…</p>}
      {error && <p className="text-red-400 text-sm">{(error as Error).message}</p>}
      {data && (
        <>
          {data.note && (
            <div className="bg-amber-950/40 border border-amber-700/40 rounded-md p-3 mb-4 text-amber-300 text-sm">
              {data.note}
            </div>
          )}
          {data.templates.length === 0 && !data.note && (
            <p className="text-muted text-sm">Keine Vorlagen vorhanden.</p>
          )}
          {data.templates.map(t => (
            <div key={t.id} className="flex items-center justify-between bg-bg-elev rounded-md px-3 py-2 border border-border">
              <span className="text-white">{t.name}</span>
            </div>
          ))}
        </>
      )}
    </Card>
  );
}

// ----------------------------------------------------------------------------

function PermissionsPanel({ guildId, isOwner }: { guildId: string; isOwner: boolean }) {
  const qc = useQueryClient();
  const [newUser, setNewUser] = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['permissions', guildId],
    queryFn: () => api.get<PermissionsState>(`/api/v2/guilds/${guildId}/permissions`),
  });

  const setScope = useMutation({
    mutationFn: (vars: { user: string; scope: string; on: boolean }) =>
      vars.on
        ? api.put(`/api/v2/guilds/${guildId}/permissions/${vars.user}/${vars.scope}`)
        : api.del(`/api/v2/guilds/${guildId}/permissions/${vars.user}/${vars.scope}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['permissions', guildId] }),
  });

  const purge = useMutation({
    mutationFn: (user: string) => api.del(`/api/v2/guilds/${guildId}/permissions/${user}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['permissions', guildId] }),
  });

  if (!isOwner) {
    return (
      <Card>
        <CardHeader><CardTitle>Permissions</CardTitle></CardHeader>
        <p className="text-muted text-sm">Nur der Guild-Owner kann Permissions verwalten.</p>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader><CardTitle>Permissions</CardTitle></CardHeader>
      <p className="text-amber-400 text-xs mb-4">
        Nitrado-Add/Delete und permissions.manage / dev.console sind hardcoded Owner-only und nicht delegierbar.
      </p>

      {isLoading && <p className="text-muted">Lade…</p>}
      {error && <p className="text-red-400 text-sm">{(error as Error).message}</p>}

      {data && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted text-xs">
                  <th className="text-left py-2 px-2">User-ID</th>
                  {data.availableScopes.map(s => (
                    <th key={s} className="text-center py-2 px-1 font-mono">{s.replace('.', '\n')}</th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.grants.length === 0 && (
                  <tr><td colSpan={data.availableScopes.length + 2} className="text-muted text-center py-4">Keine Grants.</td></tr>
                )}
                {data.grants.map(g => (
                  <tr key={g.userDiscordId} className="border-t border-border">
                    <td className="py-2 px-2 font-mono text-xs text-white">{g.userDiscordId}</td>
                    {data.availableScopes.map(scope => {
                      const on = g.permissions.includes(scope);
                      return (
                        <td key={scope} className="text-center px-1">
                          <input
                            type="checkbox"
                            checked={on}
                            disabled={setScope.isPending}
                            onChange={e => setScope.mutate({ user: g.userDiscordId, scope, on: e.target.checked })}
                            className="accent-accent"
                          />
                        </td>
                      );
                    })}
                    <td className="px-2">
                      <Button size="sm" variant="danger" onClick={() => purge.mutate(g.userDiscordId)}>
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="border-t border-border pt-4 mt-4">
            <p className="text-sm text-white/80 mb-2">Neuer Subuser (Discord-ID)</p>
            <div className="flex gap-2">
              <Input
                placeholder="z.B. 123456789012345678"
                value={newUser}
                onChange={e => setNewUser(e.target.value.trim())}
                maxLength={20}
              />
              <Button
                disabled={!/^\d{17,20}$/.test(newUser) || setScope.isPending}
                onClick={() => {
                  if (data.availableScopes.length === 0) return;
                  setScope.mutate(
                    { user: newUser, scope: data.availableScopes[0], on: true },
                    { onSuccess: () => setNewUser('') },
                  );
                }}
              >
                Hinzufuegen
              </Button>
            </div>
            <p className="text-muted text-xs mt-2">
              <X className="inline h-3 w-3" /> Erst-Scope wird gesetzt; weitere Permissions per Checkbox aktivieren.
            </p>
          </div>
        </>
      )}
    </Card>
  );
}
