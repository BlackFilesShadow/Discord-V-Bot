import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, KeyRound, Server as ServerIcon, Shield, AlertTriangle, ChevronRight } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Shell } from '@/components/Shell';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useGuildLiveUpdates } from '@/lib/useGuildLiveUpdates';

type Tab = 'nitrado' | 'permissions' | 'tickets';

interface Slot {
  id: string;
  slot: number;
  alias: string;
  alias5: string;
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
  nitradoServerId: string | null;
  addedBy?: string;
  createdAt?: string;
}

interface Dashboard {
  guildId: string;
  alias5: string;
  isOwner: boolean;
  permissions: string[];
  slots: Slot[];
  grantsCount: number;
}

export default function Server() {
  const { guildId } = useParams<{ guildId: string }>();
  const [tab, setTab] = useState<Tab>('nitrado');
  useGuildLiveUpdates(guildId);

  const dash = useQuery({
    queryKey: ['dashboard', guildId],
    queryFn: () => api.get<Dashboard>(`/api/v2/guilds/${guildId}/dashboard`),
    enabled: !!guildId,
  });

  const tabs: ReadonlyArray<{ key: Tab; label: string; ownerOnly?: boolean }> = [
    { key: 'nitrado', label: 'Nitrado-Slots' },
    { key: 'permissions', label: 'Berechtigungen', ownerOnly: true },
    { key: 'tickets', label: 'Tickets' },
  ];

  const isOwner = dash.data?.isOwner ?? false;
  const visibleTabs = tabs.filter(t => !t.ownerOnly || isOwner);

  return (
    <Shell title={dash.data?.alias5 ? `Server ${dash.data.alias5}` : 'Server'} back="/servers">
      <div className="max-w-5xl mx-auto">
        {dash.isLoading && <div className="h-24 rounded-xl skeleton" />}
        {dash.isError && (
          <Card glow>
            <p className="text-danger font-medium">Fehler beim Laden des Servers.</p>
            <p className="text-muted text-sm mt-1">{(dash.error as Error).message}</p>
          </Card>
        )}
        {dash.data && (
          <>
            <header className="mb-6">
              <div className="flex flex-wrap items-center gap-3 mb-2">
                <h1 className="text-2xl sm:text-3xl font-bold text-white">{dash.data.alias5}</h1>
                {isOwner && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-accent/20 text-accent font-medium">
                    Owner
                  </span>
                )}
              </div>
              <p className="text-muted text-sm">{dash.data.slots.length} Slots &middot; {dash.data.grantsCount} delegierte Berechtigungen</p>
            </header>

            {/* Chip-Tabs (mobil-freundlich) */}
            <div className="flex flex-wrap gap-2 mb-6 -mx-1 px-1 overflow-x-auto">
              {visibleTabs.map(t => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  className={`px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-all focus-ring ${
                    tab === t.key
                      ? 'bg-accent text-white shadow-glow-sm'
                      : 'bg-bg-card text-muted hover:bg-bg-elev hover:text-white border border-border'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {tab === 'nitrado' && guildId && <NitradoTab guildId={guildId} isOwner={isOwner} slots={dash.data.slots} />}
            {tab === 'permissions' && guildId && isOwner && <PermissionsTab guildId={guildId} />}
            {tab === 'tickets' && (
              <Card>
                <CardHeader><CardTitle>Tickets</CardTitle><CardDesc>Funktion folgt in Kuerze.</CardDesc></CardHeader>
              </Card>
            )}
          </>
        )}
      </div>
    </Shell>
  );
}

// ============================================================================
// Nitrado-Slots
// ============================================================================

function statusColor(status: Slot['status']): string {
  if (status === 'ACTIVE') return 'text-ok';
  if (status === 'EXPIRED') return 'text-warn';
  return 'text-danger';
}

function NitradoTab({ guildId, isOwner, slots }: { guildId: string; isOwner: boolean; slots: Slot[] }) {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);

  const remove = useMutation({
    mutationFn: (slot: number) => api.del(`/api/v2/guilds/${guildId}/nitrado/${slot}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dashboard', guildId] }),
  });

  if (!isOwner) {
    return (
      <Card glow>
        <CardHeader><CardTitle>Nicht erlaubt</CardTitle></CardHeader>
        <p className="text-muted text-sm">Nur der Discord-Server-Owner kann Nitrado-Slots verwalten.</p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Nitrado-Slots ({slots.length}/5)</h2>
        {slots.length < 5 && (
          <Button onClick={() => setShowAdd(s => !s)} size="sm">
            <Plus className="h-4 w-4 mr-1" /> {showAdd ? 'Abbrechen' : 'Slot hinzufuegen'}
          </Button>
        )}
      </div>

      {showAdd && <AddSlotForm guildId={guildId} usedSlots={slots.map(s => s.slot)} onDone={() => setShowAdd(false)} />}

      {slots.length === 0 && !showAdd && (
        <Card>
          <CardHeader><CardTitle>Noch keine Slots</CardTitle><CardDesc>Lege deinen ersten Nitrado-Slot an.</CardDesc></CardHeader>
        </Card>
      )}

      <div className="grid gap-3">
        {slots.map(s => (
          <SlotRow key={s.id} guildId={guildId} slot={s} onDelete={() => {
            if (confirm(`Slot ${s.slot} (${s.alias}) wirklich loeschen? Alle Daten werden geloescht.`)) {
              remove.mutate(s.slot);
            }
          }} />
        ))}
      </div>
    </div>
  );
}

function SlotRow({ guildId, slot, onDelete }: { guildId: string; slot: Slot; onDelete: () => void }) {
  const [showToken, setShowToken] = useState(false);
  return (
    <Card className="!p-4">
      <div className="flex items-start gap-3">
        <div className="h-10 w-10 rounded-md bg-accent/15 grid place-items-center text-accent font-bold text-sm shrink-0 border border-accent/30">
          #{slot.slot}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-semibold text-white truncate">{slot.alias}</h3>
            <span className="font-mono text-[10px] text-muted bg-bg-elev px-1.5 py-0.5 rounded">{slot.alias5}</span>
            <span className={`text-xs font-medium ${statusColor(slot.status)}`}>{slot.status}</span>
          </div>
          <p className="text-xs text-muted mt-0.5 inline-flex items-center gap-1">
            <ServerIcon className="h-3 w-3" /> Nitrado-Service: {slot.nitradoServerId ?? '—'}
          </p>
        </div>
        <div className="flex flex-col sm:flex-row gap-1.5 shrink-0">
          <Link to={`/servers/${guildId}/server/${slot.slot}`}>
            <Button size="sm" variant="outline">
              Konfigurieren <ChevronRight className="h-3.5 w-3.5 ml-1" />
            </Button>
          </Link>
          <Button size="sm" variant="ghost" onClick={() => setShowToken(t => !t)}>
            <KeyRound className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="danger" onClick={onDelete}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      {showToken && <UpdateTokenForm guildId={guildId} slot={slot.slot} onDone={() => setShowToken(false)} />}
    </Card>
  );
}

function UpdateTokenForm({ guildId, slot, onDone }: { guildId: string; slot: number; onDone: () => void }) {
  const [token, setToken] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const qc = useQueryClient();
  const mut = useMutation({
    mutationFn: (t: string) => api.patch(`/api/v2/guilds/${guildId}/nitrado/${slot}/token`, { token: t }),
    onSuccess: () => {
      setToken(''); setErr(null);
      void qc.invalidateQueries({ queryKey: ['dashboard', guildId] });
      onDone();
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Unbekannter Fehler'),
  });

  return (
    <div className="mt-4 pt-4 border-t border-border">
      <label className="text-xs text-muted mb-2 block flex items-center gap-1">
        <AlertTriangle className="h-3 w-3 text-warn" />
        Neuen Nitrado-Token einfuegen (wird gegen Nitrado validiert, dann verschluesselt gespeichert)
      </label>
      <div className="flex flex-col sm:flex-row gap-2">
        <Input
          type="password"
          autoComplete="off"
          value={token}
          onChange={e => setToken(e.target.value)}
          placeholder="Nitrado API-Token"
          className="flex-1"
        />
        <Button
          onClick={() => mut.mutate(token)}
          disabled={token.length < 16 || mut.isPending}
          loading={mut.isPending}
          size="sm"
        >
          Aktualisieren
        </Button>
      </div>
      {err && <p className="text-danger text-xs mt-2">{err}</p>}
    </div>
  );
}

function AddSlotForm({ guildId, usedSlots, onDone }: { guildId: string; usedSlots: number[]; onDone: () => void }) {
  const free = [1, 2, 3, 4, 5].filter(n => !usedSlots.includes(n));
  const [slot, setSlot] = useState<number>(free[0] ?? 1);
  const [alias, setAlias] = useState('');
  const [token, setToken] = useState('');
  const [nitradoServerId, setNitradoServerId] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const qc = useQueryClient();

  const create = useMutation({
    mutationFn: () => api.post(`/api/v2/guilds/${guildId}/nitrado`, {
      slot,
      alias,
      token,
      nitradoServerId: nitradoServerId || undefined,
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['dashboard', guildId] });
      onDone();
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Unbekannter Fehler'),
  });

  return (
    <Card glow>
      <CardHeader>
        <CardTitle>Neuen Slot anlegen</CardTitle>
        <CardDesc>Token wird vor dem Speichern gegen die Nitrado-API geprueft.</CardDesc>
      </CardHeader>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs text-muted">Slot-Nummer</span>
          <select
            value={slot}
            onChange={e => setSlot(Number(e.target.value))}
            className="mt-1 w-full h-10 rounded-md bg-bg-elev border border-border text-white px-3 focus-ring"
          >
            {free.map(n => <option key={n} value={n}>#{n}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-muted">Alias (1-40 Zeichen)</span>
          <Input value={alias} onChange={e => setAlias(e.target.value)} maxLength={40} />
        </label>
        <label className="block sm:col-span-2">
          <span className="text-xs text-muted">Nitrado API-Token</span>
          <Input type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} />
        </label>
        <label className="block sm:col-span-2">
          <span className="text-xs text-muted">Nitrado Service-ID (optional)</span>
          <Input value={nitradoServerId} onChange={e => setNitradoServerId(e.target.value)} placeholder="z.B. 1234567" />
        </label>
      </div>
      {err && <p className="text-danger text-xs mt-3">{err}</p>}
      <div className="flex gap-2 mt-4">
        <Button
          onClick={() => create.mutate()}
          disabled={!alias || token.length < 16 || create.isPending}
          loading={create.isPending}
        >
          Slot anlegen
        </Button>
        <Button variant="ghost" onClick={onDone}>Abbrechen</Button>
      </div>
    </Card>
  );
}

// ============================================================================
// Permissions
// ============================================================================

interface Grant {
  userDiscordId: string;
  permissions: string[];
  grantedBy: string;
  updatedAt: string;
}

function PermissionsTab({ guildId }: { guildId: string }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['permissions', guildId],
    queryFn: () => api.get<{ grants: Grant[]; availableScopes: string[] }>(`/api/v2/guilds/${guildId}/permissions`),
  });
  const [newUser, setNewUser] = useState('');
  const [newScope, setNewScope] = useState('');

  const grant = useMutation({
    mutationFn: (vars: { user: string; scope: string }) =>
      api.put(`/api/v2/guilds/${guildId}/permissions/${vars.user}/${vars.scope}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['permissions', guildId] }),
  });
  const revoke = useMutation({
    mutationFn: (vars: { user: string; scope: string }) =>
      api.del(`/api/v2/guilds/${guildId}/permissions/${vars.user}/${vars.scope}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['permissions', guildId] }),
  });
  const purge = useMutation({
    mutationFn: (user: string) => api.del(`/api/v2/guilds/${guildId}/permissions/${user}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['permissions', guildId] }),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle><Shield className="h-4 w-4 inline mr-1" /> Berechtigung erteilen</CardTitle>
          <CardDesc>Gib einem Mitglied gezielte Rechte fuer dieses Dashboard.</CardDesc>
        </CardHeader>
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <Input value={newUser} onChange={e => setNewUser(e.target.value)} placeholder="Discord-ID" />
          <select
            value={newScope}
            onChange={e => setNewScope(e.target.value)}
            className="h-10 rounded-md bg-bg-elev border border-border text-white px-3 focus-ring"
          >
            <option value="">Scope waehlen…</option>
            {q.data?.availableScopes.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <Button
            disabled={!/^\d{17,20}$/.test(newUser) || !newScope || grant.isPending}
            loading={grant.isPending}
            onClick={() => grant.mutate({ user: newUser, scope: newScope })}
          >
            Erteilen
          </Button>
        </div>
      </Card>

      {q.isLoading && <div className="h-20 rounded-xl skeleton" />}

      {q.data && q.data.grants.length === 0 && (
        <p className="text-muted text-sm">Noch keine delegierten Rechte.</p>
      )}

      {q.data && q.data.grants.map(g => (
        <Card key={g.userDiscordId} className="!p-4">
          <div className="flex items-start gap-3 flex-wrap">
            <div className="min-w-0 flex-1">
              <code className="text-white text-sm">{g.userDiscordId}</code>
              <div className="flex flex-wrap gap-1 mt-2">
                {g.permissions.length === 0 && <span className="text-xs text-muted">— keine —</span>}
                {g.permissions.map(p => (
                  <button
                    key={p}
                    onClick={() => revoke.mutate({ user: g.userDiscordId, scope: p })}
                    className="text-[10px] bg-accent/20 text-accent hover:bg-danger/30 hover:text-danger px-2 py-0.5 rounded inline-flex items-center gap-1 transition-colors"
                    title="Entziehen"
                    type="button"
                  >
                    {p} <Trash2 className="h-2.5 w-2.5" />
                  </button>
                ))}
              </div>
            </div>
            <Button size="sm" variant="danger" onClick={() => {
              if (confirm(`Alle Rechte von ${g.userDiscordId} entfernen?`)) purge.mutate(g.userDiscordId);
            }}>
              Alle entziehen
            </Button>
          </div>
        </Card>
      ))}
    </div>
  );
}
