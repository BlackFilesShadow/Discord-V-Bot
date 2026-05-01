import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Shell } from '@/components/Shell';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { Select } from '@/components/ui/Select';
import { useGuildLiveUpdates } from '@/lib/useGuildLiveUpdates';
import { Settings, Users, Shield, Coins, Link as LinkIcon, Trash2, Plus, Check, X, Banknote, Dice5 } from 'lucide-react';

type Tab = 'settings' | 'factions' | 'whitelist' | 'economy' | 'links';

interface ServerSettingsState {
  whitelistActive: boolean;
  economyActive: boolean;
  permaOnly: boolean;
}

interface EconomyConfigState {
  enabled: boolean;
  currencyName: string;
  emoji: string;
  startBalance: number;
  playtimeRewardPercent: number;
  bankInterestPercent: number;
  bankChannelId: string | null;
}

interface ChannelOption { id: string; name: string; type: number; parentId: string | null; }

interface CasinoGameRow {
  type: 'SLOT' | 'COINFLIP' | 'DICE' | 'BLACKJACK';
  enabled: boolean;
  winChancePct: number;
  payoutMult: number;
  minBet: string;
  maxBet: string;
}

interface CasinoStatRow {
  type: 'SLOT' | 'COINFLIP' | 'DICE' | 'BLACKJACK';
  wins: number;
  losses: number;
  bet: string;
  payout: string;
}

const STEAM64_RE = /^7656\d{13}$/;
const SNOWFLAKE_RE = /^\d{17,20}$/;

export default function ServerSlot() {
  const { guildId, slot } = useParams<{ guildId: string; slot: string }>();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('settings');

  useGuildLiveUpdates(guildId);

  const settings = useQuery({
    queryKey: ['settings', guildId, slot],
    queryFn: () => api.get<ServerSettingsState>(`/api/v2/guilds/${guildId}/dashboard/server/${slot}/settings`),
    enabled: !!guildId && !!slot,
  });

  const updateSettings = useMutation({
    mutationFn: (patch: Partial<ServerSettingsState>) =>
      api.patch(`/api/v2/guilds/${guildId}/dashboard/server/${slot}/settings`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings', guildId, slot] }),
  });

  const economy = useQuery({
    queryKey: ['economy', guildId],
    queryFn: () => api.get<EconomyConfigState>(`/api/v2/guilds/${guildId}/economy/config`),
    enabled: !!guildId,
  });

  const updateEconomy = useMutation({
    mutationFn: (patch: Partial<EconomyConfigState>) =>
      api.put(`/api/v2/guilds/${guildId}/economy/config`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['economy', guildId] }),
  });

  const sidebar = (
    <nav className="space-y-1 text-sm">
      {([
        ['settings', 'Settings', Settings],
        ['factions', 'Fraktionssystem', Users],
        ['whitelist', 'Whitelist', Shield],
        ['economy', 'Economy', Coins],
        ['links', 'Economy-Links', LinkIcon],
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
    <Shell title={`Slot #${slot}`} back={`/servers/${guildId}`} sidebar={sidebar}>
      <div className="max-w-3xl mx-auto space-y-6">
        {tab === 'settings' && (
          <Card>
            <CardHeader><CardTitle>Server-Toggles</CardTitle></CardHeader>
            {settings.isLoading && <p className="text-muted">Lade…</p>}
            {settings.data && (
              <div className="space-y-4">
                <Switch
                  checked={settings.data.whitelistActive}
                  onChange={v => updateSettings.mutate({ whitelistActive: v })}
                  label="Whitelist aktiv"
                />
                <Switch
                  checked={settings.data.economyActive}
                  onChange={v => updateSettings.mutate({ economyActive: v })}
                  label="Economy aktiv"
                />
                <Switch
                  checked={settings.data.permaOnly}
                  onChange={v => updateSettings.mutate({ permaOnly: v })}
                  label="Perma-Only Modus"
                />
              </div>
            )}
          </Card>
        )}

        {tab === 'factions' && guildId && slot && (
          <FactionsPanel guildId={guildId} slot={slot} />
        )}

        {tab === 'whitelist' && guildId && slot && (
          <WhitelistPanel guildId={guildId} slot={slot} />
        )}

        {tab === 'economy' && guildId && (
          <EconomyTab
            guildId={guildId}
            data={economy.data}
            loading={economy.isLoading}
            onSave={patch => updateEconomy.mutate(patch)}
            pending={updateEconomy.isPending}
          />
        )}

        {tab === 'links' && guildId && slot && (
          <EconomyLinksPanel guildId={guildId} slot={slot} />
        )}
      </div>
    </Shell>
  );
}

// ----------------------------------------------------------------------------
// Factions
// ----------------------------------------------------------------------------

interface FactionRow {
  id: string;
  name: string;
  flagUrl: string;
  bannerUrl: string | null;
  mediaUrl: string | null;
  leaderDiscordId: string | null;
  treasurerDiscordId: string | null;
  embedChannelId: string | null;
  joinPolicy: string;
  isActive: boolean;
  memberCount: number;
}

function FactionsPanel({ guildId, slot }: { guildId: string; slot: string }) {
  const qc = useQueryClient();
  const qs = `?slot=${slot}`;
  const [draft, setDraft] = useState({ name: '', flagUrl: '', joinPolicy: 'REQUEST', leaderDiscordId: '', embedChannelId: '' });
  const [memberDraft, setMemberDraft] = useState<Record<string, { user: string; role: string }>>({});

  const list = useQuery({
    queryKey: ['factions', guildId, slot],
    queryFn: () => api.get<{ factions: FactionRow[] }>(`/api/v2/guilds/${guildId}/factions${qs}`),
  });

  const create = useMutation({
    mutationFn: (b: typeof draft) => api.post(`/api/v2/guilds/${guildId}/factions${qs}`, {
      name: b.name,
      flagUrl: b.flagUrl,
      joinPolicy: b.joinPolicy,
      leaderDiscordId: b.leaderDiscordId || undefined,
      embedChannelId: b.embedChannelId || undefined,
    }),
    onSuccess: () => {
      setDraft({ name: '', flagUrl: '', joinPolicy: 'REQUEST', leaderDiscordId: '', embedChannelId: '' });
      void qc.invalidateQueries({ queryKey: ['factions', guildId, slot] });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/v2/guilds/${guildId}/factions/${id}${qs}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['factions', guildId, slot] }),
  });

  const addMember = useMutation({
    mutationFn: (vars: { factionId: string; user: string; role: string }) =>
      api.post(`/api/v2/guilds/${guildId}/factions/${vars.factionId}/members${qs}`, {
        userDiscordId: vars.user, role: vars.role,
      }),
    onSuccess: (_d, vars) => {
      setMemberDraft(s => ({ ...s, [vars.factionId]: { user: '', role: 'MEMBER' } }));
      void qc.invalidateQueries({ queryKey: ['factions', guildId, slot] });
    },
  });

  const validUrl = (s: string) => /^https?:\/\/.{4,}$/i.test(s);
  const validId = (s: string) => !s || SNOWFLAKE_RE.test(s);

  return (
    <Card>
      <CardHeader><CardTitle>Fraktionssystem</CardTitle></CardHeader>
      {list.isLoading && <p className="text-muted">Lade…</p>}
      {list.error && <p className="text-red-400 text-sm">{(list.error as Error).message}</p>}

      <div className="space-y-2 mb-6">
        {list.data?.factions.length === 0 && <p className="text-muted text-sm">Keine Fraktionen.</p>}
        {list.data?.factions.map(f => (
          <div key={f.id} className="bg-bg-elev rounded-md border border-border p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <img src={f.flagUrl} alt="" className="h-8 w-8 rounded object-cover bg-black" />
                <div>
                  <p className="text-white font-medium">{f.name}</p>
                  <p className="text-muted text-xs">{f.joinPolicy} · {f.memberCount} Members</p>
                </div>
              </div>
              <Button size="sm" variant="danger" onClick={() => remove.mutate(f.id)}>
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>

            <div className="flex gap-2 pt-2 border-t border-border">
              <Input
                placeholder="Discord-ID hinzufuegen"
                value={memberDraft[f.id]?.user ?? ''}
                onChange={e => setMemberDraft(s => ({ ...s, [f.id]: { user: e.target.value.trim(), role: s[f.id]?.role ?? 'MEMBER' } }))}
              />
              <Select
                value={memberDraft[f.id]?.role ?? 'MEMBER'}
                onChange={e => setMemberDraft(s => ({ ...s, [f.id]: { user: s[f.id]?.user ?? '', role: e.target.value } }))}
                className="w-32"
              >
                <option value="MEMBER">MEMBER</option>
                <option value="LEADER">LEADER</option>
                <option value="TREASURER">TREASURER</option>
                <option value="PENDING">PENDING</option>
              </Select>
              <Button
                size="sm"
                disabled={!SNOWFLAKE_RE.test(memberDraft[f.id]?.user ?? '') || addMember.isPending}
                onClick={() => addMember.mutate({
                  factionId: f.id,
                  user: memberDraft[f.id]?.user ?? '',
                  role: memberDraft[f.id]?.role ?? 'MEMBER',
                })}
              >
                <Plus className="h-3 w-3" />
              </Button>
            </div>
          </div>
        ))}
      </div>

      <div className="border-t border-border pt-4 space-y-3">
        <p className="text-sm text-white/80">Neue Fraktion</p>
        <div className="grid gap-2 md:grid-cols-2">
          <Input placeholder="Name (2-60)" value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} maxLength={60} />
          <Input placeholder="Flag-URL (https://…)" value={draft.flagUrl} onChange={e => setDraft({ ...draft, flagUrl: e.target.value })} />
          <Select value={draft.joinPolicy} onChange={e => setDraft({ ...draft, joinPolicy: e.target.value })}>
            <option value="OPEN">OPEN — jeder darf joinen</option>
            <option value="REQUEST">REQUEST — Antrag erforderlich</option>
            <option value="CLOSED">CLOSED — nur Invite</option>
          </Select>
          <Input placeholder="Leader-Discord-ID (optional)" value={draft.leaderDiscordId} onChange={e => setDraft({ ...draft, leaderDiscordId: e.target.value.trim() })} maxLength={20} />
          <Input placeholder="Embed-Channel-ID (optional)" value={draft.embedChannelId} onChange={e => setDraft({ ...draft, embedChannelId: e.target.value.trim() })} maxLength={20} />
        </div>
        <Button
          disabled={
            create.isPending
            || draft.name.trim().length < 2
            || !validUrl(draft.flagUrl)
            || !validId(draft.leaderDiscordId)
            || !validId(draft.embedChannelId)
          }
          onClick={() => create.mutate(draft)}
        >
          {create.isPending ? 'Erstelle…' : 'Erstellen'}
        </Button>
        {create.error && <p className="text-red-400 text-xs">{(create.error as Error).message}</p>}
      </div>
    </Card>
  );
}

// ----------------------------------------------------------------------------
// Whitelist
// ----------------------------------------------------------------------------

interface WhitelistEntry {
  gameId: string;
  approvedBy: string | null;
  source: string;
  approvedAt: string;
}

interface WhitelistRequest {
  id: string;
  gameId: string;
  requesterDiscordId: string;
  status: string;
  createdAt: string;
}

function WhitelistPanel({ guildId, slot }: { guildId: string; slot: string }) {
  const qc = useQueryClient();
  const qs = `?slot=${slot}`;
  const [newId, setNewId] = useState('');
  const [reasonById, setReasonById] = useState<Record<string, string>>({});

  const entries = useQuery({
    queryKey: ['whitelist', guildId, slot],
    queryFn: () => api.get<{ entries: WhitelistEntry[] }>(`/api/v2/guilds/${guildId}/whitelist${qs}`),
  });

  const requests = useQuery({
    queryKey: ['whitelist-requests', guildId, slot],
    queryFn: () => api.get<{ requests: WhitelistRequest[] }>(`/api/v2/guilds/${guildId}/whitelist/requests${qs}`),
  });

  const add = useMutation({
    mutationFn: (gameId: string) => api.post(`/api/v2/guilds/${guildId}/whitelist${qs}`, { gameId }),
    onSuccess: () => {
      setNewId('');
      void qc.invalidateQueries({ queryKey: ['whitelist', guildId, slot] });
    },
  });

  const remove = useMutation({
    mutationFn: (gameId: string) => api.del(`/api/v2/guilds/${guildId}/whitelist/${gameId}${qs}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['whitelist', guildId, slot] }),
  });

  const decide = useMutation({
    mutationFn: (vars: { id: string; approve: boolean; reason?: string }) =>
      api.post(`/api/v2/guilds/${guildId}/whitelist/requests/${vars.id}/decision${qs}`, {
        approve: vars.approve, reason: vars.reason,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['whitelist-requests', guildId, slot] });
      void qc.invalidateQueries({ queryKey: ['whitelist', guildId, slot] });
    },
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader><CardTitle>Whitelist (Steam64)</CardTitle></CardHeader>
        <div className="flex gap-2 mb-4">
          <Input
            placeholder="7656119……… (17 Stellen)"
            value={newId}
            onChange={e => setNewId(e.target.value.trim())}
            maxLength={17}
          />
          <Button
            disabled={!STEAM64_RE.test(newId) || add.isPending}
            onClick={() => add.mutate(newId)}
          >
            <Plus className="h-3 w-3 mr-1" /> Hinzufuegen
          </Button>
        </div>
        {add.error && <p className="text-red-400 text-xs mb-2">{(add.error as Error).message}</p>}

        {entries.isLoading && <p className="text-muted">Lade…</p>}
        <div className="space-y-1">
          {entries.data?.entries.length === 0 && <p className="text-muted text-sm">Keine Eintraege.</p>}
          {entries.data?.entries.map(e => (
            <div key={e.gameId} className="flex items-center justify-between bg-bg-elev rounded-md px-3 py-1.5 border border-border text-sm">
              <div>
                <span className="font-mono text-white">{e.gameId}</span>
                <span className="text-muted text-xs ml-3">{e.source} · {new Date(e.approvedAt).toLocaleString()}</span>
              </div>
              <Button size="sm" variant="danger" onClick={() => remove.mutate(e.gameId)}>
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader><CardTitle>Pending-Requests</CardTitle></CardHeader>
        {requests.isLoading && <p className="text-muted">Lade…</p>}
        <div className="space-y-2">
          {requests.data?.requests.length === 0 && <p className="text-muted text-sm">Keine offenen Requests.</p>}
          {requests.data?.requests.map(r => (
            <div key={r.id} className="bg-bg-elev rounded-md border border-border p-3 space-y-2">
              <div className="flex items-center justify-between text-sm">
                <div>
                  <p className="text-white font-mono">{r.gameId}</p>
                  <p className="text-muted text-xs">von {r.requesterDiscordId} · {new Date(r.createdAt).toLocaleString()}</p>
                </div>
              </div>
              <div className="flex gap-2">
                <Input
                  placeholder="Begruendung (optional)"
                  value={reasonById[r.id] ?? ''}
                  onChange={e => setReasonById(s => ({ ...s, [r.id]: e.target.value }))}
                  maxLength={500}
                />
                <Button
                  size="sm"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ id: r.id, approve: true, reason: reasonById[r.id] || undefined })}
                >
                  <Check className="h-3 w-3" />
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ id: r.id, approve: false, reason: reasonById[r.id] || undefined })}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Economy-Links
// ----------------------------------------------------------------------------

interface EconomyLink {
  userDiscordId: string;
  gameId: string;
  linkedAt: string;
}

function EconomyLinksPanel({ guildId, slot }: { guildId: string; slot: string }) {
  const qc = useQueryClient();
  const qs = `?slot=${slot}`;
  const [grant, setGrant] = useState({ user: '', gameId: '' });

  const list = useQuery({
    queryKey: ['economy-links', guildId, slot],
    queryFn: () => api.get<{ links: EconomyLink[] }>(`/api/v2/guilds/${guildId}/economy-links${qs}`),
  });

  const force = useMutation({
    mutationFn: (b: typeof grant) => api.post(`/api/v2/guilds/${guildId}/economy-links/grant${qs}`, {
      userDiscordId: b.user, gameId: b.gameId,
    }),
    onSuccess: () => {
      setGrant({ user: '', gameId: '' });
      void qc.invalidateQueries({ queryKey: ['economy-links', guildId, slot] });
    },
  });

  const unlink = useMutation({
    mutationFn: (user: string) => api.del(`/api/v2/guilds/${guildId}/economy-links/${user}${qs}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['economy-links', guildId, slot] }),
  });

  return (
    <Card>
      <CardHeader><CardTitle>Economy-Links (Discord ↔ In-Game)</CardTitle></CardHeader>
      {list.isLoading && <p className="text-muted">Lade…</p>}
      <div className="space-y-1 mb-4">
        {list.data?.links.length === 0 && <p className="text-muted text-sm">Keine Links.</p>}
        {list.data?.links.map(l => (
          <div key={l.userDiscordId} className="flex items-center justify-between bg-bg-elev rounded-md px-3 py-1.5 border border-border text-sm">
            <div className="font-mono">
              <span className="text-white">{l.userDiscordId}</span>
              <span className="text-muted mx-2">↔</span>
              <span className="text-accent">{l.gameId}</span>
            </div>
            <Button size="sm" variant="danger" onClick={() => unlink.mutate(l.userDiscordId)}>
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        ))}
      </div>

      <div className="border-t border-border pt-4 space-y-2">
        <p className="text-sm text-white/80">Force-Link (ueberschreibt bestehenden)</p>
        <div className="grid gap-2 md:grid-cols-[1fr,1fr,auto]">
          <Input placeholder="Discord-ID" value={grant.user} onChange={e => setGrant({ ...grant, user: e.target.value.trim() })} maxLength={20} />
          <Input placeholder="Game-ID" value={grant.gameId} onChange={e => setGrant({ ...grant, gameId: e.target.value.trim() })} maxLength={64} />
          <Button
            disabled={!SNOWFLAKE_RE.test(grant.user) || grant.gameId.length < 3 || force.isPending}
            onClick={() => force.mutate(grant)}
          >
            {force.isPending ? 'Setze…' : 'Setzen'}
          </Button>
        </div>
        {force.error && <p className="text-red-400 text-xs">{(force.error as Error).message}</p>}
      </div>
    </Card>
  );
}

// ----------------------------------------------------------------------------
// Economy Tab (Konfiguration + Bank + Casino + Admin-Pay)
// ----------------------------------------------------------------------------

function EconomyTab({
  guildId, data, loading, onSave, pending,
}: {
  guildId: string;
  data: EconomyConfigState | undefined;
  loading: boolean;
  onSave: (p: Partial<EconomyConfigState>) => void;
  pending: boolean;
}) {
  const channels = useQuery({
    queryKey: ['guild-channels', guildId],
    queryFn: () => api.get<{ channels: ChannelOption[] }>(`/api/v2/guilds/${guildId}/channels`),
    retry: false,
  });
  const channelOptions = channels.data?.channels ?? [];
  const channelsForbidden = channels.isError;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader><CardTitle>Economy-Konfiguration</CardTitle></CardHeader>
        {loading && <p className="text-muted">Lade…</p>}
        {data && <EconomyForm value={data} onSave={onSave} pending={pending} />}
      </Card>

      {data && (
        <Card>
          <CardHeader><CardTitle><span className="inline-flex items-center gap-2"><Banknote className="h-4 w-4" />Bank</span></CardTitle></CardHeader>
          <BankForm
            value={data}
            onSave={onSave}
            pending={pending}
            channels={channelOptions}
            channelsForbidden={channelsForbidden}
          />
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle><span className="inline-flex items-center gap-2"><Dice5 className="h-4 w-4" />Casino-Games</span></CardTitle></CardHeader>
        <CasinoTable guildId={guildId} />
      </Card>

      <Card>
        <CardHeader><CardTitle>Admin-Auszahlung</CardTitle></CardHeader>
        <AdminPayForm guildId={guildId} />
      </Card>
    </div>
  );
}

function EconomyForm({
  value, onSave, pending,
}: { value: EconomyConfigState; onSave: (p: Partial<EconomyConfigState>) => void; pending: boolean }) {
  const [draft, setDraft] = useState(value);
  return (
    <div className="space-y-4">
      <Switch
        checked={draft.enabled}
        onChange={v => setDraft({ ...draft, enabled: v })}
        label="Economy aktiviert"
      />
      <div className="grid grid-cols-2 gap-3">
        <label className="text-sm">
          <span className="text-muted">Waehrungsname</span>
          <Input value={draft.currencyName} onChange={e => setDraft({ ...draft, currencyName: e.target.value })} maxLength={40} />
        </label>
        <label className="text-sm">
          <span className="text-muted">Emoji</span>
          <Input value={draft.emoji} onChange={e => setDraft({ ...draft, emoji: e.target.value })} maxLength={8} />
        </label>
        <label className="text-sm">
          <span className="text-muted">Startguthaben (neue Members)</span>
          <Input
            type="number" min={0} value={draft.startBalance}
            onChange={e => setDraft({ ...draft, startBalance: Math.max(0, Number(e.target.value) || 0) })}
          />
        </label>
        <label className="text-sm">
          <span className="text-muted">Spielzeit-Belohnung %/min</span>
          <Input
            type="number" min={0} max={1000} value={draft.playtimeRewardPercent}
            onChange={e => setDraft({ ...draft, playtimeRewardPercent: Math.max(0, Math.min(1000, Number(e.target.value) || 0)) })}
          />
        </label>
      </div>
      <Button onClick={() => onSave({
        enabled: draft.enabled,
        currencyName: draft.currencyName,
        emoji: draft.emoji,
        startBalance: draft.startBalance,
        playtimeRewardPercent: draft.playtimeRewardPercent,
      })} disabled={pending}>
        {pending ? 'Speichere…' : 'Update'}
      </Button>
    </div>
  );
}

// ----------------------------------------------------------------------------
// BankForm
// ----------------------------------------------------------------------------

function BankForm({
  value, onSave, pending, channels, channelsForbidden,
}: {
  value: EconomyConfigState;
  onSave: (p: Partial<EconomyConfigState>) => void;
  pending: boolean;
  channels: ChannelOption[];
  channelsForbidden: boolean;
}) {
  const [bankChannelId, setBankChannelId] = useState<string>(value.bankChannelId ?? '');
  const [interest, setInterest] = useState<number>(value.bankInterestPercent);
  const textChannels = channels.filter(c => c.type === 0 || c.type === 5);

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted">
        Der Bank-Channel zeigt Kontostaende und Bankaktionen an. Zinsen werden taeglich auf das Bankguthaben gutgeschrieben.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-sm">
          <span className="text-muted">Bank-Channel</span>
          {channelsForbidden ? (
            <Input value={bankChannelId} onChange={e => setBankChannelId(e.target.value.trim())} placeholder="Channel-ID (Snowflake)" />
          ) : (
            <Select value={bankChannelId} onChange={e => setBankChannelId(e.target.value)}>
              <option value="">— kein Channel —</option>
              {textChannels.map(c => (
                <option key={c.id} value={c.id}>#{c.name}</option>
              ))}
            </Select>
          )}
        </label>
        <label className="text-sm">
          <span className="text-muted">Tageszins (%)</span>
          <Input
            type="number" min={0} max={100} step={1} value={interest}
            onChange={e => setInterest(Math.max(0, Math.min(100, Math.floor(Number(e.target.value) || 0))))}
          />
        </label>
      </div>
      <Button
        onClick={() => onSave({
          bankChannelId: bankChannelId === '' ? null : bankChannelId,
          bankInterestPercent: interest,
        })}
        disabled={pending || (bankChannelId !== '' && !SNOWFLAKE_RE.test(bankChannelId))}
      >
        {pending ? 'Speichere…' : 'Bank speichern'}
      </Button>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Casino-Table + Stats
// ----------------------------------------------------------------------------

const CASINO_TYPES = ['SLOT', 'COINFLIP', 'DICE', 'BLACKJACK'] as const;

function CasinoTable({ guildId }: { guildId: string }) {
  const qc = useQueryClient();
  const games = useQuery({
    queryKey: ['casino-games', guildId],
    queryFn: () => api.get<{ games: CasinoGameRow[] }>(`/api/v2/guilds/${guildId}/casino/games`),
  });
  const stats = useQuery({
    queryKey: ['casino-stats', guildId],
    queryFn: () => api.get<{ stats: CasinoStatRow[] }>(`/api/v2/guilds/${guildId}/casino/stats`),
  });

  const update = useMutation({
    mutationFn: (vars: { type: string; patch: Partial<CasinoGameRow> }) =>
      api.put(`/api/v2/guilds/${guildId}/casino/games/${vars.type}`, vars.patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['casino-games', guildId] });
      void qc.invalidateQueries({ queryKey: ['casino-stats', guildId] });
    },
  });

  const byType = new Map<string, CasinoGameRow>();
  for (const g of games.data?.games ?? []) byType.set(g.type, g);
  const statsByType = new Map<string, CasinoStatRow>();
  for (const s of stats.data?.stats ?? []) statsByType.set(s.type, s);

  return (
    <div className="space-y-3">
      {games.isLoading && <p className="text-muted text-sm">Lade…</p>}
      {games.isError && <p className="text-danger text-sm">Casino-Daten nicht verfuegbar.</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-muted">
            <tr>
              <th className="text-left py-2">Game</th>
              <th className="text-left py-2">Aktiv</th>
              <th className="text-left py-2">Win %</th>
              <th className="text-left py-2">Payout x</th>
              <th className="text-left py-2">Min</th>
              <th className="text-left py-2">Max</th>
              <th className="text-left py-2">W/L</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {CASINO_TYPES.map(type => (
              <CasinoRow
                key={type}
                type={type}
                game={byType.get(type) ?? null}
                stat={statsByType.get(type) ?? null}
                onSave={patch => update.mutate({ type, patch })}
                pending={update.isPending}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CasinoRow({
  type, game, stat, onSave, pending,
}: {
  type: string;
  game: CasinoGameRow | null;
  stat: CasinoStatRow | null;
  onSave: (p: Partial<CasinoGameRow>) => void;
  pending: boolean;
}) {
  const [draft, setDraft] = useState<CasinoGameRow>({
    type: type as CasinoGameRow['type'],
    enabled: game?.enabled ?? false,
    winChancePct: game?.winChancePct ?? 50,
    payoutMult: game?.payoutMult ?? 2,
    minBet: game?.minBet ?? '1',
    maxBet: game?.maxBet ?? '1000',
  });
  const wl = stat ? `${stat.wins} / ${stat.losses}` : '— / —';
  const isValid =
    draft.winChancePct >= 1 && draft.winChancePct <= 99 &&
    draft.payoutMult >= 1 && draft.payoutMult <= 100 &&
    /^\d+$/.test(draft.minBet) && /^\d+$/.test(draft.maxBet) &&
    BigInt(draft.minBet) >= 1n && BigInt(draft.maxBet) >= BigInt(draft.minBet);

  return (
    <tr className="border-t border-border">
      <td className="py-2 pr-2 font-medium">{type}</td>
      <td className="py-2 pr-2">
        <Switch checked={draft.enabled} onChange={v => setDraft({ ...draft, enabled: v })} />
      </td>
      <td className="py-2 pr-2">
        <Input type="number" min={1} max={99} value={draft.winChancePct}
          onChange={e => setDraft({ ...draft, winChancePct: Math.max(1, Math.min(99, Math.floor(Number(e.target.value) || 0))) })}
          className="w-20"
        />
      </td>
      <td className="py-2 pr-2">
        <Input type="number" min={1} max={100} step="0.1" value={draft.payoutMult}
          onChange={e => setDraft({ ...draft, payoutMult: Math.max(1, Math.min(100, Number(e.target.value) || 1)) })}
          className="w-24"
        />
      </td>
      <td className="py-2 pr-2">
        <Input value={draft.minBet} onChange={e => setDraft({ ...draft, minBet: e.target.value.trim() })} className="w-24" />
      </td>
      <td className="py-2 pr-2">
        <Input value={draft.maxBet} onChange={e => setDraft({ ...draft, maxBet: e.target.value.trim() })} className="w-28" />
      </td>
      <td className="py-2 pr-2 text-muted">{wl}</td>
      <td className="py-2">
        <Button size="sm" disabled={pending || !isValid} onClick={() => onSave({
          enabled: draft.enabled,
          winChancePct: draft.winChancePct,
          payoutMult: draft.payoutMult,
          minBet: draft.minBet,
          maxBet: draft.maxBet,
        })}>
          {pending ? '…' : 'Speichern'}
        </Button>
      </td>
    </tr>
  );
}

// ----------------------------------------------------------------------------
// Admin-Pay
// ----------------------------------------------------------------------------

function AdminPayForm({ guildId }: { guildId: string }) {
  const [userId, setUserId] = useState('');
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const pay = useMutation({
    mutationFn: () => api.post(`/api/v2/guilds/${guildId}/economy/accounts/${userId}/admin-pay`, {
      delta, reason,
    }),
    onSuccess: () => {
      setMsg({ ok: true, text: `Gebucht: ${delta} fuer ${userId}` });
      setUserId(''); setDelta(''); setReason('');
    },
    onError: (e: unknown) => {
      const text = e instanceof Error ? e.message : 'Fehler.';
      setMsg({ ok: false, text });
    },
  });

  const deltaValid = /^-?\d+$/.test(delta) && delta !== '0' && delta !== '-0';
  const userValid = SNOWFLAKE_RE.test(userId);
  const reasonValid = reason.trim().length >= 3 && reason.trim().length <= 200;

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        Direkt-Buchung auf das Wallet eines Members. Positive Werte = Gutschrift, negative = Abbuchung. Wird im Audit-Log erfasst.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-sm">
          <span className="text-muted">Discord-User-ID</span>
          <Input value={userId} onChange={e => setUserId(e.target.value.trim())} placeholder="17–20 Ziffern" />
        </label>
        <label className="text-sm">
          <span className="text-muted">Betrag (Delta)</span>
          <Input value={delta} onChange={e => setDelta(e.target.value.trim())} placeholder="z. B. 5000 oder -200" />
        </label>
      </div>
      <label className="text-sm block">
        <span className="text-muted">Begruendung (3–200 Zeichen)</span>
        <Input value={reason} onChange={e => setReason(e.target.value)} maxLength={200} />
      </label>
      <Button
        disabled={pay.isPending || !userValid || !deltaValid || !reasonValid}
        onClick={() => { setMsg(null); pay.mutate(); }}
      >
        {pay.isPending ? 'Buche…' : 'Buchung ausfuehren'}
      </Button>
      {msg && (
        <p className={`text-xs ${msg.ok ? 'text-green-400' : 'text-danger'}`}>{msg.text}</p>
      )}
    </div>
  );
}
