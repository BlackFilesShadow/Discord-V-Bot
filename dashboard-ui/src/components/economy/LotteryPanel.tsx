import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Dices, RefreshCw, Trophy } from 'lucide-react';
import { api } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';

interface LotteryRound {
  id: string;
  potAccountId: string;
  channelId: string;
  messageId: string | null;
  prizeText: string | null;
  activePrizeText: string | null;
  prizeSnapshot: string | null;
  ticketPrice: string;
  maxTicketsPerUser: number;
  minParticipants: number;
  status: 'ACTIVE' | 'DRAWING' | 'REFUNDING' | 'FINISHED' | 'REFUNDED';
  endsAt: string;
  winnerDiscordId: string | null;
  winningTicketNumber: number | null;
  participantCount: number;
  totalTickets: number;
  finalPot: string | null;
  potBalance: string;
  createdAt: string;
}

interface DashboardMeta {
  isOwner: boolean;
  permissions: string[];
}

interface ChannelOption {
  id: string;
  name: string;
  type: number;
  parentId: string | null;
}

interface EconomyCurrency {
  currencyName: string;
  emoji: string;
}

interface LotteryForm {
  channelId: string;
  prizeText: string;
  ticketPrice: string;
  maxTicketsPerUser: string;
  minParticipants: string;
  endsAt: string;
}

const MAX_TICKET_PRICE = 1_000_000_000_000n;
const MIN_END_DELAY_MS = 60_000;
const MAX_END_DELAY_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_END_DELAY_MS = 60 * 60 * 1000;

function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code !== undefined && (code < 0x20 || code === 0x7f)) return true;
  }
  return false;
}

function fmt(value: string | null): string {
  if (value === null) return '—';
  try { return BigInt(value).toLocaleString('de-DE'); } catch { return value; }
}

function money(value: string | null, emoji: string): string {
  return `${fmt(value)} ${emoji}`.trim();
}

function statusVariant(status: LotteryRound['status']): 'ok' | 'warn' | 'neutral' {
  if (status === 'ACTIVE') return 'ok';
  if (status === 'DRAWING' || status === 'REFUNDING') return 'warn';
  return 'neutral';
}

function localDateTimeValue(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function roundUpToMinute(date: Date): Date {
  return new Date(Math.ceil(date.getTime() / 60_000) * 60_000);
}

function earliestEndTimestamp(now = Date.now()): number {
  // datetime-local has minute precision. Rounding upward after adding the
  // backend minimum keeps a real >=60s buffer even when the current minute is
  // already nearly over.
  return roundUpToMinute(new Date(now + MIN_END_DELAY_MS)).getTime();
}

function defaultLotteryEndLocal(): string {
  return localDateTimeValue(roundUpToMinute(new Date(Date.now() + DEFAULT_END_DELAY_MS)));
}

function emptyLotteryForm(): LotteryForm {
  return {
    channelId: '',
    prizeText: '',
    ticketPrice: '',
    maxTicketsPerUser: '10',
    minParticipants: '2',
    endsAt: defaultLotteryEndLocal(),
  };
}

function validateLotteryForm(form: LotteryForm, textChannels: ChannelOption[], now = Date.now()): string | null {
  const channelValid = textChannels.some(channel => channel.id === form.channelId);
  if (!channelValid) return 'Bitte einen gültigen Discord-Channel auswählen.';
  const prize = form.prizeText.trim();
  if (prize.length < 1 || prize.length > 256 || hasControlChars(prize)) return 'Gewinn muss 1–256 gültige Zeichen enthalten.';
  if (!/^\d+$/.test(form.ticketPrice)) return 'Ticketpreis muss eine positive ganze Zahl sein.';
  const ticketPrice = BigInt(form.ticketPrice || '0');
  const ticketValid = ticketPrice >= 1n && ticketPrice <= MAX_TICKET_PRICE;
  if (!ticketValid) return 'Ticketpreis liegt außerhalb des erlaubten Bereichs.';
  const maxTickets = Number(form.maxTicketsPerUser);
  if (!Number.isInteger(maxTickets) || maxTickets < 1 || maxTickets > 10_000) return 'Max. Tickets pro User muss zwischen 1 und 10.000 liegen.';
  const minParticipants = Number(form.minParticipants);
  if (!Number.isInteger(minParticipants) || minParticipants < 2 || minParticipants > 100_000) return 'Mindestteilnehmer muss zwischen 2 und 100.000 liegen.';
  const endsAtMs = form.endsAt ? new Date(form.endsAt).getTime() : Number.NaN;
  if (!Number.isFinite(endsAtMs)) return 'Bitte eine gültige Endzeit auswählen.';
  const delay = endsAtMs - now;
  if (delay < MIN_END_DELAY_MS) return 'Endzeit muss mindestens 1 Minute in der Zukunft liegen.';
  if (delay > MAX_END_DELAY_MS) return 'Endzeit darf maximal 30 Tage in der Zukunft liegen.';
  return null;
}

export function LotteryPanel({ guildId, slot }: { guildId: string; slot: string }) {
  const scope = `slot=${encodeURIComponent(slot)}`;
  const qc = useQueryClient();
  const [form, setForm] = useState<LotteryForm>(() => emptyLotteryForm());
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const dashboardMeta = useQuery({
    queryKey: ['dashboard-slot-meta', guildId, slot],
    queryFn: () => api.get<DashboardMeta>(`/api/v2/guilds/${guildId}/dashboard`),
    retry: false,
  });
  const canManage = Boolean(
    dashboardMeta.data?.isOwner || dashboardMeta.data?.permissions.includes('economy.manage'),
  );

  const currency = useQuery({
    queryKey: ['economy-config', guildId, slot],
    queryFn: () => api.get<EconomyCurrency>(`/api/v2/guilds/${guildId}/economy/config?${scope}`),
    retry: false,
  });
  const currencyEmoji = currency.data?.emoji ?? '🪙';
  const currencyName = currency.data?.currencyName ?? 'Währung';

  const channels = useQuery({
    queryKey: ['guild-channels', guildId],
    queryFn: () => api.get<{ channels: ChannelOption[] }>(`/api/v2/guilds/${guildId}/channels`),
    enabled: canManage,
    retry: false,
  });
  const textChannels = (channels.data?.channels ?? []).filter(channel => channel.type === 0 || channel.type === 5);

  const current = useQuery({
    queryKey: ['economy-lottery-current', guildId, slot],
    queryFn: () => api.get<{ round: LotteryRound | null }>(`/api/v2/guilds/${guildId}/economy/lottery/current?${scope}`),
    retry: false,
  });
  const history = useQuery({
    queryKey: ['economy-lottery-history', guildId, slot],
    queryFn: () => api.get<{ rounds: LotteryRound[] }>(`/api/v2/guilds/${guildId}/economy/lottery/history?${scope}&limit=10`),
    retry: false,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['economy-lottery-current', guildId, slot] });
    void qc.invalidateQueries({ queryKey: ['economy-lottery-history', guildId, slot] });
    void qc.invalidateQueries({ queryKey: ['economy-virtual-accounts', guildId, slot] });
    void qc.invalidateQueries({ queryKey: ['economy-overview', guildId, slot] });
  };

  const create = useMutation({
    mutationFn: () => {
      const validationError = validateLotteryForm(form, textChannels, Date.now());
      if (validationError) throw new Error(validationError);
      return api.post<LotteryRound>(`/api/v2/guilds/${guildId}/economy/lottery/rounds?${scope}`, {
        channelId: form.channelId,
        prizeText: form.prizeText.trim(),
        ticketPrice: form.ticketPrice.trim(),
        maxTicketsPerUser: Number(form.maxTicketsPerUser),
        minParticipants: Number(form.minParticipants),
        endsAt: new Date(form.endsAt).toISOString(),
      });
    },
    onSuccess: round => {
      setMessage({ ok: true, text: `Lotterie „${round.prizeText ?? 'Gewinn'}“ gestartet.` });
      setForm(emptyLotteryForm());
      invalidate();
    },
    onError: (error: Error) => setMessage({ ok: false, text: `Lotterie konnte nicht gestartet werden: ${error.message}` }),
  });

  const endNow = useMutation({
    mutationFn: (roundId: string) => api.post<LotteryRound>(`/api/v2/guilds/${guildId}/economy/lottery/${roundId}/end-now?${scope}`, {}),
    onSuccess: round => {
      setMessage({ ok: true, text: `Runde ausgewertet: ${round.status}.` });
      invalidate();
    },
    onError: (error: Error) => setMessage({ ok: false, text: `Lotterie konnte nicht beendet werden: ${error.message}` }),
  });

  const active = current.data?.round ?? null;
  const formValidation = validateLotteryForm(form, textChannels, Date.now());

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle><span className="inline-flex items-center gap-2"><Dices className="h-4 w-4" />Lotterie</span></CardTitle>
          <Button variant="ghost" size="sm" onClick={() => { void current.refetch(); void history.refetch(); void currency.refetch(); }} disabled={current.isFetching || history.isFetching} aria-label="Lotterie aktualisieren">
            <RefreshCw className={`h-3.5 w-3.5 ${current.isFetching || history.isFetching ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </CardHeader>

      <p className="text-xs text-muted mb-4">
        Der Gewinn ist freier Text und wird genau so angezeigt, wie du ihn eingibst — inklusive Emoji, z. B. „🚗 Fahrzeug nach Wahl“. Das aktive Gewinnfeld wird erst nach erfolgreichem Abschluss automatisch entfernt; die Historie behält den unveränderlichen Gewinn-Snapshot. Geldwerte verwenden automatisch {currencyName} {currencyEmoji}.
      </p>
      {current.isError && <p className="text-danger text-sm mb-2">Aktuelle Lotterie konnte nicht geladen werden: {(current.error as Error).message}</p>}
      {history.isError && <p className="text-danger text-sm mb-2">Lotterie-Historie konnte nicht geladen werden: {(history.error as Error).message}</p>}

      {active ? (
        <div className="rounded-lg border border-border/60 bg-bg-elev/40 p-3 mb-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="font-medium text-white">Aktuelle Runde</p>
                <Badge variant={statusVariant(active.status)}>{active.status}</Badge>
              </div>
              <div className="mt-3 rounded-md border border-border/40 bg-bg/30 px-3 py-2">
                <span className="text-muted text-xs block">Gewinn</span>
                <strong className="text-white break-words">{active.prizeText ?? active.activePrizeText ?? active.prizeSnapshot ?? '—'}</strong>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-2 mt-3 text-xs">
                <div><span className="text-muted block">Pot</span><strong>{money(active.potBalance, currencyEmoji)}</strong></div>
                <div><span className="text-muted block">Ticketpreis</span><strong>{money(active.ticketPrice, currencyEmoji)}</strong></div>
                <div><span className="text-muted block">Teilnehmer</span><strong>{active.participantCount} / {active.minParticipants}</strong></div>
                <div><span className="text-muted block">Tickets</span><strong>{active.totalTickets}</strong></div>
                <div className="col-span-2"><span className="text-muted block">Ende</span><strong>{new Date(active.endsAt).toLocaleString('de-DE')}</strong></div>
                <div className="col-span-2"><span className="text-muted block">Channel</span><strong className="break-all">{active.channelId}</strong></div>
              </div>
            </div>
            {active.status === 'ACTIVE' && canManage && (
              <Button variant="danger" size="sm" disabled={endNow.isPending} onClick={() => { setMessage(null); endNow.mutate(active.id); }}>
                {endNow.isPending ? 'Werte aus…' : 'Jetzt beenden'}
              </Button>
            )}
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted mb-5">Keine aktive oder noch zu verarbeitende Runde.</p>
      )}

      {!active && canManage && (
        <div className="rounded-lg border border-border/60 bg-bg/40 p-3 space-y-3 mb-5">
          <p className="text-sm font-medium text-white">Neue Runde starten</p>
          {channels.isError && (
            <p className="text-danger text-xs">Discord-Channels konnten nicht geladen werden. Eine neue Runde kann deshalb nicht sicher gestartet werden.</p>
          )}
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-sm md:col-span-2">
              <span className="text-muted">Gewinn</span>
              <Input value={form.prizeText} onChange={e => setForm({ ...form, prizeText: e.target.value })} maxLength={256} placeholder="z. B. 🔫 M4A1" />
            </label>
            <label className="text-sm">
              <span className="text-muted">Discord-Channel</span>
              <Select value={form.channelId} onChange={e => setForm({ ...form, channelId: e.target.value })} disabled={channels.isLoading || channels.isError}>
                <option value="">— Channel waehlen —</option>
                {textChannels.map(channel => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}
              </Select>
            </label>
            <label className="text-sm"><span className="text-muted">Ticketpreis in {currencyName} {currencyEmoji}</span><Input value={form.ticketPrice} onChange={e => setForm({ ...form, ticketPrice: e.target.value.trim() })} inputMode="numeric" /></label>
            <label className="text-sm"><span className="text-muted">Max. Tickets pro User</span><Input value={form.maxTicketsPerUser} onChange={e => setForm({ ...form, maxTicketsPerUser: e.target.value.trim() })} inputMode="numeric" /></label>
            <label className="text-sm"><span className="text-muted">Mindestteilnehmer</span><Input value={form.minParticipants} onChange={e => setForm({ ...form, minParticipants: e.target.value.trim() })} inputMode="numeric" /></label>
            <label className="text-sm md:col-span-2">
              <span className="text-muted">Endzeit (1 Minute bis 30 Tage)</span>
              <Input
                type="datetime-local"
                min={localDateTimeValue(new Date(earliestEndTimestamp()))}
                value={form.endsAt}
                onChange={e => setForm({ ...form, endsAt: e.target.value })}
              />
            </label>
          </div>
          {formValidation && <p className="text-xs text-danger" role="alert">{formValidation}</p>}
          <Button disabled={create.isPending || current.isError || history.isError || channels.isLoading || channels.isError || Boolean(formValidation)} onClick={() => { setMessage(null); create.mutate(); }}>
            {create.isPending ? 'Starte…' : 'Lotterie starten'}
          </Button>
        </div>
      )}

      <div className="pt-4 border-t border-border">
        <p className="text-sm font-medium text-white inline-flex items-center gap-1.5 mb-2"><Trophy className="h-3.5 w-3.5" />Letzte Runden</p>
        <div className="space-y-1.5">
          {(history.data?.rounds ?? []).map(round => (
            <div key={round.id} className="rounded-md border border-border/40 px-2.5 py-2 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2"><Badge variant={statusVariant(round.status)}>{round.status}</Badge><span className="text-muted">{new Date(round.createdAt).toLocaleString('de-DE')}</span></div>
                <div className="text-right"><strong>{money(round.finalPot ?? round.potBalance, currencyEmoji)}</strong><span className="text-muted"> · {round.participantCount} Teilnehmer</span></div>
              </div>
              <div className="mt-1 text-muted">Gewinn: <strong className="text-white break-words">{round.prizeSnapshot ?? round.prizeText ?? '—'}</strong>{round.winnerDiscordId ? <> · Gewinner <strong className="text-white">{round.winnerDiscordId}</strong></> : null}</div>
            </div>
          ))}
          {(history.data?.rounds ?? []).length === 0 && <p className="text-xs text-muted">Noch keine Lotterie-Historie.</p>}
        </div>
      </div>

      {message && <p className={`mt-3 text-xs ${message.ok ? 'text-ok' : 'text-danger'}`}>{message.text}</p>}
    </Card>
  );
}
