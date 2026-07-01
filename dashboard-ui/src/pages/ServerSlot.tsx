import { useState, useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Shell } from '@/components/Shell';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { Select } from '@/components/ui/Select';
import { useGuildLiveUpdates } from '@/lib/useGuildLiveUpdates';
import { Settings, Shield, Coins, Link as LinkIcon, Trash2, Plus, Check, X, Banknote, Dice5, RefreshCw } from 'lucide-react';

type Tab = 'settings' | 'whitelist' | 'economy' | 'links';

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

const NAME_RE = /^[^\r\n\t]{1,64}$/;
const SNOWFLAKE_RE = /^\d{17,20}$/;

export default function ServerSlot() {
  const { guildId, slot } = useParams<{ guildId: string; slot: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const qc = useQueryClient();
  const initialTab = ((): Tab => {
    const t = searchParams.get('tab');
    if (t === 'settings' || t === 'whitelist' || t === 'economy' || t === 'links') return t;
    return 'settings';
  })();
  const [tab, setTab] = useState<Tab>(initialTab);

  // Tab-Wechsel in URL persistieren (Deep-Link, Back-Button).
  useEffect(() => {
    if (searchParams.get('tab') !== tab) {
      const next = new URLSearchParams(searchParams);
      next.set('tab', tab);
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

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

  const tabs = [
    ['settings', 'Settings', Settings],
    ['whitelist', 'Whitelist', Shield],
    ['economy', 'Economy', Coins],
    ['links', 'Economy-Links', LinkIcon],
  ] as const;

  const sidebar = (
    <nav className="space-y-1 text-sm">
      {tabs.map(([key, label, Icon]) => (
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
        {/* Mobile: horizontale Tab-Leiste, da die Sidebar nur hinterm Menue liegt. */}
        <nav
          className="md:hidden -mx-4 px-4 flex gap-2 overflow-x-auto pb-1"
          aria-label="Slot-Funktionen"
        >
          {tabs.map(([key, label, Icon]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`shrink-0 inline-flex items-center gap-2 px-3 py-2 rounded-md text-sm whitespace-nowrap transition-colors ${
                tab === key ? 'bg-accent/20 text-accent' : 'text-muted bg-bg-elev/40 hover:bg-bg-elev hover:text-white'
              }`}
              type="button"
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </nav>
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

interface SyncDiff {
  direction: 'pull' | 'push' | 'merge';
  mode: 'preview' | 'apply';
  counts: { local: number; remote: number; both: number; onlyLocal: number; onlyRemote: number };
  onlyLocal: string[];
  onlyRemote: string[];
}

interface WhitelistChannelsState {
  infoChannelId: string | null;
  requestChannelId: string | null;
  approveLogChannelId: string | null;
  denyLogChannelId: string | null;
  infoMessageId: string | null;
}

function WhitelistPanel({ guildId, slot }: { guildId: string; slot: string }) {
  const qc = useQueryClient();
  const [syncDirection, setSyncDirection] = useState<'pull' | 'push' | 'merge'>('merge');
  const [syncDiff, setSyncDiff] = useState<SyncDiff | null>(null);
  const [syncResult, setSyncResult] = useState<string | null>(null);
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
    mutationFn: (gameId: string) => api.post(`/api/v2/guilds/${guildId}/whitelist${qs}`, {
      gameId, confirm: true, reason: `Whitelist-Eintrag hinzugefuegt: ${gameId}`,
    }),
    onSuccess: () => {
      setNewId('');
      void qc.invalidateQueries({ queryKey: ['whitelist', guildId, slot] });
    },
  });

  const remove = useMutation({
    mutationFn: (gameId: string) => api.del(`/api/v2/guilds/${guildId}/whitelist/${gameId}${qs}`, {
      confirm: true, reason: `Whitelist-Eintrag entfernt: ${gameId}`,
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['whitelist', guildId, slot] }),
  });

  const decide = useMutation({
    mutationFn: (vars: { id: string; approve: boolean; reason?: string }) =>
      api.post(`/api/v2/guilds/${guildId}/whitelist/requests/${vars.id}/decision${qs}`, {
        approve: vars.approve,
        reason: vars.reason?.trim() || (vars.approve ? 'Whitelist-Request genehmigt' : undefined),
        confirm: true,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['whitelist-requests', guildId, slot] });
      void qc.invalidateQueries({ queryKey: ['whitelist', guildId, slot] });
    },
  });

  const sync = useMutation({
    mutationFn: (vars: { mode: 'preview' | 'apply'; direction: 'pull' | 'push' | 'merge'; reason?: string }) =>
      api.post<{ ok: boolean; preview?: boolean; applied?: boolean; diff: SyncDiff; dbInserted?: number; dbDeleted?: number; jobsCreated?: number }>(
        `/api/v2/guilds/${guildId}/whitelist/sync${qs}`,
        { ...vars, confirm: true },
      ),
    onSuccess: (res, vars) => {
      setSyncDiff(res.diff);
      if (vars.mode === 'apply') {
        const parts: string[] = [];
        if (typeof res.dbInserted === 'number') parts.push(`${res.dbInserted} lokal hinzugefuegt`);
        if (typeof res.dbDeleted === 'number') parts.push(`${res.dbDeleted} lokal entfernt`);
        if (typeof res.jobsCreated === 'number') parts.push(`${res.jobsCreated} Nitrado-Jobs erstellt`);
        setSyncResult(parts.length ? parts.join(' · ') : 'Bereits synchron');
      } else {
        setSyncResult(null);
      }
      void qc.invalidateQueries({ queryKey: ['whitelist', guildId, slot] });
    },
    onError: (err: Error) => {
      setSyncResult(`Fehler: ${err.message}`);
    },
  });

  return (
    <div className="grid gap-6 lg:grid-cols-2 items-start">
      <div className="space-y-6">
        <WhitelistChannelsCard guildId={guildId} slot={slot} />
      </div>

      <div className="space-y-6">
      <Card>
        <CardHeader><CardTitle>Whitelist (Spielername)</CardTitle></CardHeader>
        <div className="flex gap-2 mb-4">
          <Input
            placeholder="Spielername (1-64 Zeichen)"
            value={newId}
            onChange={e => setNewId(e.target.value)}
            maxLength={64}
          />
          <Button
            disabled={!NAME_RE.test(newId.trim()) || add.isPending}
            onClick={() => add.mutate(newId.trim())}
          >
            <Plus className="h-3 w-3 mr-1" /> Hinzufuegen
          </Button>
        </div>
        {add.error && <p className="text-red-400 text-xs mb-2">{(add.error as Error).message}</p>}

        {entries.isLoading && <p className="text-muted">Lade…</p>}
        <div className="space-y-1 max-h-72 overflow-y-auto pr-1">
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

        <div className="mt-6 pt-4 border-t border-border space-y-3">
          <div className="flex items-center gap-2">
            <RefreshCw className="h-4 w-4 text-muted" />
            <h4 className="text-sm font-semibold text-white">Synchronisation DB &harr; Nitrado</h4>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted">Richtung:</span>
            {(['merge', 'pull', 'push'] as const).map(d => (
              <button
                key={d}
                type="button"
                onClick={() => setSyncDirection(d)}
                className={`px-2 py-1 rounded border ${syncDirection === d ? 'bg-bg-elev border-primary text-white' : 'border-border text-muted hover:text-white'}`}
              >
                {d === 'merge' ? 'Merge (beide vereinen)' : d === 'pull' ? 'Pull (Nitrado -> DB)' : 'Push (DB -> Nitrado)'}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={sync.isPending}
              onClick={() => { setSyncResult(null); sync.mutate({ mode: 'preview', direction: syncDirection }); }}
            >
              Vorschau
            </Button>
            <Button
              size="sm"
              disabled={sync.isPending}
              onClick={() => {
                let reason: string | undefined;
                if (syncDirection === 'push' || syncDirection === 'merge') {
                  const r = window.prompt(`Begruendung fuer Nitrado-Sync (${syncDirection}):`, '');
                  if (r === null) return;
                  if (r.trim().length < 3) { setSyncResult('Begruendung erforderlich (min. 3 Zeichen).'); return; }
                  reason = r.trim();
                } else if (!confirm(`Synchronisation (${syncDirection}) jetzt ausfuehren?`)) {
                  return;
                }
                setSyncResult(null);
                sync.mutate({ mode: 'apply', direction: syncDirection, reason });
              }}
            >
              Anwenden
            </Button>
            {sync.isPending && <span className="text-xs text-muted self-center">Laeuft…</span>}
          </div>
          {syncResult && <p className="text-xs text-green-400">{syncResult}</p>}
          {syncDiff && (
            <div className="bg-bg-elev rounded-md border border-border p-3 text-xs space-y-2">
              <div className="flex flex-wrap gap-3 text-muted">
                <span>Lokal: <span className="text-white font-mono">{syncDiff.counts.local}</span></span>
                <span>Nitrado: <span className="text-white font-mono">{syncDiff.counts.remote}</span></span>
                <span>Gemeinsam: <span className="text-white font-mono">{syncDiff.counts.both}</span></span>
                <span>Nur lokal: <span className="text-yellow-400 font-mono">{syncDiff.counts.onlyLocal}</span></span>
                <span>Nur Nitrado: <span className="text-yellow-400 font-mono">{syncDiff.counts.onlyRemote}</span></span>
              </div>
              {syncDiff.onlyLocal.length > 0 && (
                <div>
                  <div className="text-muted mb-1">Nur in DB ({syncDiff.onlyLocal.length}):</div>
                  <div className="flex flex-wrap gap-1 max-h-32 overflow-y-auto">
                    {syncDiff.onlyLocal.slice(0, 50).map(n => (
                      <span key={`l-${n}`} className="px-1.5 py-0.5 rounded bg-bg border border-border font-mono">{n}</span>
                    ))}
                    {syncDiff.onlyLocal.length > 50 && <span className="text-muted">+{syncDiff.onlyLocal.length - 50} weitere…</span>}
                  </div>
                </div>
              )}
              {syncDiff.onlyRemote.length > 0 && (
                <div>
                  <div className="text-muted mb-1">Nur auf Nitrado ({syncDiff.onlyRemote.length}):</div>
                  <div className="flex flex-wrap gap-1 max-h-32 overflow-y-auto">
                    {syncDiff.onlyRemote.slice(0, 50).map(n => (
                      <span key={`r-${n}`} className="px-1.5 py-0.5 rounded bg-bg border border-border font-mono">{n}</span>
                    ))}
                    {syncDiff.onlyRemote.length > 50 && <span className="text-muted">+{syncDiff.onlyRemote.length - 50} weitere…</span>}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader><CardTitle>Pending-Requests</CardTitle></CardHeader>
        {requests.isLoading && <p className="text-muted">Lade…</p>}
        <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
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
    </div>
  );
}

// ----------------------------------------------------------------------------
// Whitelist-Channels (Kanal-Integration)
// ----------------------------------------------------------------------------

function WhitelistChannelsCard({ guildId, slot }: { guildId: string; slot: string }) {
  const qc = useQueryClient();
  const qs = `?slot=${slot}`;

  const channels = useQuery({
    queryKey: ['guild-channels', guildId],
    queryFn: () => api.get<{ channels: ChannelOption[] }>(`/api/v2/guilds/${guildId}/channels`),
    retry: false,
  });
  const cfg = useQuery({
    queryKey: ['whitelist-channels', guildId, slot],
    queryFn: () => api.get<WhitelistChannelsState>(`/api/v2/guilds/${guildId}/whitelist/channels${qs}`),
    retry: false,
  });

  const [draft, setDraft] = useState<WhitelistChannelsState>({
    infoChannelId: null, requestChannelId: null,
    approveLogChannelId: null, denyLogChannelId: null,
    infoMessageId: null,
  });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (cfg.data) setDraft(cfg.data);
  }, [cfg.data]);

  const save = useMutation({
    mutationFn: (body: Omit<WhitelistChannelsState, 'infoMessageId'>) =>
      api.put<{ ok: boolean; infoResult?: { posted: boolean; updated: boolean; messageId?: string } | null } & WhitelistChannelsState>(
        `/api/v2/guilds/${guildId}/whitelist/channels${qs}`, body,
      ),
    onSuccess: res => {
      const parts = ['Gespeichert.'];
      if (res.infoResult?.posted) parts.push('Info-Embed neu gepostet.');
      else if (res.infoResult?.updated) parts.push('Info-Embed aktualisiert.');
      setMsg({ ok: true, text: parts.join(' ') });
      void qc.invalidateQueries({ queryKey: ['whitelist-channels', guildId, slot] });
    },
    onError: (e: Error) => setMsg({ ok: false, text: `Fehler: ${e.message}` }),
  });

  const repost = useMutation({
    mutationFn: () => api.post<{ ok: boolean; posted: boolean; updated: boolean }>(
      `/api/v2/guilds/${guildId}/whitelist/channels/info/repost${qs}`, {},
    ),
    onSuccess: () => {
      setMsg({ ok: true, text: 'Info-Embed neu gepostet.' });
      void qc.invalidateQueries({ queryKey: ['whitelist-channels', guildId, slot] });
    },
    onError: (e: Error) => setMsg({ ok: false, text: `Fehler: ${e.message}` }),
  });

  const channelsForbidden = channels.isError;
  const opts = (channels.data?.channels ?? []).filter(c => c.type === 0 || c.type === 5); // Text + Announcement

  return (
    <Card>
      <CardHeader><CardTitle>Kanal-Integration (Whitelist)</CardTitle></CardHeader>
      {channelsForbidden && (
        <p className="text-xs text-yellow-400 mb-3">
          Channel-Liste nicht verfuegbar (nur Owner kann Kanaele waehlen).
        </p>
      )}
      <div className="space-y-4">
        <ChannelPicker
          label="Info-Kanal (1× Command-Erklaerung als Embed)"
          help="Sobald ein Kanal gewaehlt wird, postet der Bot dort automatisch genau ein Embed mit der /whitelist-Anleitung. Wechselst du den Kanal, wird das Embed neu gepostet."
          value={draft.infoChannelId}
          onChange={v => setDraft({ ...draft, infoChannelId: v })}
          options={opts}
          forbidden={channelsForbidden}
        />
        <ChannelPicker
          label="Whitelist-Annahme-Kanal (Approval mit Buttons)"
          help="Hier landen Anfragen als Embed mit Annehmen/Ablehnen-Buttons. Nur Mitglieder mit 'Server verwalten' koennen entscheiden."
          value={draft.requestChannelId}
          onChange={v => setDraft({ ...draft, requestChannelId: v })}
          options={opts}
          forbidden={channelsForbidden}
        />
        <ChannelPicker
          label="Log-Kanal: ANGENOMMEN"
          help="Jede Annahme wird strikt nur in diesem Kanal protokolliert (mit Antragsteller, Spielername, Admin)."
          value={draft.approveLogChannelId}
          onChange={v => setDraft({ ...draft, approveLogChannelId: v })}
          options={opts}
          forbidden={channelsForbidden}
        />
        <ChannelPicker
          label="Log-Kanal: ABGELEHNT"
          help="Jede Ablehnung wird strikt nur in diesem Kanal protokolliert."
          value={draft.denyLogChannelId}
          onChange={v => setDraft({ ...draft, denyLogChannelId: v })}
          options={opts}
          forbidden={channelsForbidden}
        />

        <div className="flex flex-wrap gap-2">
          <Button
            disabled={save.isPending || channelsForbidden}
            onClick={() => { setMsg(null); save.mutate({
              infoChannelId: draft.infoChannelId,
              requestChannelId: draft.requestChannelId,
              approveLogChannelId: draft.approveLogChannelId,
              denyLogChannelId: draft.denyLogChannelId,
            }); }}
          >
            {save.isPending ? 'Speichere…' : 'Speichern'}
          </Button>
          <Button
            variant="ghost"
            disabled={repost.isPending || !draft.infoChannelId}
            onClick={() => { setMsg(null); repost.mutate(); }}
          >
            Info-Embed neu posten
          </Button>
        </div>
        {msg && (
          <p className={`text-xs ${msg.ok ? 'text-green-400' : 'text-danger'}`}>{msg.text}</p>
        )}
      </div>
    </Card>
  );
}

function ChannelPicker({
  label, help, value, onChange, options, forbidden,
}: {
  label: string;
  help?: string;
  value: string | null;
  onChange: (v: string | null) => void;
  options: ChannelOption[];
  forbidden: boolean;
}) {
  return (
    <label className="text-sm block">
      <span className="text-white font-medium">{label}</span>
      {help && <span className="block text-xs text-muted mb-1">{help}</span>}
      <select
        className="w-full bg-bg-elev border border-border rounded-md px-2 py-1.5 text-sm text-white disabled:opacity-50"
        value={value ?? ''}
        disabled={forbidden}
        onChange={e => onChange(e.target.value === '' ? null : e.target.value)}
      >
        <option value="">— nicht gesetzt —</option>
        {options.map(c => (
          <option key={c.id} value={c.id}>#{c.name}</option>
        ))}
      </select>
    </label>
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

interface EconomyOverviewData {
  economy: { enabled: boolean; currencyName: string; emoji: string; accounts: number; links: number; transactions: number };
  bank: { totalWallet: string; totalBank: string; interestPercent: number; bankChannelId: string | null };
  casino: {
    gamesConfigured: number; gamesEnabled: number; rounds: number;
    totalBet: string; totalPayout: string; houseEdge: string;
    stats: Array<{ type: string; rounds: number; wins: number; losses: number; bet: string; payout: string }>;
  };
  recentTransactions: Array<{ id: string; userDiscordId: string; delta: string; type: string; reason: string | null; createdAt: string }>;
  coupling: {
    sharedCurrency: boolean; sharedBalance: boolean; directlyBooked: boolean;
    sharedModels: string[]; casinoStatsMovable: boolean; raceConditionsGuarded: boolean;
    centralTransactionService: string;
  };
}

function fmtBig(s: string): string {
  try { return BigInt(s).toLocaleString('de-DE'); } catch { return s; }
}

// Wirtschaft-Status: ersetzt den frueheren Economy-`/status` Discord-Command.
function EconomyOverview({ guildId }: { guildId: string }) {
  const q = useQuery({
    queryKey: ['economy-overview', guildId],
    queryFn: () => api.get<EconomyOverviewData>(`/api/v2/guilds/${guildId}/economy/overview`),
    retry: false,
  });

  if (q.isLoading) return <Card><div className="h-24 rounded-lg skeleton" /></Card>;
  if (q.isError || !q.data) return null;
  const d = q.data;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle><span className="inline-flex items-center gap-2"><Coins className="h-4 w-4" />Wirtschaft-Status</span></CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant={d.economy.enabled ? 'ok' : 'neutral'}>{d.economy.enabled ? 'Aktiv' : 'Inaktiv'}</Badge>
            <Button variant="ghost" size="sm" onClick={() => q.refetch()} disabled={q.isFetching}>
              <RefreshCw className={`h-3.5 w-3.5 ${q.isFetching ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>
      </CardHeader>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-2">
        <div className="rounded-lg border border-border/60 bg-bg/40 p-3">
          <p className="text-[11px] text-muted">Konten</p>
          <p className="text-lg font-semibold text-white">{d.economy.accounts.toLocaleString('de-DE')}</p>
        </div>
        <div className="rounded-lg border border-border/60 bg-bg/40 p-3">
          <p className="text-[11px] text-muted">Verknüpfungen</p>
          <p className="text-lg font-semibold text-white">{d.economy.links.toLocaleString('de-DE')}</p>
        </div>
        <div className="rounded-lg border border-border/60 bg-bg/40 p-3">
          <p className="text-[11px] text-muted">Wallet gesamt</p>
          <p className="text-lg font-semibold text-white">{fmtBig(d.bank.totalWallet)} {d.economy.emoji}</p>
        </div>
        <div className="rounded-lg border border-border/60 bg-bg/40 p-3">
          <p className="text-[11px] text-muted">Bank gesamt</p>
          <p className="text-lg font-semibold text-white">{fmtBig(d.bank.totalBank)} {d.economy.emoji}</p>
        </div>
      </div>

      {/* Casino-Status */}
      <div className="mt-4">
        <p className="text-xs font-medium text-white/90 mb-2 inline-flex items-center gap-1.5"><Dice5 className="h-3.5 w-3.5" />Casino</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="rounded-lg border border-border/60 bg-bg/40 p-3">
            <p className="text-[11px] text-muted">Spiele aktiv</p>
            <p className="text-lg font-semibold text-white">{d.casino.gamesEnabled}/{d.casino.gamesConfigured}</p>
          </div>
          <div className="rounded-lg border border-border/60 bg-bg/40 p-3">
            <p className="text-[11px] text-muted">Runden</p>
            <p className="text-lg font-semibold text-white">{d.casino.rounds.toLocaleString('de-DE')}</p>
          </div>
          <div className="rounded-lg border border-border/60 bg-bg/40 p-3">
            <p className="text-[11px] text-muted">Einsätze gesamt</p>
            <p className="text-lg font-semibold text-white">{fmtBig(d.casino.totalBet)} {d.economy.emoji}</p>
          </div>
          <div className="rounded-lg border border-border/60 bg-bg/40 p-3">
            <p className="text-[11px] text-muted">House Edge</p>
            <p className="text-lg font-semibold text-white">{fmtBig(d.casino.houseEdge)} {d.economy.emoji}</p>
          </div>
        </div>
        {d.casino.stats.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {d.casino.stats.map(s => (
              <Badge key={s.type} variant="neutral">
                {s.type}: {s.rounds} Runden · {s.wins}W/{s.losses}L
              </Badge>
            ))}
          </div>
        )}
      </div>

      {/* Letzte Transaktionen */}
      {d.recentTransactions.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-medium text-white/90 mb-2">Letzte Transaktionen</p>
          <div className="divide-y divide-border/50">
            {d.recentTransactions.map(t => (
              <div key={t.id} className="flex items-center gap-2.5 py-1.5 text-xs">
                <span className={`font-mono shrink-0 ${BigInt(t.delta) >= 0n ? 'text-ok' : 'text-danger'}`}>
                  {BigInt(t.delta) >= 0n ? '+' : ''}{fmtBig(t.delta)}
                </span>
                <span className="text-muted shrink-0">{t.type}</span>
                <span className="text-muted/70 truncate">{t.reason ?? ''}</span>
                <span className="text-muted/50 ml-auto shrink-0">{new Date(t.createdAt).toLocaleString('de-DE')}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Casino/Bank-Kopplung */}
      <div className="mt-4 rounded-lg border border-border/60 bg-bg-elev/40 p-3">
        <p className="text-xs font-medium text-white/90 mb-2">Casino/Bank-Kopplung</p>
        <div className="grid sm:grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-muted">
          <span>• Gemeinsame Währung: {d.coupling.sharedCurrency ? 'ja (Wallet)' : 'nein'}</span>
          <span>• Gleicher Kontostand: {d.coupling.sharedBalance ? 'ja' : 'nein'}</span>
          <span>• Direkt verbucht: {d.coupling.directlyBooked ? 'ja (CASINO_BET/PAYOUT)' : 'nein'}</span>
          <span>• Race-Conditions abgesichert: {d.coupling.raceConditionsGuarded ? 'ja (DB-Transaktionen)' : 'nein'}</span>
          <span>• Geteilte Models: {d.coupling.sharedModels.join(', ')}</span>
          <span>• Casino-Stats verschiebbar: {d.coupling.casinoStatsMovable ? 'ja' : 'nein'}</span>
          <span className="sm:col-span-2">• Zentraler Transaction-Service: <code className="font-mono">{d.coupling.centralTransactionService}</code></span>
        </div>
      </div>
    </Card>
  );
}

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
      <EconomyOverview guildId={guildId} />
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
