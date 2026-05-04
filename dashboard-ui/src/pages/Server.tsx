import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, KeyRound, Server as ServerIcon, Shield, AlertTriangle, ChevronRight, Ticket, Settings2, Send, Power, Tag, Activity, Users, Crosshair } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Shell } from '@/components/Shell';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { useToast } from '@/components/ui/Toast';
import { useGuildLiveUpdates } from '@/lib/useGuildLiveUpdates';
import { KillfeedTab } from '@/components/KillfeedTab';
import { FactionsTab } from '@/components/FactionsTab';

type Tab = 'nitrado' | 'aliases' | 'permissions' | 'tickets' | 'factions' | 'killfeed' | 'audit';

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
  { key: 'factions', label: 'Fraktionssystem', icon: Users },
  { key: 'killfeed', label: 'Killfeed', icon: Crosshair },
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
            {tab === 'factions' && guildId && <FactionsTab guildId={guildId} slots={dash.data.slots} />}
            {tab === 'killfeed' && guildId && <KillfeedTab guildId={guildId} isOwner={isOwner} slots={dash.data.slots} />}
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

interface RoleGrant {
  roleDiscordId: string;
  permissions: string[];
  grantedBy: string;
  updatedAt: string;
}

interface PermsResponse {
  grants: Grant[];
  roleGrants: RoleGrant[];
  availableScopes: string[];
}

interface MemberOption { id: string; username: string; displayName: string; avatar: string | null; bot: boolean }

function PermissionsTab({ guildId }: { guildId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ['permissions', guildId],
    queryFn: () => api.get<PermsResponse>(`/api/v2/guilds/${guildId}/permissions`),
  });
  const rolesQ = useQuery({
    queryKey: ['guild-roles', guildId],
    queryFn: () => api.get<{ roles: DiscordRole[] }>(`/api/v2/guilds/${guildId}/roles`),
  });

  const [mode, setMode] = useState<'user' | 'role'>('user');
  const [pickedUser, setPickedUser] = useState<string | null>(null);
  const [pickedRole, setPickedRole] = useState<string | null>(null);
  const [newScope, setNewScope] = useState('');
  const [memberQuery, setMemberQuery] = useState('');

  // Member-Suche server-seitig (Discord-API).
  const membersQ = useQuery({
    queryKey: ['guild-members', guildId, memberQuery],
    queryFn: () => api.get<{ members: MemberOption[] }>(
      `/api/v2/guilds/${guildId}/members?limit=20${memberQuery ? `&q=${encodeURIComponent(memberQuery)}` : ''}`,
    ),
    placeholderData: prev => prev,
  });

  const memberOptions: ComboboxOption[] = (membersQ.data?.members ?? []).map(m => ({
    id: m.id,
    label: m.displayName || m.username,
    hint: m.id,
    avatar: m.avatar
      ? `https://cdn.discordapp.com/avatars/${m.id}/${m.avatar}.png?size=64`
      : `https://cdn.discordapp.com/embed/avatars/${(BigInt(m.id) >> 22n) % 6n}.png`,
    disabled: m.bot,
  }));

  const roleOptions: ComboboxOption[] = (rolesQ.data?.roles ?? [])
    .filter(r => r.id !== guildId && !r.managed) // @everyone hat dieselbe ID wie die Guild + managed-Bots filtern.
    .sort((a, b) => b.position - a.position)
    .map(r => ({
      id: r.id,
      label: r.name,
      hint: r.id,
      color: r.color && r.color !== '#000000' ? r.color : null,
    }));

  const grant = useMutation({
    mutationFn: (vars: { user: string; scope: string }) =>
      api.put(`/api/v2/guilds/${guildId}/permissions/${vars.user}/${vars.scope}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['permissions', guildId] }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Berechtigung konnte nicht erteilt werden.'),
  });
  const revoke = useMutation({
    mutationFn: (vars: { user: string; scope: string }) =>
      api.del(`/api/v2/guilds/${guildId}/permissions/${vars.user}/${vars.scope}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['permissions', guildId] }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Berechtigung konnte nicht entzogen werden.'),
  });
  const purge = useMutation({
    mutationFn: (user: string) => api.del(`/api/v2/guilds/${guildId}/permissions/${user}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['permissions', guildId] }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Entzug fehlgeschlagen.'),
  });
  const grantRole = useMutation({
    mutationFn: (vars: { role: string; scope: string }) =>
      api.put(`/api/v2/guilds/${guildId}/permissions/roles/${vars.role}/${vars.scope}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['permissions', guildId] }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Rolle konnte nicht berechtigt werden.'),
  });
  const revokeRole = useMutation({
    mutationFn: (vars: { role: string; scope: string }) =>
      api.del(`/api/v2/guilds/${guildId}/permissions/roles/${vars.role}/${vars.scope}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['permissions', guildId] }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Entzug fehlgeschlagen.'),
  });
  const purgeRole = useMutation({
    mutationFn: (role: string) => api.del(`/api/v2/guilds/${guildId}/permissions/roles/${role}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['permissions', guildId] }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Entzug fehlgeschlagen.'),
  });

  function submit(): void {
    if (!newScope) return;
    if (mode === 'user' && pickedUser) {
      grant.mutate({ user: pickedUser, scope: newScope }, {
        onSuccess: () => { setPickedUser(null); setNewScope(''); },
      });
    } else if (mode === 'role' && pickedRole) {
      grantRole.mutate({ role: pickedRole, scope: newScope }, {
        onSuccess: () => { setPickedRole(null); setNewScope(''); },
      });
    }
  }

  const canSubmit =
    !!newScope &&
    ((mode === 'user' && !!pickedUser) || (mode === 'role' && !!pickedRole)) &&
    !grant.isPending && !grantRole.isPending;

  const roleNameById = (id: string): { name: string; color: string | null } => {
    const r = rolesQ.data?.roles.find(x => x.id === id);
    if (!r) return { name: id, color: null };
    return { name: r.name, color: r.color && r.color !== '#000000' ? r.color : null };
  };

  // Cache aller bisher gesehenen Member fuer Username-Anzeige in Grant-Listen.
  const memberMap = new Map<string, MemberOption>();
  for (const m of (membersQ.data?.members ?? [])) memberMap.set(m.id, m);
  const userLabel = (id: string): string => {
    const m = memberMap.get(id);
    if (m) return m.displayName || m.username;
    return `User ${id}`;
  };
  const userAvatar = (id: string): string => {
    const m = memberMap.get(id);
    if (m?.avatar) return `https://cdn.discordapp.com/avatars/${id}/${m.avatar}.png?size=64`;
    return `https://cdn.discordapp.com/embed/avatars/${(BigInt(id) >> 22n) % 6n}.png`;
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle><Shield className="h-4 w-4 inline mr-1" /> Berechtigung erteilen</CardTitle>
          <CardDesc>Direkt aus der Mitglieder- bzw. Rollen-Liste deines Servers auswaehlen.</CardDesc>
        </CardHeader>

        <div className="inline-flex rounded-lg bg-bg-elev border border-border p-1 mb-3">
          {(['user', 'role'] as const).map(m => (
            <button
              key={m}
              type="button"
              onClick={() => { setMode(m); setPickedUser(null); setPickedRole(null); }}
              className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
                mode === m ? 'bg-accent/20 text-accent' : 'text-muted hover:text-white'
              }`}
            >
              {m === 'user' ? 'Mitglied' : 'Rolle'}
            </button>
          ))}
        </div>

        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          {mode === 'user' ? (
            <Combobox
              value={pickedUser}
              onChange={id => setPickedUser(id)}
              options={memberOptions}
              onSearch={setMemberQuery}
              loading={membersQ.isFetching}
              placeholder="Mitglied suchen..."
              emptyText={memberQuery ? 'Keine Treffer.' : 'Tippe einen Namen...'}
            />
          ) : (
            <Combobox
              value={pickedRole}
              onChange={id => setPickedRole(id)}
              options={roleOptions}
              loading={rolesQ.isLoading}
              placeholder="Rolle waehlen..."
              emptyText="Keine Rollen verfuegbar."
            />
          )}
          <select
            value={newScope}
            onChange={e => setNewScope(e.target.value)}
            className="h-10 rounded-md bg-bg-elev border border-border text-white px-3 focus-ring"
          >
            <option value="">Scope waehlen…</option>
            {q.data?.availableScopes.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <Button
            disabled={!canSubmit}
            loading={grant.isPending || grantRole.isPending}
            onClick={submit}
          >
            Erteilen
          </Button>
        </div>
      </Card>

      {q.isLoading && <div className="h-20 rounded-xl skeleton" />}

      {/* User-Grants */}
      <div className="space-y-2">
        <h3 className="text-xs uppercase tracking-wider text-muted px-1">Mitglieder ({q.data?.grants.length ?? 0})</h3>
        {q.data && q.data.grants.length === 0 && (
          <p className="text-muted text-sm">Noch keine delegierten Mitglieder-Rechte.</p>
        )}
        {q.data && q.data.grants.map(g => (
          <Card key={g.userDiscordId} className="!p-4">
            <div className="flex items-start gap-3 flex-wrap">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 min-w-0">
                  <img src={userAvatar(g.userDiscordId)} alt="" className="h-7 w-7 rounded-full shrink-0" loading="lazy" />
                  <div className="min-w-0">
                    <p className="text-white text-sm font-medium truncate">{userLabel(g.userDiscordId)}</p>
                    <code className="text-[10px] text-muted font-mono">{g.userDiscordId}</code>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1 mt-2">
                  {g.permissions.length === 0 && <span className="text-xs text-muted">— keine —</span>}
                  {g.permissions.map(p => (
                    <button
                      key={p}
                      onClick={() => revoke.mutate({ user: g.userDiscordId, scope: p })}
                      disabled={revoke.isPending}
                      className="text-[10px] bg-accent/20 text-accent hover:bg-danger/30 hover:text-danger px-2 py-0.5 rounded inline-flex items-center gap-1 transition-colors disabled:opacity-50"
                      title={`Berechtigung ${p} entziehen`}
                      aria-label={`Berechtigung ${p} von ${userLabel(g.userDiscordId)} entziehen`}
                      type="button"
                    >
                      {p} <Trash2 className="h-2.5 w-2.5" />
                    </button>
                  ))}
                </div>
              </div>
              <Button size="sm" variant="danger" disabled={purge.isPending} onClick={() => {
                if (confirm(`Alle Rechte von ${userLabel(g.userDiscordId)} (${g.userDiscordId}) entfernen?`)) purge.mutate(g.userDiscordId);
              }}>
                Alle entziehen
              </Button>
            </div>
          </Card>
        ))}
      </div>

      {/* Role-Grants */}
      <div className="space-y-2">
        <h3 className="text-xs uppercase tracking-wider text-muted px-1">Rollen ({q.data?.roleGrants.length ?? 0})</h3>
        {q.data && q.data.roleGrants.length === 0 && (
          <p className="text-muted text-sm">Noch keine Rollen-basierten Rechte.</p>
        )}
        {q.data && q.data.roleGrants.map(g => {
          const r = roleNameById(g.roleDiscordId);
          return (
            <Card key={g.roleDiscordId} className="!p-4">
              <div className="flex items-start gap-3 flex-wrap">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    {r.color && (
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ background: r.color, boxShadow: `0 0 8px ${r.color}66` }}
                      />
                    )}
                    <span className="text-white text-sm font-medium" style={r.color ? { color: r.color } : undefined}>
                      @{r.name}
                    </span>
                    <code className="text-[10px] text-muted font-mono">{g.roleDiscordId}</code>
                  </div>
                  <div className="flex flex-wrap gap-1 mt-2">
                    {g.permissions.length === 0 && <span className="text-xs text-muted">— keine —</span>}
                    {g.permissions.map(p => (
                      <button
                        key={p}
                        onClick={() => revokeRole.mutate({ role: g.roleDiscordId, scope: p })}
                        disabled={revokeRole.isPending}
                        className="text-[10px] bg-accent/20 text-accent hover:bg-danger/30 hover:text-danger px-2 py-0.5 rounded inline-flex items-center gap-1 transition-colors disabled:opacity-50"
                        title={`Berechtigung ${p} entziehen`}
                        aria-label={`Berechtigung ${p} von Rolle @${r.name} entziehen`}
                        type="button"
                      >
                        {p} <Trash2 className="h-2.5 w-2.5" />
                      </button>
                    ))}
                  </div>
                </div>
                <Button size="sm" variant="danger" disabled={purgeRole.isPending} onClick={() => {
                  if (confirm(`Alle Rechte der Rolle @${r.name} entfernen?`)) purgeRole.mutate(g.roleDiscordId);
                }}>
                  Alle entziehen
                </Button>
              </div>
            </Card>
          );
        })}
      </div>
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
  welcomeMessages: string[];
  embedTitle: string;
  embedColor: string;
  postChannelId: string;
  postedMessageId: string | null;
  categoryId: string | null;
  staffRoleId: string | null;
  managerRoleIds: string[];
  mentionRoleIds: string[];
  transcriptChannelId: string;
  archiveChannelId: string | null;
  isActive: boolean;
}

interface DiscordChannel { id: string; name: string; type: number; parentId: string | null }
interface DiscordRole { id: string; name: string; color: string; position: number; managed: boolean }

function TicketsTab({ guildId, isOwner }: { guildId: string; isOwner: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
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

  const removeTpl = useMutation({
    mutationFn: (id: string) => api.del(`/api/v2/guilds/${guildId}/tickets/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tickets', guildId] });
      toast.success('Template geloescht.');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Loeschen fehlgeschlagen.'),
  });
  const postTpl = useMutation({
    mutationFn: (id: string) => api.post(`/api/v2/guilds/${guildId}/tickets/${id}/post`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tickets', guildId] });
      toast.success('Embed gepostet/aktualisiert.');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Posten fehlgeschlagen.'),
  });
  const toggleTpl = useMutation({
    mutationFn: (vars: { id: string; isActive: boolean }) =>
      api.put(`/api/v2/guilds/${guildId}/tickets/${vars.id}`, { isActive: vars.isActive }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['tickets', guildId] }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Aenderung fehlgeschlagen.'),
  });

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
              onDelete={() => {
                if (!t) return;
                if (!confirm(`Template "${t.label}" wirklich loeschen? Alle zugehoerigen Tickets werden ebenfalls entfernt.`)) return;
                removeTpl.mutate(t.id);
              }}
              onPost={() => {
                if (!t) return;
                postTpl.mutate(t.id);
              }}
              onToggle={() => {
                if (!t) return;
                toggleTpl.mutate({ id: t.id, isActive: !t.isActive });
              }}
              busy={
                (removeTpl.isPending && removeTpl.variables === t?.id) ||
                (postTpl.isPending && postTpl.variables === t?.id) ||
                (toggleTpl.isPending && toggleTpl.variables?.id === t?.id)
              }
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
  slot, template, channels, onEdit, onDelete, onPost, onToggle, busy,
}: {
  slot: number;
  template: TicketTemplate | null;
  channels: DiscordChannel[];
  onEdit: () => void;
  onDelete: () => void;
  onPost: () => void;
  onToggle: () => void;
  busy?: boolean;
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
            {template.archiveChannelId && <div>Archiv: <span className="text-white">#{channelName(template.archiveChannelId)}</span></div>}
            {template.categoryId && <div>Kategorie: <span className="text-white">{channelName(template.categoryId)}</span></div>}
            <div>Welcome-Nachrichten: <span className="text-white">{template.welcomeMessages?.length ?? 1}</span></div>
          </div>
        </div>
        <div className="flex flex-col sm:flex-row gap-1.5 shrink-0">
          <Button size="sm" variant="outline" onClick={onPost} disabled={busy}><Send className="h-3.5 w-3.5 mr-1" /> Posten</Button>
          <Button size="sm" variant="ghost" onClick={onToggle} disabled={busy} title={template.isActive ? 'Deaktivieren' : 'Aktivieren'} aria-label={template.isActive ? 'Template deaktivieren' : 'Template aktivieren'}><Power className="h-3.5 w-3.5" /></Button>
          <Button size="sm" variant="outline" onClick={onEdit} disabled={busy}>Bearbeiten</Button>
          <Button size="sm" variant="danger" onClick={onDelete} disabled={busy} aria-label="Template loeschen"><Trash2 className="h-3.5 w-3.5" /></Button>
        </div>
      </div>
    </Card>
  );
}

// 7 Preset-Farben + freier Hex-Wert. Hex bleibt Source-of-Truth gegenueber Backend.
const TICKET_COLOR_PRESETS: Array<{ name: string; hex: string }> = [
  { name: 'Grau',   hex: '#6b7280' },
  { name: 'Grün',   hex: '#22c55e' },
  { name: 'Rot',    hex: '#dc2626' },
  { name: 'Lila',   hex: '#8b5cf6' },
  { name: 'Pink',   hex: '#ec4899' },
  { name: 'Gold',   hex: '#eab308' },
  { name: 'Türkis', hex: '#14b8a6' },
];

const TICKET_WELCOME_MAX = 5;
const TICKET_WELCOME_CHARS = 2000;

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
  const [messages, setMessages] = useState<string[]>(() => {
    const src = existing?.welcomeMessages && existing.welcomeMessages.length > 0
      ? existing.welcomeMessages
      : [existing?.welcomeText ?? 'Hallo! Ein Team-Mitglied meldet sich gleich.'];
    return src.slice(0, TICKET_WELCOME_MAX);
  });
  const [embedTitle, setEmbedTitle] = useState(existing?.embedTitle ?? 'Support-Ticket öffnen');
  const [embedColor, setEmbedColor] = useState(existing?.embedColor ?? '#dc2626');
  const [postChannelId, setPostChannelId] = useState(existing?.postChannelId ?? '');
  const [transcriptChannelId, setTranscriptChannelId] = useState(existing?.transcriptChannelId ?? '');
  const [archiveChannelId, setArchiveChannelId] = useState(existing?.archiveChannelId ?? '');
  const [categoryId, setCategoryId] = useState(existing?.categoryId ?? '');
  const [staffRoleId, setStaffRoleId] = useState(existing?.staffRoleId ?? '');
  const [managerRoleIds, setManagerRoleIds] = useState<string[]>(existing?.managerRoleIds ?? []);
  const [mentionRoleIds, setMentionRoleIds] = useState<string[]>(existing?.mentionRoleIds ?? []);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const textChannels = channels.filter(c => c.type === 0 || c.type === 5);
  const categories = channels.filter(c => c.type === 4);

  // No-Mix-Vorvalidierung (UI-seitig).
  const mixError = (() => {
    const used = new Map<string, string>();
    const checks: Array<[string, string]> = [
      ['Post-Channel', postChannelId],
      ['Transcript-Channel', transcriptChannelId],
      ['Archiv-Channel', archiveChannelId],
      ['Kategorie', categoryId],
    ];
    for (const [name, id] of checks) {
      if (!id) continue;
      const existingName = used.get(id);
      if (existingName) return `${existingName} und ${name} dürfen nicht identisch sein.`;
      used.set(id, name);
    }
    return null;
  })();

  const messagesValid = messages.length >= 1 && messages.length <= TICKET_WELCOME_MAX
    && messages.every(m => m.trim().length >= 1 && m.length <= TICKET_WELCOME_CHARS);

  const updateMessage = (i: number, v: string) => {
    setMessages(prev => prev.map((m, idx) => idx === i ? v : m));
  };
  const addMessage = () => {
    if (messages.length >= TICKET_WELCOME_MAX) return;
    setMessages(prev => [...prev, '']);
  };
  const removeMessage = (i: number) => {
    if (messages.length <= 1) return;
    setMessages(prev => prev.filter((_, idx) => idx !== i));
  };
  const moveMessage = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= messages.length) return;
    setMessages(prev => {
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  const save = async () => {
    setErr(null);
    if (mixError) { setErr(mixError); return; }
    setBusy(true);
    try {
      const cleanedMessages = messages.map(m => m.trim()).filter(m => m.length > 0).slice(0, TICKET_WELCOME_MAX);
      if (cleanedMessages.length === 0) {
        setErr('Mindestens eine Welcome-Nachricht erforderlich.');
        setBusy(false);
        return;
      }
      const body = {
        slot,
        label,
        welcomeMessages: cleanedMessages,
        welcomeText: cleanedMessages[0], // Backward-compat-Spiegel
        embedTitle,
        embedColor,
        postChannelId,
        transcriptChannelId,
        archiveChannelId: archiveChannelId || null,
        categoryId: categoryId || null,
        staffRoleId: staffRoleId || null,
        managerRoleIds,
        mentionRoleIds,
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

  const colorIsPreset = TICKET_COLOR_PRESETS.some(p => p.hex.toLowerCase() === embedColor.toLowerCase());

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        className="relative w-full max-w-3xl max-h-[92vh] overflow-y-auto rounded-2xl border border-border bg-bg-card shadow-2xl"
        onClick={e => e.stopPropagation()}
        style={{
          backgroundImage: `radial-gradient(1200px 400px at 0% 0%, ${embedColor}1a, transparent 60%), radial-gradient(900px 300px at 100% 100%, ${embedColor}14, transparent 55%)`,
        }}
      >
        {/* Hairline glow border */}
        <div
          className="pointer-events-none absolute inset-0 rounded-2xl"
          style={{ boxShadow: `inset 0 0 0 1px ${embedColor}33, 0 0 60px -10px ${embedColor}55` }}
        />

        <div className="relative p-6 border-b border-border flex items-start justify-between gap-4">
          <div>
            <div className="text-[10px] tracking-[0.2em] text-muted uppercase">Slot {slot}  •  Ticket-Template</div>
            <h2 className="text-xl font-semibold text-white mt-1">
              {existing ? 'Template bearbeiten' : 'Neues Template'}
            </h2>
            <p className="text-xs text-muted mt-1">High-End Ticket-Konfiguration. Channels werden niemals vermischt.</p>
          </div>
          <div
            className="h-12 w-12 rounded-xl border grid place-items-center text-lg shrink-0"
            style={{ backgroundColor: `${embedColor}22`, borderColor: `${embedColor}66`, color: embedColor }}
          >
            🎫
          </div>
        </div>

        <div className="relative p-6 space-y-5">
          {/* Label + Title */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="block">
              <span className="text-xs text-muted">Label (Knopf-Beschriftung)</span>
              <Input value={label} onChange={e => setLabel(e.target.value)} maxLength={80} />
            </label>
            <label className="block">
              <span className="text-xs text-muted">Embed-Titel</span>
              <Input value={embedTitle} onChange={e => setEmbedTitle(e.target.value)} maxLength={200} />
            </label>
          </div>

          {/* Color palette */}
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted">Embed-Farbe</span>
              <span className="text-[10px] text-muted uppercase tracking-wider">
                {colorIsPreset ? 'Preset' : 'Custom'}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {TICKET_COLOR_PRESETS.map(p => {
                const active = p.hex.toLowerCase() === embedColor.toLowerCase();
                return (
                  <button
                    key={p.hex}
                    type="button"
                    onClick={() => setEmbedColor(p.hex)}
                    className={`group relative h-9 w-9 rounded-lg border transition ${active ? 'scale-110' : 'hover:scale-105'}`}
                    style={{
                      backgroundColor: p.hex,
                      borderColor: active ? '#ffffff' : `${p.hex}88`,
                      boxShadow: active ? `0 0 0 2px ${p.hex}aa, 0 0 18px -2px ${p.hex}` : `0 0 10px -3px ${p.hex}aa`,
                    }}
                    title={p.name}
                    aria-label={p.name}
                  >
                    {active && <span className="absolute inset-0 grid place-items-center text-white text-xs font-bold drop-shadow">✓</span>}
                  </button>
                );
              })}
              <div className="ml-1 flex items-center gap-2">
                <input
                  type="color"
                  value={embedColor}
                  onChange={e => setEmbedColor(e.target.value)}
                  className="h-9 w-12 rounded-lg bg-bg-elev border border-border cursor-pointer"
                  title="Eigene Farbe"
                />
                <Input
                  value={embedColor}
                  onChange={e => setEmbedColor(e.target.value)}
                  className="w-28 font-mono text-xs"
                  maxLength={7}
                />
              </div>
            </div>
          </div>

          {/* Welcome-Messages */}
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted">
                Welcome-Nachrichten im Ticket-Channel
                <span className="ml-2 text-[10px] uppercase tracking-wider">{messages.length}/{TICKET_WELCOME_MAX}</span>
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={addMessage}
                disabled={messages.length >= TICKET_WELCOME_MAX}
              >
                <Plus className="h-3.5 w-3.5 mr-1" /> Nachricht
              </Button>
            </div>
            <div className="mt-2 space-y-2">
              {messages.map((m, i) => (
                <div
                  key={i}
                  className="rounded-xl border border-border bg-bg-elev/60 p-3"
                  style={{ borderColor: `${embedColor}33` }}
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span
                        className="h-6 w-6 rounded-md grid place-items-center text-[10px] font-bold border"
                        style={{ backgroundColor: `${embedColor}22`, color: embedColor, borderColor: `${embedColor}55` }}
                      >
                        {i + 1}
                      </span>
                      <span className="text-[11px] text-muted">
                        {i === 0 ? 'Hauptnachricht (mit Embed)' : `Folgenachricht ${i}`}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => moveMessage(i, -1)}
                        disabled={i === 0}
                        className="text-muted hover:text-white disabled:opacity-30 px-1 text-xs"
                        title="Nach oben"
                      >▲</button>
                      <button
                        type="button"
                        onClick={() => moveMessage(i, 1)}
                        disabled={i === messages.length - 1}
                        className="text-muted hover:text-white disabled:opacity-30 px-1 text-xs"
                        title="Nach unten"
                      >▼</button>
                      <button
                        type="button"
                        onClick={() => removeMessage(i)}
                        disabled={messages.length <= 1}
                        className="text-danger hover:text-red-400 disabled:opacity-30 px-1"
                        title="Entfernen"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                  <textarea
                    value={m}
                    onChange={e => updateMessage(i, e.target.value)}
                    maxLength={TICKET_WELCOME_CHARS}
                    rows={i === 0 ? 4 : 3}
                    className="w-full rounded-md bg-bg-elev border border-border text-white px-3 py-2 text-sm focus:outline-none focus:ring-2"
                    style={{ ['--tw-ring-color' as string]: `${embedColor}80` } as React.CSSProperties}
                    placeholder={i === 0 ? 'Hauptnachricht …' : 'Folgenachricht …'}
                  />
                  <div className="mt-1 text-[10px] text-muted text-right">{m.length}/{TICKET_WELCOME_CHARS}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Channel-Setup */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="block">
              <span className="text-xs text-muted">Post-Channel <span className="text-[10px]">(Embed mit Open-Button)</span></span>
              <Select value={postChannelId} onChange={e => setPostChannelId(e.target.value)}>
                <option value="">— wählen —</option>
                {textChannels
                  .filter(c => c.id !== transcriptChannelId && c.id !== archiveChannelId && c.id !== categoryId)
                  .map(c => <option key={c.id} value={c.id}>#{c.name}</option>)}
              </Select>
            </label>
            <label className="block">
              <span className="text-xs text-muted">Transcript-Channel <span className="text-[10px]">(Markdown-Datei beim Schließen)</span></span>
              <Select value={transcriptChannelId} onChange={e => setTranscriptChannelId(e.target.value)}>
                <option value="">— wählen —</option>
                {textChannels
                  .filter(c => c.id !== postChannelId && c.id !== archiveChannelId && c.id !== categoryId)
                  .map(c => <option key={c.id} value={c.id}>#{c.name}</option>)}
              </Select>
            </label>
            <label className="block sm:col-span-2">
              <span className="text-xs text-muted">
                Ticket-Archiv-Channel
                <span className="text-[10px] ml-1">(separat, niemals mit anderen Channels vermischt — optional)</span>
              </span>
              <Select value={archiveChannelId} onChange={e => setArchiveChannelId(e.target.value)}>
                <option value="">— kein Archiv —</option>
                {textChannels
                  .filter(c => c.id !== postChannelId && c.id !== transcriptChannelId && c.id !== categoryId)
                  .map(c => <option key={c.id} value={c.id}>#{c.name}</option>)}
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
              <span className="text-xs text-muted">Staff-Rolle (Mit-Zugriff auf Ticket-Channel, optional)</span>
              <Select value={staffRoleId} onChange={e => setStaffRoleId(e.target.value)}>
                <option value="">— keine —</option>
                {roles.filter(r => !r.managed).map(r => <option key={r.id} value={r.id}>@{r.name}</option>)}
              </Select>
            </label>
            <label className="block sm:col-span-2">
              <span className="text-xs text-muted">
                Manager-Rollen (dürfen Tickets schließen)
                <span className="text-[10px] ml-1">(max 10 — strikte Server-Side-Permission. Opener darf eigenes Ticket NICHT schließen.)</span>
              </span>
              <div className="mt-1 flex flex-wrap gap-1.5 rounded-lg border border-border bg-bg p-2 max-h-40 overflow-y-auto">
                {roles.filter(r => !r.managed && r.name !== '@everyone').map(r => {
                  const checked = managerRoleIds.includes(r.id);
                  const disabled = !checked && managerRoleIds.length >= 10;
                  return (
                    <button
                      type="button"
                      key={r.id}
                      disabled={disabled}
                      onClick={() => setManagerRoleIds(prev => checked ? prev.filter(x => x !== r.id) : [...prev, r.id])}
                      className={`text-xs px-2 py-1 rounded-md border transition ${
                        checked
                          ? 'border-amber-400 bg-amber-400/15 text-amber-300'
                          : disabled
                            ? 'border-border bg-bg-card text-muted opacity-40 cursor-not-allowed'
                            : 'border-border bg-bg-card text-fg hover:border-amber-400/50'
                      }`}
                    >
                      @{r.name}
                    </button>
                  );
                })}
              </div>
            </label>
            <label className="block sm:col-span-2">
              <span className="text-xs text-muted">
                Rollen die beim Ticket-Open erwähnt werden
                <span className="text-[10px] ml-1">(max 5 — werden im Ticket-Channel gepingt; ohne Auswahl wird niemand erwähnt)</span>
              </span>
              <div className="mt-1 flex flex-wrap gap-1.5 rounded-lg border border-border bg-bg p-2 max-h-40 overflow-y-auto">
                {roles.filter(r => !r.managed && r.name !== '@everyone').map(r => {
                  const checked = mentionRoleIds.includes(r.id);
                  const disabled = !checked && mentionRoleIds.length >= 5;
                  return (
                    <button
                      type="button"
                      key={r.id}
                      disabled={disabled}
                      onClick={() => setMentionRoleIds(prev => checked ? prev.filter(x => x !== r.id) : [...prev, r.id])}
                      className={`text-xs px-2 py-1 rounded-md border transition ${
                        checked
                          ? 'border-primary bg-primary/15 text-primary'
                          : disabled
                            ? 'border-border bg-bg-card text-muted opacity-40 cursor-not-allowed'
                            : 'border-border bg-bg-card text-fg hover:border-primary/50'
                      }`}
                    >
                      @{r.name}
                    </button>
                  );
                })}
              </div>
            </label>
          </div>

          {(err || mixError) && (
            <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
              {err ?? mixError}
            </div>
          )}
        </div>

        <div className="relative p-5 border-t border-border flex gap-2 justify-end bg-bg-card/60">
          <Button variant="ghost" onClick={onClose}>Abbrechen</Button>
          <Button
            onClick={save}
            disabled={
              busy
              || !label
              || !messagesValid
              || !embedTitle
              || !postChannelId
              || !transcriptChannelId
              || !/^#[0-9a-fA-F]{6}$/.test(embedColor)
              || mixError !== null
            }
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

// ============================================================================
// (Fraktionssystem-Verwaltung wurde nach components/FactionsTab.tsx ausgelagert.)
// ============================================================================

