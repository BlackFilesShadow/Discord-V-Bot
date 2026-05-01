import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, KeyRound, Server as ServerIcon, Shield, AlertTriangle, ChevronRight, Ticket, Settings2, Send, Power, Tag, Activity } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Shell } from '@/components/Shell';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useGuildLiveUpdates } from '@/lib/useGuildLiveUpdates';

type Tab = 'nitrado' | 'aliases' | 'permissions' | 'tickets' | 'audit';

interface TabDef {
  key: Tab;
  label: string;
  icon: typeof ServerIcon;
  ownerOnly?: boolean;
}

const TABS: ReadonlyArray<TabDef> = [
  { key: 'nitrado', label: 'Nitrado-Slots', icon: Settings2 },
  { key: 'aliases', label: 'Server-Aliase', icon: Tag, ownerOnly: true },
  { key: 'permissions', label: 'Berechtigungen', icon: Shield, ownerOnly: true },
  { key: 'tickets', label: 'Tickets', icon: Ticket },
  { key: 'audit', label: 'Audit-Log', icon: Activity, ownerOnly: true },
];

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

  const tabs = TABS;

  const isOwner = dash.data?.isOwner ?? false;
  const visibleTabs = tabs.filter(t => !t.ownerOnly || isOwner);

  const sidebar = (
    <nav className="space-y-1" aria-label="Server-Bereiche">
      {visibleTabs.map(t => {
        const Icon = t.icon;
        const active = tab === t.key;
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium text-left transition-colors focus-ring ${
              active
                ? 'bg-accent/15 text-accent border border-accent/30 shadow-glow-sm'
                : 'text-muted hover:text-white hover:bg-bg-elev border border-transparent'
            }`}
            aria-current={active ? 'page' : undefined}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="truncate">{t.label}</span>
          </button>
        );
      })}
    </nav>
  );

  return (
    <Shell title={dash.data?.alias5 ? `Server ${dash.data.alias5}` : 'Server'} back="/servers" sidebar={sidebar}>
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

            {tab === 'nitrado' && guildId && <NitradoTab guildId={guildId} isOwner={isOwner} slots={dash.data.slots} />}
            {tab === 'aliases' && guildId && isOwner && <AliasesTab guildId={guildId} slots={dash.data.slots} />}
            {tab === 'permissions' && guildId && isOwner && <PermissionsTab guildId={guildId} />}
            {tab === 'tickets' && guildId && <TicketsTab guildId={guildId} isOwner={isOwner} />}
            {tab === 'audit' && guildId && isOwner && <AuditTab guildId={guildId} />}
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
  const [showService, setShowService] = useState(false);
  const noService = !slot.nitradoServerId;
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
            {noService && (
              <span className="text-[10px] font-semibold text-warn bg-warn/10 border border-warn/30 px-1.5 py-0.5 rounded inline-flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" /> Service fehlt
              </span>
            )}
          </div>
          <p className="text-xs text-muted mt-0.5 inline-flex items-center gap-1">
            <ServerIcon className="h-3 w-3" /> Nitrado-Service: {slot.nitradoServerId ?? '—'}
          </p>
          {noService && (
            <p className="text-[11px] text-warn mt-1">
              Ohne Service-ID schlagen Whitelist-Sync und ADM-Sync fehl. Bitte Service verknuepfen.
            </p>
          )}
        </div>
        <div className="flex flex-col sm:flex-row gap-1.5 shrink-0">
          <Link to={`/servers/${guildId}/server/${slot.slot}`}>
            <Button size="sm" variant="outline">
              Konfigurieren <ChevronRight className="h-3.5 w-3.5 ml-1" />
            </Button>
          </Link>
          <Button size="sm" variant={noService ? 'primary' : 'ghost'} onClick={() => setShowService(s => !s)} title="Nitrado-Service verknuepfen">
            <ServerIcon className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setShowToken(t => !t)} title="Token rotieren">
            <KeyRound className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="danger" onClick={onDelete}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      {showToken && <UpdateTokenForm guildId={guildId} slot={slot.slot} onDone={() => setShowToken(false)} />}
      {showService && <ServicePicker guildId={guildId} slot={slot.slot} current={slot.nitradoServerId} onDone={() => setShowService(false)} />}
    </Card>
  );
}

interface NitradoService {
  id: number | string;
  status?: string;
  details?: { name?: string; address?: string; game?: string };
}

function ServicePicker({ guildId, slot, current, onDone }: { guildId: string; slot: number; current: string | null; onDone: () => void }) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string>(current ?? '');
  const [err, setErr] = useState<string | null>(null);

  const services = useQuery({
    queryKey: ['nitrado-services', guildId, slot],
    queryFn: () => api.get<{ services: NitradoService[] }>(`/api/v2/guilds/${guildId}/nitrado/${slot}/services`),
    staleTime: 60_000,
  });

  const mut = useMutation({
    mutationFn: (id: string | null) => api.patch(`/api/v2/guilds/${guildId}/nitrado/${slot}/service`, { nitradoServerId: id }),
    onSuccess: () => {
      setErr(null);
      void qc.invalidateQueries({ queryKey: ['dashboard', guildId] });
      onDone();
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Unbekannter Fehler'),
  });

  return (
    <div className="mt-4 pt-4 border-t border-border">
      <label className="text-xs text-muted mb-2 block">
        Nitrado-Service auswaehlen (Liste kommt vom Nitrado-Account des Tokens)
      </label>
      {services.isLoading && <p className="text-xs text-muted">Lade Services...</p>}
      {services.isError && <p className="text-xs text-danger">Konnte Services nicht laden: {services.error instanceof ApiError ? services.error.message : 'Fehler'}</p>}
      {services.data && (
        <div className="flex flex-col sm:flex-row gap-2">
          <Select value={selected} onChange={e => setSelected(e.target.value)} className="flex-1">
            <option value="">— keine Verknuepfung —</option>
            {services.data.services.map(s => (
              <option key={String(s.id)} value={String(s.id)}>
                #{s.id} {s.details?.name ? `· ${s.details.name}` : ''}{s.details?.game ? ` · ${s.details.game}` : ''}{s.status ? ` · ${s.status}` : ''}
              </option>
            ))}
          </Select>
          <Button
            size="sm"
            onClick={() => mut.mutate(selected || null)}
            disabled={mut.isPending || selected === (current ?? '')}
            loading={mut.isPending}
          >
            Speichern
          </Button>
          <Button size="sm" variant="ghost" onClick={onDone}>Abbrechen</Button>
        </div>
      )}
      {err && <p className="text-danger text-xs mt-2">{err}</p>}
    </div>
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

// ============================================================================
// Tickets — Guild-Level-Support-Ticket-Templates (max 5)
// ============================================================================

interface TicketTemplate {
  id: string;
  slot: number;
  label: string;
  welcomeText: string;
  embedTitle: string;
  embedColor: string;
  postChannelId: string;
  postedMessageId: string | null;
  categoryId: string | null;
  staffRoleId: string | null;
  transcriptChannelId: string;
  isActive: boolean;
}

interface DiscordChannel { id: string; name: string; type: number; parentId: string | null }
interface DiscordRole { id: string; name: string; color: string; position: number; managed: boolean }

function TicketsTab({ guildId, isOwner }: { guildId: string; isOwner: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['tickets', guildId],
    queryFn: () => api.get<{ templates: TicketTemplate[]; max: number }>(`/api/v2/guilds/${guildId}/tickets`),
  });
  const channelsQ = useQuery({
    queryKey: ['guild-channels', guildId],
    queryFn: () => api.get<{ channels: DiscordChannel[] }>(`/api/v2/guilds/${guildId}/channels`),
    enabled: isOwner,
  });
  const rolesQ = useQuery({
    queryKey: ['guild-roles', guildId],
    queryFn: () => api.get<{ roles: DiscordRole[] }>(`/api/v2/guilds/${guildId}/roles`),
    enabled: isOwner,
  });

  const [editing, setEditing] = useState<{ slot: number; existing: TicketTemplate | null } | null>(null);

  if (!isOwner) {
    return (
      <Card glow>
        <CardHeader><CardTitle>Nicht erlaubt</CardTitle></CardHeader>
        <p className="text-muted text-sm">Nur der Discord-Server-Owner kann Ticket-Templates verwalten.</p>
      </Card>
    );
  }

  const templates = q.data?.templates ?? [];
  const slots = [1, 2, 3, 4, 5] as const;
  const bySlot = new Map(templates.map(t => [t.slot, t]));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-lg font-semibold text-white">Ticket-Templates ({templates.length}/5)</h2>
        <p className="text-xs text-muted">Pro Slot ein Template. Embed mit Open-Button wird im konfigurierten Channel gepostet.</p>
      </div>

      {q.isLoading && <div className="h-24 rounded-xl skeleton" />}
      {q.isError && (
        <Card glow>
          <p className="text-danger font-medium">Fehler beim Laden.</p>
          <p className="text-muted text-sm mt-1">{(q.error as Error).message}</p>
        </Card>
      )}

      <div className="grid gap-3">
        {slots.map(slot => {
          const t = bySlot.get(slot) ?? null;
          return (
            <TicketSlotCard
              key={slot}
              slot={slot}
              template={t}
              channels={channelsQ.data?.channels ?? []}
              onEdit={() => setEditing({ slot, existing: t })}
              onDelete={async () => {
                if (!t) return;
                if (!confirm(`Template "${t.label}" wirklich löschen? Alle zugehörigen Tickets werden ebenfalls entfernt.`)) return;
                await api.del(`/api/v2/guilds/${guildId}/tickets/${t.id}`);
                qc.invalidateQueries({ queryKey: ['tickets', guildId] });
              }}
              onPost={async () => {
                if (!t) return;
                try {
                  await api.post(`/api/v2/guilds/${guildId}/tickets/${t.id}/post`);
                  qc.invalidateQueries({ queryKey: ['tickets', guildId] });
                  alert('Embed gepostet/aktualisiert.');
                } catch (e) {
                  alert(e instanceof ApiError ? e.message : 'Fehler');
                }
              }}
              onToggle={async () => {
                if (!t) return;
                await api.put(`/api/v2/guilds/${guildId}/tickets/${t.id}`, { isActive: !t.isActive });
                qc.invalidateQueries({ queryKey: ['tickets', guildId] });
              }}
            />
          );
        })}
      </div>

      {editing && (
        <TicketEditModal
          guildId={guildId}
          slot={editing.slot}
          existing={editing.existing}
          channels={channelsQ.data?.channels ?? []}
          roles={rolesQ.data?.roles ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['tickets', guildId] });
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function TicketSlotCard({
  slot, template, channels, onEdit, onDelete, onPost, onToggle,
}: {
  slot: number;
  template: TicketTemplate | null;
  channels: DiscordChannel[];
  onEdit: () => void;
  onDelete: () => void;
  onPost: () => void;
  onToggle: () => void;
}) {
  const channelName = (id: string | null) => id ? (channels.find(c => c.id === id)?.name ?? id) : '—';

  if (!template) {
    return (
      <Card className="!p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-md bg-bg-elev grid place-items-center text-muted font-bold text-sm shrink-0 border border-border">
              #{slot}
            </div>
            <div>
              <h3 className="font-semibold text-white">Slot {slot} (frei)</h3>
              <p className="text-xs text-muted">Kein Template angelegt.</p>
            </div>
          </div>
          <Button size="sm" onClick={onEdit}><Plus className="h-4 w-4 mr-1" /> Anlegen</Button>
        </div>
      </Card>
    );
  }

  return (
    <Card className="!p-4">
      <div className="flex items-start gap-3 flex-wrap">
        <div className="h-10 w-10 rounded-md grid place-items-center font-bold text-sm shrink-0 border" style={{ backgroundColor: template.embedColor + '22', borderColor: template.embedColor + '55', color: template.embedColor }}>
          #{template.slot}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-semibold text-white truncate">{template.label}</h3>
            {!template.isActive && <span className="text-[10px] bg-warn/20 text-warn px-1.5 py-0.5 rounded">inaktiv</span>}
            {template.postedMessageId && <span className="text-[10px] bg-ok/20 text-ok px-1.5 py-0.5 rounded">gepostet</span>}
          </div>
          <p className="text-xs text-muted mt-1 truncate">{template.embedTitle}</p>
          <div className="text-xs text-muted mt-2 space-y-0.5">
            <div>Post-Channel: <span className="text-white">#{channelName(template.postChannelId)}</span></div>
            <div>Transcript: <span className="text-white">#{channelName(template.transcriptChannelId)}</span></div>
            {template.categoryId && <div>Kategorie: <span className="text-white">{channelName(template.categoryId)}</span></div>}
          </div>
        </div>
        <div className="flex flex-col sm:flex-row gap-1.5 shrink-0">
          <Button size="sm" variant="outline" onClick={onPost}><Send className="h-3.5 w-3.5 mr-1" /> Posten</Button>
          <Button size="sm" variant="ghost" onClick={onToggle} title={template.isActive ? 'Deaktivieren' : 'Aktivieren'}><Power className="h-3.5 w-3.5" /></Button>
          <Button size="sm" variant="outline" onClick={onEdit}>Bearbeiten</Button>
          <Button size="sm" variant="danger" onClick={onDelete}><Trash2 className="h-3.5 w-3.5" /></Button>
        </div>
      </div>
    </Card>
  );
}

function TicketEditModal({
  guildId, slot, existing, channels, roles, onClose, onSaved,
}: {
  guildId: string;
  slot: number;
  existing: TicketTemplate | null;
  channels: DiscordChannel[];
  roles: DiscordRole[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState(existing?.label ?? 'Support');
  const [welcomeText, setWelcomeText] = useState(existing?.welcomeText ?? 'Hallo! Ein Team-Mitglied meldet sich gleich.');
  const [embedTitle, setEmbedTitle] = useState(existing?.embedTitle ?? 'Support-Ticket öffnen');
  const [embedColor, setEmbedColor] = useState(existing?.embedColor ?? '#dc2626');
  const [postChannelId, setPostChannelId] = useState(existing?.postChannelId ?? '');
  const [transcriptChannelId, setTranscriptChannelId] = useState(existing?.transcriptChannelId ?? '');
  const [categoryId, setCategoryId] = useState(existing?.categoryId ?? '');
  const [staffRoleId, setStaffRoleId] = useState(existing?.staffRoleId ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const textChannels = channels.filter(c => c.type === 0 || c.type === 5);
  const categories = channels.filter(c => c.type === 4);

  const save = async () => {
    setErr(null);
    setBusy(true);
    try {
      const body = {
        slot,
        label,
        welcomeText,
        embedTitle,
        embedColor,
        postChannelId,
        transcriptChannelId,
        categoryId: categoryId || null,
        staffRoleId: staffRoleId || null,
      };
      if (existing) {
        await api.put(`/api/v2/guilds/${guildId}/tickets/${existing.id}`, body);
      } else {
        await api.post(`/api/v2/guilds/${guildId}/tickets`, body);
      }
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Unbekannter Fehler');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <div className="bg-bg-card border border-border rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="p-5 border-b border-border">
          <h2 className="text-lg font-semibold text-white">{existing ? 'Template bearbeiten' : 'Neues Template'} (Slot {slot})</h2>
        </div>
        <div className="p-5 space-y-4">
          <label className="block">
            <span className="text-xs text-muted">Label (Knopf-Beschriftung)</span>
            <Input value={label} onChange={e => setLabel(e.target.value)} maxLength={80} />
          </label>
          <label className="block">
            <span className="text-xs text-muted">Embed-Titel</span>
            <Input value={embedTitle} onChange={e => setEmbedTitle(e.target.value)} maxLength={200} />
          </label>
          <label className="block">
            <span className="text-xs text-muted">Embed-Farbe</span>
            <div className="flex gap-2 items-center">
              <input type="color" value={embedColor} onChange={e => setEmbedColor(e.target.value)} className="h-10 w-16 rounded bg-bg-elev border border-border" />
              <Input value={embedColor} onChange={e => setEmbedColor(e.target.value)} className="flex-1" />
            </div>
          </label>
          <label className="block">
            <span className="text-xs text-muted">Begrüßungstext (im erstellten Ticket-Channel)</span>
            <textarea
              value={welcomeText}
              onChange={e => setWelcomeText(e.target.value)}
              maxLength={4000}
              rows={4}
              className="mt-1 w-full rounded-md bg-bg-elev border border-border text-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50"
            />
          </label>
          <label className="block">
            <span className="text-xs text-muted">Post-Channel (wo der Embed mit Open-Button lebt)</span>
            <Select value={postChannelId} onChange={e => setPostChannelId(e.target.value)}>
              <option value="">— wählen —</option>
              {textChannels.map(c => <option key={c.id} value={c.id}>#{c.name}</option>)}
            </Select>
          </label>
          <label className="block">
            <span className="text-xs text-muted">Transcript-Channel (Markdown-Datei beim Schließen)</span>
            <Select value={transcriptChannelId} onChange={e => setTranscriptChannelId(e.target.value)}>
              <option value="">— wählen —</option>
              {textChannels.map(c => <option key={c.id} value={c.id}>#{c.name}</option>)}
            </Select>
          </label>
          <label className="block">
            <span className="text-xs text-muted">Kategorie für Ticket-Channels (optional)</span>
            <Select value={categoryId} onChange={e => setCategoryId(e.target.value)}>
              <option value="">— keine —</option>
              {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </label>
          <label className="block">
            <span className="text-xs text-muted">Staff-Rolle (Mit-Zugriff + Mention, optional)</span>
            <Select value={staffRoleId} onChange={e => setStaffRoleId(e.target.value)}>
              <option value="">— keine —</option>
              {roles.filter(r => !r.managed).map(r => <option key={r.id} value={r.id}>@{r.name}</option>)}
            </Select>
          </label>
          {err && <p className="text-danger text-xs">{err}</p>}
        </div>
        <div className="p-5 border-t border-border flex gap-2 justify-end">
          <Button variant="ghost" onClick={onClose}>Abbrechen</Button>
          <Button
            onClick={save}
            disabled={busy || !label || !welcomeText || !embedTitle || !postChannelId || !transcriptChannelId || !/^#[0-9a-fA-F]{6}$/.test(embedColor)}
            loading={busy}
          >
            Speichern
          </Button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Server-Aliase — Owner kann Anzeige-Namen der Slots umbenennen (alias5 fix)
// ============================================================================

function AliasesTab({ guildId, slots }: { guildId: string; slots: Slot[] }) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Server-Aliase</CardTitle>
        </CardHeader>
        <CardDesc>
          Vergibt fuer jeden belegten Slot einen frei waehlbaren Anzeigenamen (1–40 Zeichen).
          Die 5-stellige System-Kennung <span className="font-mono">alias5</span> bleibt davon unberuehrt.
        </CardDesc>
      </Card>

      {slots.length === 0 && (
        <Card>
          <p className="text-muted text-sm">
            Noch keine Slots eingerichtet. Lege zuerst im Tab <em>Nitrado-Slots</em> einen Slot an.
          </p>
        </Card>
      )}

      <div className="grid gap-3">
        {slots
          .slice()
          .sort((a, b) => a.slot - b.slot)
          .map(s => (
            <AliasRow key={s.id} guildId={guildId} slot={s} />
          ))}
      </div>
    </div>
  );
}

function AliasRow({ guildId, slot }: { guildId: string; slot: Slot }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState(slot.alias);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const save = useMutation({
    mutationFn: (alias: string) =>
      api.patch(`/api/v2/guilds/${guildId}/nitrado/${slot.slot}/alias`, { alias }),
    onSuccess: () => {
      setMsg({ ok: true, text: 'Alias gespeichert.' });
      void qc.invalidateQueries({ queryKey: ['dashboard', guildId] });
    },
    onError: (e: unknown) => {
      const text = e instanceof ApiError ? e.message : (e instanceof Error ? e.message : 'Fehler.');
      setMsg({ ok: false, text });
    },
  });

  const trimmed = draft.trim();
  const isValid = trimmed.length >= 1 && trimmed.length <= 40;
  const dirty = trimmed !== slot.alias;

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3">
        <div className="shrink-0 px-2 py-1 rounded bg-bg-elev border border-border text-xs">
          Slot #{slot.slot}
        </div>
        <div className="shrink-0 px-2 py-1 rounded bg-accent/15 text-accent text-xs font-mono">
          {slot.alias5}
        </div>
        <div className="flex-1 min-w-[180px]">
          <Input
            value={draft}
            onChange={e => { setDraft(e.target.value); setMsg(null); }}
            maxLength={40}
            placeholder="Anzeigename"
          />
        </div>
        <Button
          onClick={() => { setMsg(null); save.mutate(trimmed); }}
          disabled={save.isPending || !isValid || !dirty}
          loading={save.isPending}
        >
          Speichern
        </Button>
      </div>
      {msg && (
        <p className={`text-xs mt-2 ${msg.ok ? 'text-green-400' : 'text-danger'}`}>{msg.text}</p>
      )}
      {slot.status !== 'ACTIVE' && (
        <p className="text-xs mt-2 text-amber-400 inline-flex items-center gap-1">
          <AlertTriangle className="h-3 w-3" /> Slot-Status: {slot.status}
        </p>
      )}
    </Card>
  );
}
// ============================================================================
// Audit-Log (Owner-only)
// ============================================================================

interface AuditEntry {
  id: string;
  action: string;
  category: string;
  createdAt: string;
  actor: { discordId: string; username: string | null } | null;
  target: { discordId: string; username: string | null } | null;
  channelId: string | null;
  details: unknown;
}

interface AuditPage {
  entries: AuditEntry[];
  limit: number;
  hasMore: boolean;
}

interface AuditCategoriesResp {
  categories: { category: string; count: number }[];
}

function AuditTab({ guildId }: { guildId: string }) {
  const [category, setCategory] = useState<string>('');
  const [actionFilter, setActionFilter] = useState<string>('');
  const [pages, setPages] = useState<AuditEntry[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const cats = useQuery({
    queryKey: ['audit-cats', guildId],
    queryFn: () => api.get<AuditCategoriesResp>(`/api/v2/guilds/${guildId}/audit/categories`),
  });

  const qs = new URLSearchParams();
  qs.set('limit', '50');
  if (category) qs.set('category', category);
  if (actionFilter.trim()) qs.set('action', actionFilter.trim());
  if (cursor) qs.set('before', cursor);
  const qsKey = qs.toString();

  const list = useQuery({
    queryKey: ['audit', guildId, qsKey],
    queryFn: async () => {
      const data = await api.get<AuditPage>(`/api/v2/guilds/${guildId}/audit?${qsKey}`);
      setPages(prev => cursor ? [...prev, ...data.entries] : data.entries);
      return data;
    },
  });

  function resetAndReload() {
    setCursor(undefined);
    setPages([]);
    list.refetch();
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Audit-Log</CardTitle>
          <CardDesc>Letzte Aktionen in diesem Server (nur fuer Owner sichtbar).</CardDesc>
        </CardHeader>
        <div className="grid sm:grid-cols-3 gap-3 mt-3">
          <div>
            <label className="block text-xs text-muted mb-1">Kategorie</label>
            <Select value={category} onChange={e => { setCategory(e.target.value); setCursor(undefined); setPages([]); }}>
              <option value="">Alle</option>
              {cats.data?.categories.map(c => (
                <option key={c.category} value={c.category}>{c.category} ({c.count})</option>
              ))}
            </Select>
          </div>
          <div className="sm:col-span-2">
            <label className="block text-xs text-muted mb-1">Aktion enthaelt</label>
            <div className="flex gap-2">
              <Input value={actionFilter} onChange={e => setActionFilter(e.target.value)} placeholder="z.B. TICKET_TEMPLATE_" />
              <Button onClick={resetAndReload} disabled={list.isFetching}>Suchen</Button>
            </div>
          </div>
        </div>
      </Card>

      {list.isLoading && pages.length === 0 && <div className="h-24 rounded-xl skeleton" />}
      {list.isError && (
        <Card>
          <p className="text-danger text-sm">Fehler: {(list.error as ApiError).message}</p>
        </Card>
      )}

      {pages.length === 0 && !list.isLoading && (
        <Card><p className="text-muted text-sm">Keine Eintraege.</p></Card>
      )}

      {pages.length > 0 && (
        <Card>
          <ul className="divide-y divide-border">
            {pages.map(e => {
              const expanded = !!open[e.id];
              const date = new Date(e.createdAt);
              return (
                <li key={e.id} className="py-2">
                  <button
                    type="button"
                    onClick={() => setOpen(o => ({ ...o, [e.id]: !o[e.id] }))}
                    className="w-full text-left flex items-start gap-3 hover:bg-bg-elev/40 rounded px-2 py-1 focus-ring"
                  >
                    <span className="text-xs text-muted shrink-0 w-32 tabular-nums">{date.toLocaleString()}</span>
                    <span className="text-xs px-1.5 py-0.5 rounded bg-accent/15 text-accent shrink-0">{e.category}</span>
                    <span className="font-medium text-white text-sm flex-1 truncate">{e.action}</span>
                    <span className="text-xs text-muted truncate max-w-[12rem]">
                      {e.actor?.username ?? e.actor?.discordId ?? '—'}
                    </span>
                  </button>
                  {expanded && (
                    <pre className="ml-2 mt-2 p-2 rounded bg-bg/60 border border-border text-xs text-muted overflow-x-auto">
{JSON.stringify({ actor: e.actor, target: e.target, channelId: e.channelId, details: e.details }, null, 2)}
                    </pre>
                  )}
                </li>
              );
            })}
          </ul>
          {list.data?.hasMore && (
            <div className="mt-3 flex justify-center">
              <Button
                onClick={() => {
                  const last = pages[pages.length - 1];
                  if (last) setCursor(last.createdAt);
                }}
                disabled={list.isFetching}
                loading={list.isFetching}
              >
                Mehr laden
              </Button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
