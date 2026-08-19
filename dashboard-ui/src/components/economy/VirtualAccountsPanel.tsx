import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Banknote, History, Plus, RefreshCw, Send } from 'lucide-react';
import { api, createIdempotencyKey } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';

interface VirtualAccount {
  id: string;
  kind: 'CUSTOM' | 'LOTTERY_POT' | 'MARKET_VENDOR';
  name: string;
  description: string | null;
  channelId: string | null;
  balance: string;
  status: 'ACTIVE' | 'EXPIRED' | 'ARCHIVED';
  acceptUserTransfers: boolean;
  expiresAt: string | null;
  archivedAt: string | null;
  createdAt: string;
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

interface MemberOption {
  id: string;
  username: string;
  displayName: string;
  avatar: string | null;
  bot: boolean;
}

function fmtBig(value: string): string {
  try { return BigInt(value).toLocaleString('de-DE'); } catch { return value; }
}

function statusVariant(status: VirtualAccount['status']): 'ok' | 'warn' | 'neutral' {
  if (status === 'ACTIVE') return 'ok';
  if (status === 'EXPIRED') return 'warn';
  return 'neutral';
}

export function VirtualAccountsPanel({ guildId, slot }: { guildId: string; slot: string }) {
  const scope = `slot=${encodeURIComponent(slot)}`;
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [channelId, setChannelId] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [acceptUserTransfers, setAcceptUserTransfers] = useState(true);
  const [auditAccountId, setAuditAccountId] = useState<string>('');
  const [memberQuery, setMemberQuery] = useState('');
  const [selectedMember, setSelectedMember] = useState<ComboboxOption | null>(null);
  const [payout, setPayout] = useState({ accountId: '', userDiscordId: '', amount: '', targetPocket: 'WALLET', reason: '' });
  const [payoutOperationId, setPayoutOperationId] = useState(createIdempotencyKey);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const updatePayout = (patch: Partial<typeof payout>) => {
    setPayout(current => ({ ...current, ...patch }));
    setPayoutOperationId(createIdempotencyKey());
  };

  const accounts = useQuery({
    queryKey: ['economy-virtual-accounts', guildId, slot],
    queryFn: () => api.get<{ accounts: VirtualAccount[] }>(`/api/v2/guilds/${guildId}/economy/virtual-accounts?${scope}&includeArchived=true`),
    retry: false,
  });

  const channels = useQuery({
    queryKey: ['guild-channels', guildId],
    queryFn: () => api.get<{ channels: DiscordChannel[] }>(`/api/v2/guilds/${guildId}/channels`),
    retry: false,
  });
  const textChannels = useMemo(
    () => (channels.data?.channels ?? []).filter(channel => channel.type === 0 || channel.type === 5),
    [channels.data],
  );
  const channelNames = useMemo(() => new Map(textChannels.map(channel => [channel.id, channel.name] as const)), [textChannels]);

  const members = useQuery({
    queryKey: ['guild-members', guildId, memberQuery],
    queryFn: () => api.get<{ members: MemberOption[] }>(
      `/api/v2/guilds/${guildId}/members?limit=20${memberQuery ? `&q=${encodeURIComponent(memberQuery)}` : ''}`,
    ),
    placeholderData: previous => previous,
    retry: false,
  });
  const memberOptions = useMemo<ComboboxOption[]>(() => {
    const options = (members.data?.members ?? []).map(member => ({
      id: member.id,
      label: member.displayName || member.username,
      hint: member.id,
      avatar: member.avatar
        ? `https://cdn.discordapp.com/avatars/${member.id}/${member.avatar}.png?size=64`
        : `https://cdn.discordapp.com/embed/avatars/${(BigInt(member.id) >> 22n) % 6n}.png`,
      disabled: member.bot,
    }));
    // Server-side searches replace the option list. Keep the already selected
    // human visible until it is explicitly cleared or the payout succeeds;
    // otherwise the stable ID could remain booked while the picker looks empty.
    if (selectedMember && !options.some(option => option.id === selectedMember.id)) {
      options.unshift(selectedMember);
    }
    return options;
  }, [members.data?.members, selectedMember]);

  const create = useMutation({
    mutationFn: () => api.post<VirtualAccount>(`/api/v2/guilds/${guildId}/economy/virtual-accounts?${scope}`, {
      name: name.trim(),
      description: description.trim() || null,
      channelId: channelId || null,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      acceptUserTransfers,
    }),
    onSuccess: account => {
      setName('');
      setDescription('');
      setChannelId('');
      setExpiresAt('');
      setAcceptUserTransfers(true);
      setMessage({ ok: true, text: `Konto „${account.name}“ erstellt.` });
      void qc.invalidateQueries({ queryKey: ['economy-virtual-accounts', guildId, slot] });
    },
    onError: (error: Error) => setMessage({ ok: false, text: error.message }),
  });

  const archive = useMutation({
    mutationFn: (accountId: string) => api.post<VirtualAccount>(`/api/v2/guilds/${guildId}/economy/virtual-accounts/${accountId}/archive?${scope}`, {}),
    onSuccess: account => {
      setMessage({ ok: true, text: `Konto „${account.name}“ archiviert.` });
      void qc.invalidateQueries({ queryKey: ['economy-virtual-accounts', guildId, slot] });
    },
    onError: (error: Error) => setMessage({ ok: false, text: error.message }),
  });

  const payoutMutation = useMutation({
    mutationFn: () => api.post<{ ok: boolean; booked: boolean; account: VirtualAccount }>(
      `/api/v2/guilds/${guildId}/economy/virtual-accounts/${payout.accountId}/payout?${scope}`,
      {
        userDiscordId: payout.userDiscordId,
        amount: payout.amount.trim(),
        targetPocket: payout.targetPocket,
        reason: payout.reason.trim(),
        operationId: payoutOperationId,
      },
    ),
    onSuccess: result => {
      setMessage({ ok: true, text: result.booked ? 'Auszahlung atomar gebucht.' : 'Diese Auszahlung war bereits verarbeitet.' });
      setPayout({ accountId: '', userDiscordId: '', amount: '', targetPocket: 'WALLET', reason: '' });
      setMemberQuery('');
      setSelectedMember(null);
      setPayoutOperationId(createIdempotencyKey());
      void qc.invalidateQueries({ queryKey: ['economy-virtual-accounts', guildId, slot] });
      if (auditAccountId) void qc.invalidateQueries({ queryKey: ['economy-virtual-account-audit', guildId, slot, auditAccountId] });
    },
    onError: (error: Error) => setMessage({ ok: false, text: error.message }),
  });

  const audit = useQuery({
    queryKey: ['economy-virtual-account-audit', guildId, slot, auditAccountId],
    queryFn: () => api.get<{ entries: VirtualEntry[] }>(`/api/v2/guilds/${guildId}/economy/virtual-accounts/${auditAccountId}/entries?${scope}&limit=50`),
    enabled: auditAccountId.length > 0,
    retry: false,
  });

  const rows = accounts.data?.accounts ?? [];
  const payoutAccounts = useMemo(() => rows.filter(a => a.status !== 'ARCHIVED' && BigInt(a.balance) > 0n), [rows]);
  const nameValid = name.trim().length >= 1 && name.trim().length <= 80;
  const descriptionValid = description.length <= 280;
  const expiryValid = !expiresAt || Number.isFinite(new Date(expiresAt).getTime()) && new Date(expiresAt).getTime() > Date.now();
  const payoutValid = payout.accountId.length > 0 && /^\d{17,20}$/.test(payout.userDiscordId) && /^\d+$/.test(payout.amount) && BigInt(payout.amount || '0') > 0n && payout.reason.trim().length >= 3 && payout.reason.trim().length <= 180;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle><span className="inline-flex items-center gap-2"><Banknote className="h-4 w-4" />Virtuelle Konten</span></CardTitle>
          <Button variant="ghost" size="sm" onClick={() => accounts.refetch()} disabled={accounts.isFetching}>
            <RefreshCw className={`h-3.5 w-3.5 ${accounts.isFetching ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </CardHeader>

      <p className="text-xs text-muted mb-4">
        Servergebundene Zwischenkonten fuer Community-Zwecke. Jedes CUSTOM-Konto besitzt eine kanonische UUID, optional eine Beschreibung und einen validierten Discord-Zielchannel.
      </p>

      <div className="rounded-lg border border-border/60 bg-bg/40 p-3 space-y-3 mb-5">
        <p className="text-sm font-medium text-white inline-flex items-center gap-1.5"><Plus className="h-3.5 w-3.5" />Neues Konto</p>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="text-sm">
            <span className="text-muted">Kontoname</span>
            <Input value={name} onChange={e => setName(e.target.value)} maxLength={80} placeholder="z. B. Eventkasse" />
          </label>
          <label className="text-sm">
            <span className="text-muted">Discord-Channel (optional)</span>
            <Select value={channelId} onChange={e => setChannelId(e.target.value)} disabled={channels.isLoading || channels.isError}>
              <option value="">— kein Channel —</option>
              {textChannels.map(channel => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}
            </Select>
            {channels.isError && <span className="text-danger text-[11px]">Channels konnten nicht geladen werden.</span>}
          </label>
          <label className="text-sm md:col-span-2">
            <span className="text-muted">Beschreibung (optional, max. 280 Zeichen)</span>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              maxLength={280}
              rows={3}
              className="mt-1 w-full rounded-md border border-border bg-bg-elev px-3 py-2 text-sm text-white outline-none focus:border-primary"
              placeholder="Wofuer wird dieses Konto verwendet?"
            />
          </label>
          <label className="text-sm">
            <span className="text-muted">Ablauf (optional)</span>
            <Input type="datetime-local" value={expiresAt} onChange={e => setExpiresAt(e.target.value)} />
          </label>
        </div>
        <Switch checked={acceptUserTransfers} onChange={setAcceptUserTransfers} label="Direkte User-Ueberweisungen erlauben" />
        <Button disabled={create.isPending || accounts.isError || !nameValid || !descriptionValid || !expiryValid || channels.isError} onClick={() => { setMessage(null); create.mutate(); }}>
          {create.isPending ? 'Erstelle…' : 'Konto erstellen'}
        </Button>
      </div>

      {accounts.isLoading && <p className="text-muted text-sm">Lade Konten…</p>}
      {accounts.isError && <p className="text-danger text-sm">Virtuelle Konten konnten nicht geladen werden: {(accounts.error as Error).message}</p>}
      <div className="space-y-2">
        {rows.length === 0 && !accounts.isLoading && <p className="text-muted text-sm">Noch keine virtuellen Konten.</p>}
        {rows.map(account => (
          <div key={account.id} className="rounded-lg border border-border/60 bg-bg-elev/40 p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium text-white truncate">{account.name}</p>
                  <Badge variant={statusVariant(account.status)}>{account.status}</Badge>
                  <Badge variant="neutral">{account.kind}</Badge>
                </div>
                {account.description && <p className="text-xs text-muted mt-1 whitespace-pre-wrap">{account.description}</p>}
                <p className="text-lg font-semibold mt-1">{fmtBig(account.balance)}</p>
                <p className="text-[11px] text-muted mt-1">
                  User-Einzahlungen: {account.acceptUserTransfers && account.status === 'ACTIVE' ? 'offen' : 'gesperrt'}
                  {' · '}{account.expiresAt ? `Ablauf ${new Date(account.expiresAt).toLocaleString('de-DE')}` : 'ohne Ablauf'}
                  {account.channelId ? ` · Channel #${channelNames.get(account.channelId) ?? account.channelId}` : ' · kein Channel'}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="ghost" onClick={() => setAuditAccountId(auditAccountId === account.id ? '' : account.id)}>
                  <History className="h-3.5 w-3.5 mr-1" />Audit
                </Button>
                {account.status !== 'ARCHIVED' && (
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={archive.isPending || BigInt(account.balance) !== 0n}
                    onClick={() => { setMessage(null); archive.mutate(account.id); }}
                    title={BigInt(account.balance) !== 0n ? 'Nur Konten mit 0 Guthaben koennen archiviert werden.' : 'Konto archivieren'}
                  >
                    <Archive className="h-3.5 w-3.5 mr-1" />Archivieren
                  </Button>
                )}
              </div>
            </div>
            {auditAccountId === account.id && (
              <div className="mt-3 pt-3 border-t border-border/60">
                {audit.isLoading && <p className="text-xs text-muted">Lade Audit…</p>}
                {audit.isError && <p className="text-xs text-danger">Audit konnte nicht geladen werden: {(audit.error as Error).message}</p>}
                {audit.data?.entries.length === 0 && <p className="text-xs text-muted">Noch keine Buchungen.</p>}
                <div className="space-y-1 max-h-52 overflow-y-auto">
                  {audit.data?.entries.map(entry => (
                    <div key={entry.id} className="grid grid-cols-[auto,1fr,auto] gap-2 text-[11px] py-1 border-b border-border/30 last:border-0">
                      <span className={BigInt(entry.delta) >= 0n ? 'text-ok font-mono' : 'text-danger font-mono'}>
                        {BigInt(entry.delta) >= 0n ? '+' : ''}{fmtBig(entry.delta)}
                      </span>
                      <span className="text-muted truncate">{entry.entryType} · {entry.reason ?? 'ohne Grund'}</span>
                      <span className="text-muted/60">{new Date(entry.createdAt).toLocaleString('de-DE')}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="mt-5 pt-4 border-t border-border space-y-3">
        <p className="text-sm font-medium text-white inline-flex items-center gap-1.5"><Send className="h-3.5 w-3.5" />Kontrollierte Auszahlung / Refund</p>
        <p className="text-xs text-muted">Auch abgelaufene Konten koennen geleert werden. Der Empfaenger wird als Discord-Mitglied gesucht; intern wird ausschliesslich seine stabile Discord-ID gebucht.</p>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="text-sm">
            <span className="text-muted">Quellkonto</span>
            <Select value={payout.accountId} onChange={e => updatePayout({ accountId: e.target.value })}>
              <option value="">— Konto waehlen —</option>
              {payoutAccounts.map(account => <option key={account.id} value={account.id}>{account.name} · {fmtBig(account.balance)}</option>)}
            </Select>
          </label>
          <div className="text-sm">
            <span className="text-muted">Discord-Mitglied</span>
            <Combobox
              value={payout.userDiscordId || null}
              onChange={(id, option) => {
                updatePayout({ userDiscordId: id ?? '' });
                setSelectedMember(option);
              }}
              options={memberOptions}
              onSearch={setMemberQuery}
              loading={members.isFetching}
              placeholder="Mitglied suchen..."
              emptyText={memberQuery ? 'Keine Treffer.' : 'Tippe einen Namen...'}
            />
          </div>
          <label className="text-sm">
            <span className="text-muted">Betrag</span>
            <Input value={payout.amount} onChange={e => updatePayout({ amount: e.target.value.trim() })} inputMode="numeric" />
          </label>
          <label className="text-sm">
            <span className="text-muted">Ziel</span>
            <Select value={payout.targetPocket} onChange={e => updatePayout({ targetPocket: e.target.value })}>
              <option value="WALLET">Wallet</option>
              <option value="BANK">Bank</option>
            </Select>
          </label>
        </div>
        <label className="text-sm block">
          <span className="text-muted">Begruendung (3–180 Zeichen)</span>
          <Input value={payout.reason} onChange={e => updatePayout({ reason: e.target.value })} maxLength={180} placeholder="z. B. Event beendet / Refund" />
        </label>
        <Button disabled={payoutMutation.isPending || !payoutValid} onClick={() => { setMessage(null); payoutMutation.mutate(); }}>
          {payoutMutation.isPending ? 'Buche…' : 'Auszahlung buchen'}
        </Button>
      </div>

      {message && <p className={`mt-3 text-xs ${message.ok ? 'text-green-400' : 'text-danger'}`}>{message.text}</p>}
    </Card>
  );
}
