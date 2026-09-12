import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Inbox, Loader2, Lock, RefreshCw, Send, X } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Card, CardDesc, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';

type TicketStatus = 'PENDING' | 'OPEN' | 'DENIED' | 'CLOSED';

interface TicketSummary {
  id: string;
  ticketNumber: number;
  userDiscordId: string;
  username: string;
  subject: string;
  status: TicketStatus;
  createdAt: string;
  closedAt: string | null;
}

interface TicketMessage {
  id: string;
  fromDiscordId: string;
  fromRole: 'USER' | 'OWNER' | string;
  content: string;
  createdAt: string;
}

interface TicketDetail extends TicketSummary {
  guildId: string | null;
  guildName: string | null;
  initialMessage: string;
  ownerDiscordId: string;
  updatedAt: string;
  messages: TicketMessage[];
}

const STATUS_LABEL: Record<TicketStatus, string> = {
  PENDING: 'Wartend',
  OPEN: 'Offen',
  DENIED: 'Abgelehnt',
  CLOSED: 'Geschlossen',
};

function statusVariant(status: TicketStatus): 'ok' | 'warn' | 'danger' | 'neutral' {
  if (status === 'OPEN') return 'ok';
  if (status === 'PENDING') return 'warn';
  if (status === 'DENIED') return 'danger';
  return 'neutral';
}

function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : (error as Error)?.message ?? 'Aktion fehlgeschlagen.';
}

export function BotAdminOwnerTickets() {
  const toast = useToast();
  const qc = useQueryClient();
  const [status, setStatus] = useState<TicketStatus>('PENDING');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [denyReason, setDenyReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const listQ = useQuery({
    queryKey: ['bot-admin-owner-tickets', status],
    queryFn: () => api.get<{ items: TicketSummary[]; total: number }>(`/api/v2/bot-admin/tickets?status=${status}&pageSize=100`),
    retry: false,
  });
  const detailQ = useQuery({
    queryKey: ['bot-admin-owner-ticket', selectedId],
    queryFn: () => api.get<TicketDetail>(`/api/v2/bot-admin/tickets/${selectedId}`),
    enabled: Boolean(selectedId),
    retry: false,
  });

  const tickets = listQ.data?.items ?? [];
  const ticket = detailQ.data ?? null;

  async function refreshAll() {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['bot-admin-owner-tickets'] }),
      selectedId ? qc.invalidateQueries({ queryKey: ['bot-admin-owner-ticket', selectedId] }) : Promise.resolve(),
    ]);
  }

  function changeStatus(next: TicketStatus) {
    setStatus(next);
    setSelectedId(null);
    setReplyText('');
    setDenyReason('');
  }

  async function accept() {
    if (!ticket) return;
    setBusy('accept');
    try {
      await api.post(`/api/v2/bot-admin/tickets/${ticket.id}/accept`, {});
      toast.success(`Ticket #${ticket.ticketNumber} angenommen.`);
      setStatus('OPEN');
      await refreshAll();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function deny() {
    if (!ticket) return;
    setBusy('deny');
    try {
      await api.post(`/api/v2/bot-admin/tickets/${ticket.id}/deny`, { reason: denyReason.trim() || undefined });
      toast.success(`Ticket #${ticket.ticketNumber} abgelehnt.`);
      setDenyReason('');
      setStatus('DENIED');
      await refreshAll();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function closeTicket() {
    if (!ticket) return;
    setBusy('close');
    try {
      await api.post(`/api/v2/bot-admin/tickets/${ticket.id}/close`, {});
      toast.success(`Ticket #${ticket.ticketNumber} geschlossen.`);
      setStatus('CLOSED');
      await refreshAll();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function reply() {
    if (!ticket) return;
    const content = replyText.trim();
    if (!content) return;
    setBusy('reply');
    try {
      await api.post(`/api/v2/bot-admin/tickets/${ticket.id}/reply`, { content });
      setReplyText('');
      toast.success('Antwort gesendet.');
      await refreshAll();
    } catch (error) {
      // Bei 502 ist die Nachricht laut Backend bereits im Ticket protokolliert,
      // nur die Discord-DM konnte nicht zugestellt werden. Verlauf deshalb neu laden.
      if (error instanceof ApiError && error.status === 502) {
        toast.warn(error.message);
        await refreshAll();
      } else {
        toast.error(errorMessage(error));
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[360px_1fr]">
      <Card glow className="min-w-0">
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <CardTitle>Owner-Ticket-Inbox</CardTitle>
              <CardDesc>Direkter Supportkanal zwischen V-Bot-Nutzern und Bot-Owner.</CardDesc>
            </div>
            <Button size="sm" variant="ghost" onClick={() => void listQ.refetch()} disabled={listQ.isFetching} aria-label="Tickets aktualisieren">
              {listQ.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </Button>
          </div>
        </CardHeader>

        <Select value={status} onChange={e => changeStatus(e.target.value as TicketStatus)} className="mb-3">
          <option value="PENDING">Wartend</option>
          <option value="OPEN">Offen</option>
          <option value="DENIED">Abgelehnt</option>
          <option value="CLOSED">Geschlossen</option>
        </Select>

        {listQ.isError && <p className="text-sm text-danger break-words">{errorMessage(listQ.error)}</p>}
        {listQ.isLoading && <div className="h-32 rounded-xl skeleton" />}
        {!listQ.isLoading && !listQ.isError && tickets.length === 0 && (
          <EmptyState icon={Inbox} title={`Keine Tickets · ${STATUS_LABEL[status]}`} />
        )}

        <div className="space-y-2">
          {tickets.map(item => (
            <button
              type="button"
              key={item.id}
              onClick={() => { setSelectedId(item.id); setReplyText(''); setDenyReason(''); }}
              className={`w-full rounded-lg border p-3 text-left transition-colors ${selectedId === item.id ? 'border-accent/60 bg-accent/10' : 'border-border bg-bg-elev hover:border-accent/30'}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs text-muted">#{item.ticketNumber}</span>
                <Badge variant={statusVariant(item.status)}>{STATUS_LABEL[item.status]}</Badge>
              </div>
              <p className="mt-1 truncate text-sm font-semibold text-white">{item.subject}</p>
              <p className="mt-1 truncate text-xs text-muted">{item.username} · {new Date(item.createdAt).toLocaleString('de-DE')}</p>
            </button>
          ))}
        </div>
      </Card>

      <Card glow className="min-w-0">
        {!selectedId ? (
          <EmptyState icon={Inbox} title="Ticket auswählen" desc="Links ein Ticket wählen, um Inhalt, Verlauf und Owner-Aktionen zu sehen." />
        ) : detailQ.isLoading ? (
          <div className="h-56 rounded-xl skeleton" />
        ) : detailQ.isError ? (
          <p className="text-sm text-danger break-words">{errorMessage(detailQ.error)}</p>
        ) : ticket ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-muted">Ticket #{ticket.ticketNumber}</span>
                  <Badge variant={statusVariant(ticket.status)}>{STATUS_LABEL[ticket.status]}</Badge>
                </div>
                <h2 className="mt-1 break-words text-lg font-semibold text-white">{ticket.subject}</h2>
                <p className="mt-1 text-xs text-muted break-words">
                  {ticket.username} · <span className="font-mono">{ticket.userDiscordId}</span>
                  {ticket.guildName ? ` · ${ticket.guildName}` : ' · DM'}
                </p>
              </div>
              {(ticket.status === 'PENDING' || ticket.status === 'OPEN') && (
                <Button size="sm" variant="ghost" onClick={() => void closeTicket()} loading={busy === 'close'} disabled={busy !== null && busy !== 'close'}>
                  <Lock className="h-4 w-4" />Schließen
                </Button>
              )}
            </div>

            <div className="rounded-lg border border-border bg-bg-elev p-3">
              <p className="mb-1 text-xs font-medium text-muted">Erste Anfrage</p>
              <p className="whitespace-pre-wrap break-words text-sm text-white">{ticket.initialMessage}</p>
            </div>

            {ticket.status === 'PENDING' && (
              <div className="rounded-lg border border-border p-3 space-y-3">
                <div>
                  <p className="text-sm font-medium text-white">Owner-Entscheidung</p>
                  <p className="text-xs text-muted">Akzeptieren öffnet den bestehenden DM-Relay. Ablehnen beendet das Ticket.</p>
                </div>
                <textarea
                  value={denyReason}
                  onChange={e => setDenyReason(e.target.value)}
                  maxLength={1000}
                  rows={3}
                  placeholder="Ablehnungsgrund (optional)"
                  className="input-premium w-full rounded-lg px-3.5 py-2.5 text-sm text-white placeholder:text-muted/80 focus:outline-none resize-y"
                />
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => void accept()} loading={busy === 'accept'} disabled={busy !== null && busy !== 'accept'}>
                    <Check className="h-4 w-4" />Akzeptieren
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => void deny()} loading={busy === 'deny'} disabled={busy !== null && busy !== 'deny'}>
                    <X className="h-4 w-4" />Ablehnen
                  </Button>
                </div>
              </div>
            )}

            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-white">Verlauf</h3>
                <span className="text-xs text-muted">{ticket.messages.length} Nachricht(en)</span>
              </div>
              {ticket.messages.length === 0 ? (
                <p className="rounded-lg border border-border bg-bg-elev p-3 text-xs text-muted">Noch keine Relay-Nachrichten.</p>
              ) : (
                <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
                  {ticket.messages.map(message => (
                    <div key={message.id} className="rounded-lg border border-border bg-bg-elev p-3">
                      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                        <Badge variant={message.fromRole === 'OWNER' ? 'info' : 'neutral'}>{message.fromRole === 'OWNER' ? 'Owner' : 'User'}</Badge>
                        <span className="text-[11px] text-muted">{new Date(message.createdAt).toLocaleString('de-DE')}</span>
                      </div>
                      <p className="whitespace-pre-wrap break-words text-sm text-white">{message.content}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {ticket.status === 'OPEN' && (
              <div className="rounded-lg border border-accent/30 bg-accent/5 p-3 space-y-2">
                <p className="text-sm font-medium text-white">Als Owner antworten</p>
                <textarea
                  value={replyText}
                  onChange={e => setReplyText(e.target.value)}
                  maxLength={1800}
                  rows={4}
                  placeholder="Antwort an den Nutzer…"
                  className="input-premium w-full rounded-lg px-3.5 py-2.5 text-sm text-white placeholder:text-muted/80 focus:outline-none resize-y"
                />
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-muted">{replyText.length}/1800</span>
                  <Button size="sm" onClick={() => void reply()} loading={busy === 'reply'} disabled={!replyText.trim() || busy !== null && busy !== 'reply'}>
                    <Send className="h-4 w-4" />Antwort senden
                  </Button>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </Card>
    </div>
  );
}
