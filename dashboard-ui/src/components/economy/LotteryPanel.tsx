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

const MAX_TICKET_PRICE = 1_000_000_000_000n;
const MIN_END_DELAY_MS = 60_000;
const MAX_END_DELAY_MS = 30 * 24 * 60 * 60 * 1000;

function fmt(value: string | null): string {
  if (value === null) return '—';
  try { return BigInt(value).toLocaleString('de-DE'); } catch { return value; }
}

function statusVariant(status: LotteryRound['status']): 'ok' | 'warn' | 'neutral' {
  if (status === 'ACTIVE') return 'ok';
  if (status === 'DRAWING' || status === 'REFUNDING') return 'warn';
  return 'neutral';
}

export function LotteryPanel({ guildId, slot }: { guildId: string; slot: string }) {
  const scope = `slot=${encodeURIComponent(slot)}`;
  const qc = useQueryClient();
  const [form, setForm] = useState({
    channelId: '',
    ticketPrice: '',
    maxTicketsPerUser: '10',
    minParticipants: '2',
    endsAt: '',
  });
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  // Derselbe Query-Key wie ServerSlot: keine zweite Berechtigungswahrheit.
  const dashboardMeta = useQuery({
    queryKey: ['dashboard-slot-meta', guildId, slot],
    queryFn: () => api.get<DashboardMeta>(`/api/v2/guilds/${guildId}/dashboard`),
    retry: false,
  });
  const canManage = Boolean(
    dashboardMeta.data?.isOwner || dashboardMeta.data?.permissions.includes('economy.manage'),
  );

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
    mutationFn: () => api.post<LotteryRound>(`/api/v2/guilds/${guildId}/economy/lottery/rounds?${scope}`, {
      channelId: form.channelId,
      ticketPrice: form.ticketPrice.trim(),
      maxTicketsPerUser: Number(form.maxTicketsPerUser),
      minParticipants: Number(form.minParticipants),
      endsAt: new Date(form.endsAt).toISOString(),
    }),
    onSuccess: round => {
      setMessage({ ok: true, text: `Lotterie gestartet. Runde ${round.id.slice(0, 8)}…` });
      setForm({ channelId: '', ticketPrice: '', maxTicketsPerUser: '10', minParticipants: '2', endsAt: '' });
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
  const endsAtMs = form.endsAt ? new Date(form.endsAt).getTime() : Number.NaN;
  const endDelayMs = endsAtMs - Date.now();
  const channelValid = textChannels.some(channel => channel.id === form.channelId);
  const ticketValid = /^\d+$/.test(form.ticketPrice)
    && BigInt(form.ticketPrice || '0') >= 1n
    && BigInt(form.ticketPrice || '0') <= MAX_TICKET_PRICE;
  const formValid = channelValid
    && ticketValid
    && Number.isInteger(Number(form.maxTicketsPerUser)) && Number(form.maxTicketsPerUser) >= 1 && Number(form.maxTicketsPerUser) <= 10_000
    && Number.isInteger(Number(form.minParticipants)) && Number(form.minParticipants) >= 2 && Number(form.minParticipants) <= 100_000
    && Number.isFinite(endsAtMs) && endDelayMs >= MIN_END_DELAY_MS && endDelayMs <= MAX_END_DELAY_MS;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle><span className="inline-flex items-center gap-2"><Dices className="h-4 w-4" />Lotterie</span></CardTitle>
          <Button variant="ghost" size="sm" onClick={() => { void current.refetch(); void history.refetch(); }} disabled={current.isFetching || history.isFetching} aria-label="Lotterie aktualisieren">
            <RefreshCw className={`h-3.5 w-3.5 ${current.isFetching || history.isFetching ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </CardHeader>

      <p className="text-xs text-muted mb-4">
        Eine aktive Runde pro Gameserver. Der Pot ist ein gesperrtes LOTTERY_POT-Konto; Ziehung, Auszahlung und Refunds laufen idempotent über dieselbe Economy-Infrastruktur.
      </p>
      {current.isError && <p className="text-danger text-sm mb-2">Aktuelle Lotterie konnte nicht geladen werden: {(current.error as Error).message}</p>}
      {history.isError && <p className="text-danger text-sm mb-2">Lotterie-Historie konnte nicht geladen werden: {(history.error as Error).message}</p>}

      {active ? (
        <div className="rounded-lg border border-border/60 bg-bg-elev/40 p-3 mb-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <p className="font-medium text-white">Aktuelle Runde</p>
                <Badge variant={statusVariant(active.status)}>{active.status}</Badge>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-2 mt-3 text-xs">
                <div><span className="text-muted block">Pot</span><strong>{fmt(active.potBalance)}</strong></div>
                <div><span className="text-muted block">Ticketpreis</span><strong>{fmt(active.ticketPrice)}</strong></div>
                <div><span className="text-muted block">Teilnehmer</span><strong>{active.participantCount} / {active.minParticipants}</strong></div>
                <div><span className="text-muted block">Tickets</span><strong>{active.totalTickets}</strong></div>
                <div className="col-span-2"><span className="text-muted block">Ende</span><strong>{new Date(active.endsAt).toLocaleString('de-DE')}</strong></div>
                <div className="col-span-2"><span className="text-muted block">Channel</span><strong>{active.channelId}</strong></div>
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
            <label className="text-sm">
              <span className="text-muted">Discord-Channel</span>
              <Select value={form.channelId} onChange={e => setForm({ ...form, channelId: e.target.value })} disabled={channels.isLoading || channels.isError}>
                <option value="">— Channel waehlen —</option>
                {textChannels.map(channel => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}
              </Select>
            </label>
            <label className="text-sm"><span className="text-muted">Ticketpreis</span><Input value={form.ticketPrice} onChange={e => setForm({ ...form, ticketPrice: e.target.value.trim() })} inputMode="numeric" /></label>
            <label className="text-sm"><span className="text-muted">Max. Tickets pro User</span><Input value={form.maxTicketsPerUser} onChange={e => setForm({ ...form, maxTicketsPerUser: e.target.value.trim() })} inputMode="numeric" /></label>
            <label className="text-sm"><span className="text-muted">Mindestteilnehmer</span><Input value={form.minParticipants} onChange={e => setForm({ ...form, minParticipants: e.target.value.trim() })} inputMode="numeric" /></label>
            <label className="text-sm md:col-span-2"><span className="text-muted">Endzeit (1 Minute bis 30 Tage)</span><Input type="datetime-local" value={form.endsAt} onChange={e => setForm({ ...form, endsAt: e.target.value })} /></label>
          </div>
          <Button disabled={create.isPending || current.isError || history.isError || channels.isLoading || channels.isError || !formValid} onClick={() => { setMessage(null); create.mutate(); }}>
            {create.isPending ? 'Starte…' : 'Lotterie starten'}
          </Button>
        </div>
      )}

      <div className="pt-4 border-t border-border">
        <p className="text-sm font-medium text-white inline-flex items-center gap-1.5 mb-2"><Trophy className="h-3.5 w-3.5" />Letzte Runden</p>
        <div className="space-y-1.5">
          {(history.data?.rounds ?? []).map(round => (
            <div key={round.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/40 px-2.5 py-2 text-xs">
              <div className="flex items-center gap-2"><Badge variant={statusVariant(round.status)}>{round.status}</Badge><span className="text-muted">{new Date(round.createdAt).toLocaleString('de-DE')}</span></div>
              <div className="text-right"><strong>{fmt(round.finalPot ?? round.potBalance)}</strong><span className="text-muted"> · {round.participantCount} Teilnehmer</span></div>
            </div>
          ))}
          {(history.data?.rounds ?? []).length === 0 && <p className="text-xs text-muted">Noch keine Lotterie-Historie.</p>}
        </div>
      </div>

      {message && <p className={`mt-3 text-xs ${message.ok ? 'text-ok' : 'text-danger'}`}>{message.text}</p>}
    </Card>
  );
}
