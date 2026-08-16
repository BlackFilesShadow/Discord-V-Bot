import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Dices, RefreshCw, Trophy } from 'lucide-react';
import { api } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';

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

function fmt(value: string | null): string {
  if (value === null) return '—';
  try { return BigInt(value).toLocaleString('de-DE'); } catch { return value; }
}

function statusVariant(status: LotteryRound['status']): 'ok' | 'warn' | 'neutral' {
  if (status === 'ACTIVE') return 'ok';
  if (status === 'DRAWING' || status === 'REFUNDING') return 'warn';
  return 'neutral';
}

export function LotteryPanel({ guildId }: { guildId: string }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    channelId: '',
    ticketPrice: '',
    maxTicketsPerUser: '10',
    minParticipants: '2',
    endsAt: '',
  });
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const current = useQuery({
    queryKey: ['economy-lottery-current', guildId],
    queryFn: () => api.get<{ round: LotteryRound | null }>(`/api/v2/guilds/${guildId}/economy/lottery/current`),
    retry: false,
  });
  const history = useQuery({
    queryKey: ['economy-lottery-history', guildId],
    queryFn: () => api.get<{ rounds: LotteryRound[] }>(`/api/v2/guilds/${guildId}/economy/lottery/history?limit=10`),
    retry: false,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['economy-lottery-current', guildId] });
    void qc.invalidateQueries({ queryKey: ['economy-lottery-history', guildId] });
    void qc.invalidateQueries({ queryKey: ['economy-virtual-accounts', guildId] });
  };

  const create = useMutation({
    mutationFn: () => api.post<LotteryRound>(`/api/v2/guilds/${guildId}/economy/lottery/rounds`, {
      channelId: form.channelId.trim(),
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
    onError: (error: Error) => setMessage({ ok: false, text: error.message }),
  });

  const endNow = useMutation({
    mutationFn: (roundId: string) => api.post<LotteryRound>(`/api/v2/guilds/${guildId}/economy/lottery/${roundId}/end-now`, {}),
    onSuccess: round => {
      setMessage({ ok: true, text: `Runde ausgewertet: ${round.status}.` });
      invalidate();
    },
    onError: (error: Error) => setMessage({ ok: false, text: error.message }),
  });

  const active = current.data?.round ?? null;
  const futureTime = form.endsAt ? new Date(form.endsAt).getTime() > Date.now() : false;
  const formValid = /^\d{17,20}$/.test(form.channelId.trim())
    && /^\d+$/.test(form.ticketPrice) && BigInt(form.ticketPrice || '0') > 0n
    && Number.isInteger(Number(form.maxTicketsPerUser)) && Number(form.maxTicketsPerUser) >= 1 && Number(form.maxTicketsPerUser) <= 10_000
    && Number.isInteger(Number(form.minParticipants)) && Number(form.minParticipants) >= 2 && Number(form.minParticipants) <= 100_000
    && futureTime;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle><span className="inline-flex items-center gap-2"><Dices className="h-4 w-4" />Lotterie</span></CardTitle>
          <Button variant="ghost" size="sm" onClick={() => { void current.refetch(); void history.refetch(); }} disabled={current.isFetching || history.isFetching}>
            <RefreshCw className={`h-3.5 w-3.5 ${current.isFetching || history.isFetching ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </CardHeader>

      <p className="text-xs text-muted mb-4">
        Eine aktive Runde pro Gameserver. Der Pot ist ein gesperrtes LOTTERY_POT-Konto; Ziehung, Auszahlung und Refunds laufen idempotent über dieselbe Economy-Infrastruktur.
      </p>

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
            {active.status === 'ACTIVE' && (
              <Button variant="danger" size="sm" disabled={endNow.isPending} onClick={() => { setMessage(null); endNow.mutate(active.id); }}>
                {endNow.isPending ? 'Werte aus…' : 'Jetzt beenden'}
              </Button>
            )}
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted mb-5">Keine aktive oder noch zu verarbeitende Runde.</p>
      )}

      {!active && (
        <div className="rounded-lg border border-border/60 bg-bg/40 p-3 space-y-3 mb-5">
          <p className="text-sm font-medium text-white">Neue Runde starten</p>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-sm"><span className="text-muted">Discord-Channel-ID</span><Input value={form.channelId} onChange={e => setForm({ ...form, channelId: e.target.value.trim() })} inputMode="numeric" /></label>
            <label className="text-sm"><span className="text-muted">Ticketpreis</span><Input value={form.ticketPrice} onChange={e => setForm({ ...form, ticketPrice: e.target.value.trim() })} inputMode="numeric" /></label>
            <label className="text-sm"><span className="text-muted">Max. Tickets pro User</span><Input value={form.maxTicketsPerUser} onChange={e => setForm({ ...form, maxTicketsPerUser: e.target.value.trim() })} inputMode="numeric" /></label>
            <label className="text-sm"><span className="text-muted">Mindestteilnehmer</span><Input value={form.minParticipants} onChange={e => setForm({ ...form, minParticipants: e.target.value.trim() })} inputMode="numeric" /></label>
            <label className="text-sm md:col-span-2"><span className="text-muted">Endzeit</span><Input type="datetime-local" value={form.endsAt} onChange={e => setForm({ ...form, endsAt: e.target.value })} /></label>
          </div>
          <Button disabled={create.isPending || !formValid} onClick={() => { setMessage(null); create.mutate(); }}>
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

      {message && <p className={`mt-3 text-xs ${message.ok ? 'text-green-400' : 'text-danger'}`}>{message.text}</p>}
    </Card>
  );
}