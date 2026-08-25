import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  Banknote,
  History,
  Landmark,
  Plus,
  RefreshCw,
  Save,
  Send,
  Settings,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { api, createIdempotencyKey } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';

interface ProjectionState {
  channelId: string | null;
  messageId: string | null;
  archiveThreadId: string | null;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
}

interface VirtualAccountControl {
  id: string;
  kind: 'CUSTOM' | 'LOTTERY_POT' | 'MARKET_VENDOR';
  name: string;
  walletBalance: string;
  bankBalance: string;
  totalBalance: string;
  status: 'ACTIVE' | 'EXPIRED' | 'ARCHIVED';
  acceptUserTransfers: boolean;
  expiresAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  description: string | null;
  channelId: string | null;
  currencyName: string;
  currencyEmoji: string;
  accountEmoji: string;
  bannerUrl: string | null;
  textStyle: 'NORMAL' | 'BOLD' | 'ITALIC' | 'BOLD_ITALIC';
  exchangePlayerUnits: string | null;
  exchangeAccountUnits: string | null;
  accountPurpose: 'GENERAL' | 'BANK_TREASURY';
  managers: string[];
  projection: ProjectionState | null;
}

interface VirtualEntry {
  id: string;
  delta: string;
  entryType: string;
  sourcePocket: 'WALLET' | 'BANK' | null;
  actorDiscordId: string | null;
  userDiscordId: string | null;
  reason: string | null;
  createdAt: string;
}

interface DiscordChannel {
  id: string;
  name: string;
  type: number;
  parentId: string | null;
}

interface DiscordMember {
  discordId: string;
  username: string;
  displayName: string;
  avatar: string | null;
}

interface LegacyMember {
  id: string;
  discordId: string;
  username: string;
  displayName: string;
  avatar: string | null;
}

interface ManagerPanel {
  id: string;
  guildId: string;
  nitradoConnId: string;
  channelId: string;
  messageId: string | null;
}

interface AccountMutationResponse {
  account: VirtualAccountControl;
  syncWarning?: string | null;
}

interface AccountDraft {
  description: string;
  channelId: string;
  currencyName: string;
  currencyEmoji: string;
  accountEmoji: string;
  bannerUrl: string;
  textStyle: VirtualAccountControl['textStyle'];
  exchangePlayerUnits: string;
  exchangeAccountUnits: string;
  acceptUserTransfers: boolean;
  managers: string[];
}

interface CreateDraft extends AccountDraft {
  name: string;
  expiresAt: string;
}

const USER_GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fmtBig(value: string): string {
  try { return BigInt(value).toLocaleString('de-DE'); } catch { return value; }
}

function avatarUrl(member: { discordId: string; avatar: string | null }): string {
  if (member.avatar) return `https://cdn.discordapp.com/avatars/${member.discordId}/${member.avatar}.png?size=64`;
  try { return `https://cdn.discordapp.com/embed/avatars/${(BigInt(member.discordId) >> 22n) % 6n}.png`; }
  catch { return 'https://cdn.discordapp.com/embed/avatars/0.png'; }
}

function statusVariant(status: VirtualAccountControl['status']): 'ok' | 'warn' | 'neutral' {
  if (status === 'ACTIVE') return 'ok';
  if (status === 'EXPIRED') return 'warn';
  return 'neutral';
}

function emptyDraft(): CreateDraft {
  return {
    name: '',
    description: '',
    channelId: '',
    currencyName: 'Coins',
    currencyEmoji: '💰',
    accountEmoji: '🏦',
    bannerUrl: '',
    textStyle: 'NORMAL',
    exchangePlayerUnits: '',
    exchangeAccountUnits: '',
    acceptUserTransfers: true,
    managers: [],
    expiresAt: '',
  };
}

function draftFromAccount(account: VirtualAccountControl): AccountDraft {
  return {
    description: account.description ?? '',
    channelId: account.channelId ?? '',
    currencyName: account.currencyName,
    currencyEmoji: account.currencyEmoji,
    accountEmoji: account.accountEmoji,
    bannerUrl: account.bannerUrl ?? '',
    textStyle: account.textStyle,
    exchangePlayerUnits: account.exchangePlayerUnits ?? '',
    exchangeAccountUnits: account.exchangeAccountUnits ?? '',
    acceptUserTransfers: account.acceptUserTransfers,
    managers: [...account.managers],
  };
}

function mutationBody(draft: AccountDraft): Record<string, unknown> {
  return {
    description: draft.description.trim() || null,
    channelId: draft.channelId || null,
    currencyName: draft.currencyName.trim(),
    currencyEmoji: draft.currencyEmoji.trim(),
    accountEmoji: draft.accountEmoji.trim(),
    bannerUrl: draft.bannerUrl.trim() || null,
    textStyle: draft.textStyle,
    exchangePlayerUnits: draft.exchangePlayerUnits.trim() || null,
    exchangeAccountUnits: draft.exchangeAccountUnits.trim() || null,
    acceptUserTransfers: draft.acceptUserTransfers,
    managers: draft.managers,
  };
}

function validateDraft(draft: AccountDraft): string | null {
  if (!draft.currencyName.trim() || draft.currencyName.trim().length > 40) return 'Währungsname muss 1..40 Zeichen enthalten.';
  if (!draft.currencyEmoji.trim() || draft.currencyEmoji.trim().length > 100) return 'Währungs-Emoji fehlt oder ist zu lang.';
  if (!draft.accountEmoji.trim() || draft.accountEmoji.trim().length > 100) return 'Konto-Emoji fehlt oder ist zu lang.';
  if (draft.description.length > 280) return 'Beschreibung darf maximal 280 Zeichen enthalten.';
  if (draft.bannerUrl && !/^https:\/\//i.test(draft.bannerUrl.trim())) return 'Banner/GIF muss eine HTTPS-URL sein.';
  const oneRate = Boolean(draft.exchangePlayerUnits.trim());
  const otherRate = Boolean(draft.exchangeAccountUnits.trim());
  if (oneRate !== otherRate) return 'Ein Wechselkurs benötigt Spieler- und Konto-Einheiten.';
  if (oneRate && (!/^\d+$/.test(draft.exchangePlayerUnits) || !/^\d+$/.test(draft.exchangeAccountUnits))) return 'Wechselkurs-Einheiten müssen positive ganze Zahlen sein.';
  if (oneRate && (BigInt(draft.exchangePlayerUnits) <= 0n || BigInt(draft.exchangeAccountUnits) <= 0n)) return 'Wechselkurs-Einheiten müssen größer als 0 sein.';
  if (draft.managers.length > 25) return 'Maximal 25 Kontoverwalter pro Konto.';
  return null;
}

function ManagerPicker({
  guildId,
  slot,
  managers,
  onChange,
  disabled,
}: {
  guildId: string;
  slot: string;
  managers: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const members = useQuery({
    queryKey: ['economy-virtual-manager-members', guildId, slot, query],
    queryFn: () => api.get<{ members: DiscordMember[] }>(
      `/api/v2/guilds/${guildId}/economy/virtual-accounts/control/members?slot=${encodeURIComponent(slot)}&limit=20${query ? `&q=${encodeURIComponent(query)}` : ''}`,
    ),
    placeholderData: previous => previous,
    retry: false,
  });
  const options = useMemo<ComboboxOption[]>(() => (members.data?.members ?? [])
    .filter(member => !managers.includes(member.discordId))
    .map(member => ({
      id: member.discordId,
      label: member.displayName || member.username,
      hint: member.discordId,
      avatar: avatarUrl(member),
    })), [members.data?.members, managers]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {managers.length === 0 && <span className="text-xs text-muted">Keine Kontoverwalter zugewiesen.</span>}
        {managers.map(id => (
          <span key={id} className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-bg-elev px-2.5 py-1 text-[11px] text-white">
            <span className="truncate">{id}</span>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange(managers.filter(value => value !== id))}
              className="rounded px-1 text-muted hover:text-danger disabled:opacity-40"
              aria-label={`Kontoverwalter ${id} entfernen`}
            >×</button>
          </span>
        ))}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Combobox
          value={selected}
          onChange={(id) => setSelected(id)}
          options={options}
          onSearch={setQuery}
          loading={members.isFetching}
          disabled={disabled}
          placeholder="Guild-Mitglied suchen…"
          emptyText="Kein menschliches Mitglied gefunden."
          className="flex-1"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || !selected || managers.includes(selected)}
          onClick={() => {
            if (!selected) return;
            onChange([...managers, selected]);
            setSelected(null);
            setQuery('');
          }}
        >
          <Users className="h-3.5 w-3.5 mr-1" />Hinzufügen
        </Button>
      </div>
      {members.isError && <p className="text-[11px] text-danger">Member-Suche nicht verfügbar: {(members.error as Error).message}</p>}
    </div>
  );
}

function AccountFields({
  draft,
  setDraft,
  channels,
  disabled,
}: {
  draft: AccountDraft;
  setDraft: (next: AccountDraft) => void;
  channels: DiscordChannel[];
  disabled?: boolean;
}) {
  const patch = (value: Partial<AccountDraft>) => setDraft({ ...draft, ...value });
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <label className="text-sm md:col-span-2">
        <span className="text-muted">Beschreibung</span>
        <textarea
          value={draft.description}
          onChange={event => patch({ description: event.target.value })}
          maxLength={280}
          rows={3}
          disabled={disabled}
          className="mt-1 w-full rounded-md border border-border bg-bg-elev px-3 py-2 text-sm text-white outline-none focus:border-primary disabled:opacity-50"
          placeholder="Zweck des Kontos…"
        />
      </label>
      <label className="text-sm">
        <span className="text-muted">Hauptkanal / Live-Embed</span>
        <Select value={draft.channelId} onChange={event => patch({ channelId: event.target.value })} disabled={disabled}>
          <option value="">— Discord-Integration aus —</option>
          {channels.map(channel => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}
        </Select>
      </label>
      <label className="text-sm">
        <span className="text-muted">Textstil</span>
        <Select value={draft.textStyle} onChange={event => patch({ textStyle: event.target.value as AccountDraft['textStyle'] })} disabled={disabled}>
          <option value="NORMAL">Normal</option>
          <option value="BOLD">Fett</option>
          <option value="ITALIC">Kursiv</option>
          <option value="BOLD_ITALIC">Fett + Kursiv</option>
        </Select>
      </label>
      <label className="text-sm">
        <span className="text-muted">Währungsname</span>
        <Input value={draft.currencyName} onChange={event => patch({ currencyName: event.target.value })} maxLength={40} disabled={disabled} />
      </label>
      <label className="text-sm">
        <span className="text-muted">Währungs-Emoji</span>
        <Input value={draft.currencyEmoji} onChange={event => patch({ currencyEmoji: event.target.value })} maxLength={100} disabled={disabled} />
      </label>
      <label className="text-sm">
        <span className="text-muted">Konto-Emoji</span>
        <Input value={draft.accountEmoji} onChange={event => patch({ accountEmoji: event.target.value })} maxLength={100} disabled={disabled} />
      </label>
      <label className="text-sm">
        <span className="text-muted">Banner/GIF (HTTPS)</span>
        <Input value={draft.bannerUrl} onChange={event => patch({ bannerUrl: event.target.value })} maxLength={512} disabled={disabled} placeholder="https://…" />
      </label>
      <label className="text-sm">
        <span className="text-muted">Wechselkurs: Spieler-Einheiten</span>
        <Input inputMode="numeric" value={draft.exchangePlayerUnits} onChange={event => patch({ exchangePlayerUnits: event.target.value.replace(/\D/g, '') })} disabled={disabled} placeholder="z. B. 100" />
      </label>
      <label className="text-sm">
        <span className="text-muted">Wechselkurs: Konto-Einheiten</span>
        <Input inputMode="numeric" value={draft.exchangeAccountUnits} onChange={event => patch({ exchangeAccountUnits: event.target.value.replace(/\D/g, '') })} disabled={disabled} placeholder="z. B. 1" />
      </label>
      <div className="md:col-span-2">
        <Switch checked={draft.acceptUserTransfers} onChange={value => patch({ acceptUserTransfers: value })} label="Direkte Spieler-Einzahlungen erlauben" disabled={disabled} />
      </div>
    </div>
  );
}

function AccountEditor({
  account,
  guildId,
  slot,
  channels,
  onDone,
}: {
  account: VirtualAccountControl;
  guildId: string;
  slot: string;
  channels: DiscordChannel[];
  onDone: (message: { ok: boolean; text: string }) => void;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<AccountDraft>(() => draftFromAccount(account));
  const validation = validateDraft(draft);
  const save = useMutation({
    mutationFn: () => api.put<AccountMutationResponse>(
      `/api/v2/guilds/${guildId}/economy/virtual-accounts/control/accounts/${account.id}?slot=${encodeURIComponent(slot)}`,
      mutationBody(draft),
    ),
    onSuccess: result => {
      onDone({ ok: true, text: result.syncWarning ? `Gespeichert. Discord-Sync: ${result.syncWarning}` : 'Kontoeinstellungen gespeichert und synchronisiert.' });
      void qc.invalidateQueries({ queryKey: ['economy-virtual-control', guildId, slot] });
      void qc.invalidateQueries({ queryKey: ['economy-virtual-manager-panel', guildId, slot] });
    },
    onError: (error: Error) => onDone({ ok: false, text: error.message }),
  });

  return (
    <div className="mt-4 border-t border-border/60 pt-4 space-y-4">
      <AccountFields draft={draft} setDraft={setDraft} channels={channels} disabled={save.isPending || account.status === 'ARCHIVED'} />
      <div>
        <p className="text-xs font-medium text-white mb-2">Kontoverwalter</p>
        <ManagerPicker guildId={guildId} slot={slot} managers={draft.managers} onChange={managers => setDraft({ ...draft, managers })} disabled={save.isPending || account.status === 'ARCHIVED'} />
      </div>
      {validation && <p className="text-xs text-danger">{validation}</p>}
      <div className="flex flex-wrap gap-2">
        <Button disabled={Boolean(validation) || save.isPending || account.status === 'ARCHIVED'} onClick={() => save.mutate()}>
          <Save className="h-3.5 w-3.5 mr-1" />{save.isPending ? 'Speichere…' : 'Speichern'}
        </Button>
        <Button variant="ghost" disabled={save.isPending} onClick={() => setDraft(draftFromAccount(account))}>Zurücksetzen</Button>
      </div>
    </div>
  );
}

export function VirtualAccountsControlPanel({ guildId, slot }: { guildId: string; slot: string }) {
  const qc = useQueryClient();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [createDraft, setCreateDraft] = useState<CreateDraft>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [auditAccountId, setAuditAccountId] = useState<string>('');
  const [managerChannel, setManagerChannel] = useState<string>('');
  const [managerChannelTouched, setManagerChannelTouched] = useState(false);

  const accounts = useQuery({
    queryKey: ['economy-virtual-control', guildId, slot],
    queryFn: () => api.get<{ accounts: VirtualAccountControl[] }>(
      `/api/v2/guilds/${guildId}/economy/virtual-accounts/control/accounts?slot=${encodeURIComponent(slot)}`,
    ),
    retry: false,
  });
  const channels = useQuery({
    queryKey: ['guild-channels', guildId],
    queryFn: () => api.get<{ channels: DiscordChannel[] }>(`/api/v2/guilds/${guildId}/channels`),
    retry: false,
  });
  const managerPanel = useQuery({
    queryKey: ['economy-virtual-manager-panel', guildId, slot],
    queryFn: () => api.get<{ panel: ManagerPanel | null }>(
      `/api/v2/guilds/${guildId}/economy/virtual-accounts/control/manager-panel?slot=${encodeURIComponent(slot)}`,
    ),
    retry: false,
  });

  const textChannels = useMemo(
    () => (channels.data?.channels ?? []).filter(channel => channel.type === 0),
    [channels.data?.channels],
  );
  const channelNames = useMemo(() => new Map(textChannels.map(channel => [channel.id, channel.name] as const)), [textChannels]);
  const rows = useMemo(() => accounts.data?.accounts ?? [], [accounts.data?.accounts]);
  const treasury = rows.find(account => account.accountPurpose === 'BANK_TREASURY') ?? null;
  const effectiveManagerChannel = managerChannelTouched ? managerChannel : (managerPanel.data?.panel?.channelId ?? '');

  const createValidation = useMemo(() => {
    if (!createDraft.name.trim() || createDraft.name.trim().length > 80) return 'Kontoname muss 1..80 Zeichen enthalten.';
    if (createDraft.expiresAt) {
      const when = new Date(createDraft.expiresAt).getTime();
      if (!Number.isFinite(when) || when <= Date.now()) return 'Ablaufzeit muss in der Zukunft liegen.';
    }
    return validateDraft(createDraft);
  }, [createDraft]);

  const create = useMutation({
    mutationFn: () => api.post<AccountMutationResponse>(
      `/api/v2/guilds/${guildId}/economy/virtual-accounts/control/accounts?slot=${encodeURIComponent(slot)}`,
      {
        ...mutationBody(createDraft),
        name: createDraft.name.trim(),
        expiresAt: createDraft.expiresAt ? new Date(createDraft.expiresAt).toISOString() : null,
      },
    ),
    onSuccess: result => {
      setCreateDraft(emptyDraft());
      setMessage({ ok: true, text: result.syncWarning ? `Konto erstellt. Discord-Sync: ${result.syncWarning}` : `Konto „${result.account.name}“ erstellt.` });
      void qc.invalidateQueries({ queryKey: ['economy-virtual-control', guildId, slot] });
      void qc.invalidateQueries({ queryKey: ['economy-virtual-manager-panel', guildId, slot] });
    },
    onError: (error: Error) => setMessage({ ok: false, text: error.message }),
  });

  const ensureTreasury = useMutation({
    mutationFn: () => api.post<AccountMutationResponse>(
      `/api/v2/guilds/${guildId}/economy/virtual-accounts/control/bank-treasury?slot=${encodeURIComponent(slot)}`,
      {},
    ),
    onSuccess: result => {
      setMessage({ ok: true, text: `Serverbank „${result.account.name}“ ist bereit.` });
      setEditingId(result.account.id);
      void qc.invalidateQueries({ queryKey: ['economy-virtual-control', guildId, slot] });
    },
    onError: (error: Error) => setMessage({ ok: false, text: error.message }),
  });

  const saveManagerPanel = useMutation({
    mutationFn: () => api.put<{ panel: ManagerPanel }>(
      `/api/v2/guilds/${guildId}/economy/virtual-accounts/control/manager-panel?slot=${encodeURIComponent(slot)}`,
      { channelId: effectiveManagerChannel },
    ),
    onSuccess: result => {
      setManagerChannel(result.panel.channelId);
      setManagerChannelTouched(false);
      setMessage({ ok: true, text: 'Management-Kanal synchronisiert. Rollenlose Kontoverwalter-Zugriffe wurden aktualisiert.' });
      void qc.invalidateQueries({ queryKey: ['economy-virtual-manager-panel', guildId, slot] });
    },
    onError: (error: Error) => setMessage({ ok: false, text: error.message }),
  });

  const syncAccount = useMutation({
    mutationFn: (accountId: string) => api.post<{ ok: boolean; account: VirtualAccountControl }>(
      `/api/v2/guilds/${guildId}/economy/virtual-accounts/control/accounts/${accountId}/sync?slot=${encodeURIComponent(slot)}`,
      {},
    ),
    onSuccess: result => {
      setMessage({ ok: true, text: `Discord-Projektion für „${result.account.name}“ synchronisiert.` });
      void qc.invalidateQueries({ queryKey: ['economy-virtual-control', guildId, slot] });
    },
    onError: (error: Error) => setMessage({ ok: false, text: error.message }),
  });

  const archive = useMutation({
    mutationFn: (accountId: string) => api.post<{ id: string }>(
      `/api/v2/guilds/${guildId}/economy/virtual-accounts/${accountId}/archive?slot=${encodeURIComponent(slot)}`,
      {},
    ),
    onSuccess: () => {
      setEditingId(null);
      setMessage({ ok: true, text: 'Konto archiviert.' });
      void qc.invalidateQueries({ queryKey: ['economy-virtual-control', guildId, slot] });
    },
    onError: (error: Error) => setMessage({ ok: false, text: error.message }),
  });

  const audit = useQuery({
    queryKey: ['economy-virtual-account-audit', guildId, slot, auditAccountId],
    queryFn: () => api.get<{ entries: VirtualEntry[] }>(
      `/api/v2/guilds/${guildId}/economy/virtual-accounts/${auditAccountId}/entries?slot=${encodeURIComponent(slot)}&limit=50`,
    ),
    enabled: auditAccountId.length > 0,
    retry: false,
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle><span className="inline-flex items-center gap-2"><Banknote className="h-4 w-4" />Virtuelle Konten</span></CardTitle>
          <Button variant="ghost" size="sm" onClick={() => accounts.refetch()} disabled={accounts.isFetching} aria-label="Virtuelle Konten aktualisieren">
            <RefreshCw className={`h-3.5 w-3.5 ${accounts.isFetching ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </CardHeader>

      <p className="text-xs text-muted mb-4">
        Jedes Konto besitzt ein eigenes Wallet und Bankkonto, eigene Währung/Emojis und optional ein Discord-Live-Embed mit Transaktionsarchiv. Lotterie- und Markt-Systemkonten bleiben fachlich geschützt.
      </p>

      {message && (
        <div className={`mb-4 rounded-lg border px-3 py-2 text-sm ${message.ok ? 'border-success/40 bg-success/10 text-success' : 'border-danger/40 bg-danger/10 text-danger'}`} role="status">
          {message.text}
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-2 mb-5">
        <div className="rounded-lg border border-border/60 bg-bg/40 p-3 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium text-white inline-flex items-center gap-1.5"><Landmark className="h-3.5 w-3.5" />Serverbank</p>
            {treasury && <Badge variant="ok">aktiv</Badge>}
          </div>
          <p className="text-xs text-muted">Die Serverbank ist ein geschütztes CUSTOM-Treasury-Konto mit eigenem Wallet + Bankreserve. Sie kann anschließend wie jedes andere Konto gestaltet und mit Managern versehen werden.</p>
          {treasury ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm text-white">{treasury.accountEmoji} {treasury.name} · {fmtBig(treasury.totalBalance)} {treasury.currencyEmoji}</span>
              <Button size="sm" variant="outline" onClick={() => setEditingId(treasury.id)}>Konfigurieren</Button>
            </div>
          ) : (
            <Button size="sm" disabled={ensureTreasury.isPending || accounts.isError} onClick={() => ensureTreasury.mutate()}>
              <Landmark className="h-3.5 w-3.5 mr-1" />{ensureTreasury.isPending ? 'Erstelle…' : 'Serverbank anlegen'}
            </Button>
          )}
        </div>

        <div className="rounded-lg border border-border/60 bg-bg/40 p-3 space-y-3">
          <p className="text-sm font-medium text-white inline-flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5" />Management-Kanal</p>
          <p className="text-xs text-muted">Kein Rollen-Zwang: V-Bot gibt nur den aktuell zugewiesenen Kontoverwaltern Zugriff und stellt vorbestehende User-Rechte beim Entfernen wieder her.</p>
          <Select
            value={effectiveManagerChannel}
            onChange={event => { setManagerChannel(event.target.value); setManagerChannelTouched(true); }}
            disabled={channels.isLoading || saveManagerPanel.isPending}
          >
            <option value="">— Management-Kanal auswählen —</option>
            {textChannels.map(channel => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}
          </Select>
          <Button size="sm" disabled={!effectiveManagerChannel || saveManagerPanel.isPending || channels.isError} onClick={() => saveManagerPanel.mutate()}>
            <Settings className="h-3.5 w-3.5 mr-1" />{saveManagerPanel.isPending ? 'Synchronisiere…' : 'Management-Kanal speichern'}
          </Button>
          {managerPanel.data?.panel?.messageId && <p className="text-[11px] text-muted">Panel aktiv in #{channelNames.get(managerPanel.data.panel.channelId) ?? managerPanel.data.panel.channelId}</p>}
        </div>
      </div>

      <div className="rounded-lg border border-border/60 bg-bg/40 p-3 space-y-3 mb-5">
        <p className="text-sm font-medium text-white inline-flex items-center gap-1.5"><Plus className="h-3.5 w-3.5" />Neues Konto</p>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="text-sm">
            <span className="text-muted">Kontoname</span>
            <Input value={createDraft.name} onChange={event => setCreateDraft({ ...createDraft, name: event.target.value })} maxLength={80} placeholder="z. B. Eventkasse" />
          </label>
          <label className="text-sm">
            <span className="text-muted">Ablauf (optional)</span>
            <Input type="datetime-local" value={createDraft.expiresAt} onChange={event => setCreateDraft({ ...createDraft, expiresAt: event.target.value })} />
          </label>
        </div>
        <AccountFields draft={createDraft} setDraft={next => setCreateDraft({ ...createDraft, ...next })} channels={textChannels} disabled={create.isPending} />
        <div>
          <p className="text-xs font-medium text-white mb-2">Kontoverwalter</p>
          <ManagerPicker guildId={guildId} slot={slot} managers={createDraft.managers} onChange={managers => setCreateDraft({ ...createDraft, managers })} disabled={create.isPending} />
        </div>
        {createValidation && <p className="text-xs text-danger">{createValidation}</p>}
        <Button disabled={create.isPending || accounts.isError || channels.isError || Boolean(createValidation)} onClick={() => { setMessage(null); create.mutate(); }}>
          {create.isPending ? 'Erstelle…' : 'Konto erstellen'}
        </Button>
      </div>

      {accounts.isLoading && <p className="text-muted text-sm">Lade Konten…</p>}
      {accounts.isError && <p className="text-danger text-sm">Virtuelle Konten konnten nicht geladen werden: {(accounts.error as Error).message}</p>}
      <div className="space-y-3">
        {rows.length === 0 && !accounts.isLoading && <p className="text-muted text-sm">Noch keine virtuellen Konten.</p>}
        {rows.map(account => {
          const canArchive = account.kind === 'CUSTOM' && account.status !== 'ARCHIVED' && BigInt(account.walletBalance) === 0n && BigInt(account.bankBalance) === 0n;
          return (
            <div key={account.id} className="rounded-lg border border-border/60 bg-bg-elev/40 p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium text-white truncate">{account.accountEmoji} {account.name}</p>
                    <Badge variant={statusVariant(account.status)}>{account.status}</Badge>
                    <Badge variant="neutral">{account.accountPurpose === 'BANK_TREASURY' ? 'SERVERBANK' : account.kind}</Badge>
                  </div>
                  {account.description && <p className="text-xs text-muted mt-1 whitespace-pre-wrap">{account.description}</p>}
                  <div className="mt-2 grid max-w-xl grid-cols-3 gap-2 text-xs">
                    <div><span className="text-muted block">Wallet</span><span className="text-white font-semibold">{fmtBig(account.walletBalance)} {account.currencyEmoji}</span></div>
                    <div><span className="text-muted block">Bank</span><span className="text-white font-semibold">{fmtBig(account.bankBalance)} {account.currencyEmoji}</span></div>
                    <div><span className="text-muted block">Gesamt</span><span className="text-white font-semibold">{fmtBig(account.totalBalance)} {account.currencyEmoji}</span></div>
                  </div>
                  <p className="text-[11px] text-muted mt-2">
                    Währung: {account.currencyName} {account.currencyEmoji}
                    {' · '}Manager: {account.managers.length}
                    {' · '}Einzahlungen: {account.acceptUserTransfers && account.status === 'ACTIVE' ? 'offen' : 'gesperrt'}
                    {' · '}{account.channelId ? `Live in #${channelNames.get(account.channelId) ?? account.channelId}` : 'Discord-Integration aus'}
                  </p>
                  {account.projection?.lastSyncError && <p className="text-[11px] text-danger mt-1">Discord-Syncfehler: {account.projection.lastSyncError}</p>}
                  {account.projection?.lastSyncedAt && !account.projection.lastSyncError && <p className="text-[11px] text-success mt-1">Live-Sync: {new Date(account.projection.lastSyncedAt).toLocaleString('de-DE')}</p>}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => setEditingId(editingId === account.id ? null : account.id)} disabled={account.status === 'ARCHIVED'}>
                    <Settings className="h-3.5 w-3.5 mr-1" />Konfigurieren
                  </Button>
                  <Button size="sm" variant="ghost" disabled={!account.channelId || syncAccount.isPending} onClick={() => syncAccount.mutate(account.id)}>
                    <RefreshCw className="h-3.5 w-3.5 mr-1" />Sync
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setAuditAccountId(auditAccountId === account.id ? '' : account.id)}>
                    <History className="h-3.5 w-3.5 mr-1" />Audit
                  </Button>
                  {account.kind === 'CUSTOM' && account.status !== 'ARCHIVED' && (
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={!canArchive || archive.isPending}
                      onClick={() => archive.mutate(account.id)}
                      title={canArchive ? 'Konto archivieren' : 'Archivieren erst bei Wallet=0 und Bank=0 möglich.'}
                    >
                      <Archive className="h-3.5 w-3.5 mr-1" />Archivieren
                    </Button>
                  )}
                </div>
              </div>

              {editingId === account.id && (
                <AccountEditor account={account} guildId={guildId} slot={slot} channels={textChannels} onDone={setMessage} />
              )}

              {auditAccountId === account.id && (
                <div className="mt-3 pt-3 border-t border-border/60">
                  {audit.isLoading && <p className="text-xs text-muted">Lade Audit…</p>}
                  {audit.isError && <p className="text-xs text-danger">Audit konnte nicht geladen werden: {(audit.error as Error).message}</p>}
                  {audit.data?.entries.length === 0 && <p className="text-xs text-muted">Noch keine Buchungen.</p>}
                  <div className="space-y-1.5">
                    {audit.data?.entries.map(entry => (
                      <div key={entry.id} className="rounded border border-border/50 bg-bg/40 px-2.5 py-2 text-[11px]">
                        <span className={BigInt(entry.delta) >= 0n ? 'text-success' : 'text-danger'}>{fmtBig(entry.delta)} {account.currencyEmoji}</span>
                        <span className="text-muted"> · {entry.entryType}{entry.sourcePocket ? ` · ${entry.sourcePocket}` : ''} · {new Date(entry.createdAt).toLocaleString('de-DE')}</span>
                        {entry.reason && <div className="text-muted mt-0.5">{entry.reason}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <LegacyAdminPayout guildId={guildId} slot={slot} accounts={rows} onDone={setMessage} />
    </Card>
  );
}

function LegacyAdminPayout({
  guildId,
  slot,
  accounts,
  onDone,
}: {
  guildId: string;
  slot: string;
  accounts: VirtualAccountControl[];
  onDone: (message: { ok: boolean; text: string }) => void;
}) {
  const qc = useQueryClient();
  const [query, setQuery] = useState('');
  const [selectedMember, setSelectedMember] = useState<ComboboxOption | null>(null);
  const [form, setForm] = useState({ accountId: '', userId: '', amount: '', sourcePocket: 'WALLET', targetPocket: 'WALLET', reason: '' });
  const [operationId, setOperationId] = useState(createIdempotencyKey);
  const members = useQuery({
    queryKey: ['economy-virtual-payout-members', guildId, slot, query],
    queryFn: () => api.get<{ members: LegacyMember[] }>(
      `/api/v2/guilds/${guildId}/economy/virtual-accounts/members?slot=${encodeURIComponent(slot)}&limit=20${query ? `&q=${encodeURIComponent(query)}` : ''}`,
    ),
    placeholderData: previous => previous,
    retry: false,
  });
  const options = useMemo<ComboboxOption[]>(() => {
    const mapped: ComboboxOption[] = (members.data?.members ?? []).map(member => ({
      id: member.id,
      label: member.displayName || member.username,
      hint: `Discord ${member.discordId}`,
      avatar: avatarUrl(member),
    }));
    if (selectedMember && !mapped.some(option => option.id === selectedMember.id)) mapped.unshift(selectedMember);
    return mapped;
  }, [members.data?.members, selectedMember]);
  const payoutAccounts = accounts.filter(account => account.kind === 'CUSTOM' && account.status !== 'ARCHIVED' && BigInt(account.totalBalance) > 0n);
  const valid = form.accountId && USER_GUID_RE.test(form.userId) && /^\d+$/.test(form.amount) && BigInt(form.amount || '0') > 0n && form.reason.trim().length >= 3 && form.reason.trim().length <= 180;
  const mutation = useMutation({
    mutationFn: () => api.post<{ ok: boolean; booked: boolean; account: VirtualAccountControl }>(
      `/api/v2/guilds/${guildId}/economy/virtual-accounts/${form.accountId}/payout?slot=${encodeURIComponent(slot)}`,
      {
        userId: form.userId,
        amount: form.amount,
        sourcePocket: form.sourcePocket,
        targetPocket: form.targetPocket,
        reason: form.reason.trim(),
        operationId,
      },
    ),
    onSuccess: result => {
      onDone({ ok: true, text: result.booked ? 'Admin-Auszahlung atomar gebucht.' : 'Diese Auszahlung war bereits verarbeitet.' });
      setForm({ accountId: '', userId: '', amount: '', sourcePocket: 'WALLET', targetPocket: 'WALLET', reason: '' });
      setSelectedMember(null);
      setQuery('');
      setOperationId(createIdempotencyKey());
      void qc.invalidateQueries({ queryKey: ['economy-virtual-control', guildId, slot] });
    },
    onError: (error: Error) => onDone({ ok: false, text: error.message }),
  });

  return (
    <div className="mt-5 rounded-lg border border-border/60 bg-bg/40 p-3 space-y-3">
      <p className="text-sm font-medium text-white inline-flex items-center gap-1.5"><Send className="h-3.5 w-3.5" />Admin-Auszahlung</p>
      <p className="text-xs text-muted">Bestehende Dashboard-Funktion bleibt erhalten. Das Ziel wird unmittelbar vor der Buchung erneut als aktives menschliches Guild-Mitglied geprüft.</p>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-sm">
          <span className="text-muted">Konto</span>
          <Select value={form.accountId} onChange={event => { setForm({ ...form, accountId: event.target.value }); setOperationId(createIdempotencyKey()); }}>
            <option value="">— auswählen —</option>
            {payoutAccounts.map(account => <option key={account.id} value={account.id}>{account.accountEmoji} {account.name} · {fmtBig(account.totalBalance)} {account.currencyEmoji}</option>)}
          </Select>
        </label>
        <div className="text-sm">
          <span className="text-muted">Empfänger</span>
          <Combobox
            value={form.userId || null}
            onChange={(id, opt) => {
              setForm({ ...form, userId: id ?? '' });
              setSelectedMember(opt);
              setOperationId(createIdempotencyKey());
            }}
            options={options}
            onSearch={setQuery}
            loading={members.isFetching}
            placeholder="Guild-Mitglied suchen…"
          />
        </div>
        <label className="text-sm">
          <span className="text-muted">Betrag in Konto-Währung</span>
          <Input inputMode="numeric" value={form.amount} onChange={event => { setForm({ ...form, amount: event.target.value.replace(/\D/g, '') }); setOperationId(createIdempotencyKey()); }} />
        </label>
        <label className="text-sm">
          <span className="text-muted">Quelle</span>
          <Select value={form.sourcePocket} onChange={event => { setForm({ ...form, sourcePocket: event.target.value }); setOperationId(createIdempotencyKey()); }}>
            <option value="WALLET">Virtuelles Wallet</option>
            <option value="BANK">Virtuelle Bank</option>
          </Select>
        </label>
        <label className="text-sm">
          <span className="text-muted">Ziel beim Spieler</span>
          <Select value={form.targetPocket} onChange={event => { setForm({ ...form, targetPocket: event.target.value }); setOperationId(createIdempotencyKey()); }}>
            <option value="WALLET">Spieler-Wallet</option>
            <option value="BANK">Spieler-Bank</option>
          </Select>
        </label>
        <label className="text-sm md:col-span-2">
          <span className="text-muted">Grund</span>
          <Input value={form.reason} onChange={event => { setForm({ ...form, reason: event.target.value }); setOperationId(createIdempotencyKey()); }} maxLength={180} placeholder="Mindestens 3 Zeichen" />
        </label>
      </div>
      <Button disabled={!valid || mutation.isPending} onClick={() => mutation.mutate()}>
        <Send className="h-3.5 w-3.5 mr-1" />{mutation.isPending ? 'Buche…' : 'Auszahlen'}
      </Button>
    </div>
  );
}
