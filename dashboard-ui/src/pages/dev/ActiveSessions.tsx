/**
 * Active DEV Sessions — P1 Lifecycle-Konsole.
 *
 * Listet alle aktiven DevSessions (eigene + andere DEVELOPER) und erlaubt
 * Force-Revoke mit Step-Up (Reason + Re-Auth).
 *
 * Backend:
 *   GET  /api/v2/dev/sessions
 *   POST /api/v2/dev/sessions/:id/revoke   { reason, reAuth }
 */
import { useEffect, useMemo, useState, useCallback } from 'react';
import { ShieldOff, Clock, RefreshCw, User as UserIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { DataTable, type Column } from '@/components/ui/Table';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { StepUpModal, type StepUpRequest } from '@/components/ui/StepUpModal';

interface ActiveSessionRow {
  id: string;
  userDiscordId: string;
  createdAt: string;
  expiresAt: string;
  scope: Record<string, unknown> | null;
  remainingMs: number;
  totalLifetimeMs: number;
}

interface ListResponse { sessions: ActiveSessionRow[] }

function fmtDuration(ms: number): string {
  if (ms <= 0) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export default function ActiveSessions() {
  const [rows, setRows] = useState<ActiveSessionRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [stepUp, setStepUp] = useState<{ session: ActiveSessionRow; req: StepUpRequest } | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get<ListResponse>('/api/v2/dev/sessions');
      setRows(r.sessions);
    } catch (e) {
      toast.push({ variant: 'danger', title: 'Fehler', desc: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void reload(); }, [reload]);

  const onRequestRevoke = useCallback((session: ActiveSessionRow): void => {
    setStepUp({
      session,
      req: {
        action: 'dev.session.forceRevoke',
        title: 'DEV-Session zwangsweise beenden',
        description: `Diese Aktion beendet die DevSession ${session.id.slice(0, 8)}… von Discord-User ${session.userDiscordId} sofort. Der betroffene User muss sich neu authentifizieren (Passwort + 2FA).`,
        severity: 'danger',
        diff: { sessionId: session.id, targetUserDiscordId: session.userDiscordId, remainingMs: session.remainingMs },
      },
    });
  }, []);

  const onConfirmRevoke = async ({ reason, reAuth }: { reason: string; reAuth: string }): Promise<void> => {
    if (!stepUp) return;
    setBusy(true);
    try {
      await api.post(`/api/v2/dev/sessions/${encodeURIComponent(stepUp.session.id)}/revoke`, { reason, reAuth });
      toast.push({ variant: 'success', title: 'Session beendet', desc: `Session ${stepUp.session.id.slice(0, 8)}… revoked.` });
      setStepUp(null);
      await reload();
    } catch (e) {
      toast.push({ variant: 'danger', title: 'Force-Revoke fehlgeschlagen', desc: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const columns = useMemo<ReadonlyArray<Column<ActiveSessionRow>>>(() => [
    {
      id: 'user',
      header: 'User (Discord-ID)',
      cell: r => (<><UserIcon className="h-3.5 w-3.5 inline mr-1 text-muted" />{r.userDiscordId}</>),
      sortFn: (a, b) => a.userDiscordId.localeCompare(b.userDiscordId),
    },
    {
      id: 'session',
      header: 'Session',
      cell: r => <span className="font-mono text-xs">{r.id.slice(0, 12)}…</span>,
    },
    {
      id: 'createdAt',
      header: 'Erstellt',
      cell: r => <span className="text-xs text-muted">{new Date(r.createdAt).toLocaleString()}</span>,
      sortFn: (a, b) => a.createdAt.localeCompare(b.createdAt),
    },
    {
      id: 'expiresAt',
      header: 'Läuft ab',
      cell: r => <span className="text-xs text-muted">{new Date(r.expiresAt).toLocaleString()}</span>,
      sortFn: (a, b) => a.expiresAt.localeCompare(b.expiresAt),
    },
    {
      id: 'remaining',
      header: 'Restlaufzeit',
      cell: r => (
        <Badge variant={r.remainingMs < 5 * 60 * 1000 ? 'warn' : 'neutral'}>
          <Clock className="h-3 w-3 inline mr-1" />{fmtDuration(r.remainingMs)}
        </Badge>
      ),
      sortFn: (a, b) => a.remainingMs - b.remainingMs,
      numeric: true,
    },
    {
      id: 'action',
      header: '',
      cell: r => (
        <Button size="sm" variant="danger" onClick={() => onRequestRevoke(r)}>
          <ShieldOff className="h-3.5 w-3.5 mr-1" /> Force-Revoke
        </Button>
      ),
    },
  ], [onRequestRevoke]);

  return (
    <div className="space-y-gutter">
      <SectionHeader
        title="Aktive DEV-Sessions"
        desc="Lifecycle-Konsole für Force-Revoke (P1)."
        actions={(
          <Button size="sm" variant="ghost" onClick={() => void reload()} disabled={loading}>
            <RefreshCw className="h-4 w-4 mr-1" /> Aktualisieren
          </Button>
        )}
      />

      <Card>
        <CardHeader>
          <CardTitle>Sessions</CardTitle>
          <CardDesc>
            Auto-Extension verlängert binnen 15min Restlauf um 30min, gedeckelt auf 4h Gesamtlebensdauer.
            Force-Revoke schreibt einen SECURITY-Audit-Eintrag.
          </CardDesc>
        </CardHeader>
        {loading && rows === null ? (
          <div className="space-y-2 px-4 pb-4">
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
          </div>
        ) : (
          <DataTable
            columns={columns}
            rows={rows ?? []}
            rowKey={r => r.id}
            defaultSort={{ id: 'remaining', dir: 'asc' }}
            empty={(
              <EmptyState
                icon={ShieldOff}
                title="Keine aktiven Sessions"
                desc="Aktuell ist keine DEV-Session offen."
              />
            )}
          />
        )}
      </Card>

      <StepUpModal
        open={!!stepUp}
        onClose={() => !busy && setStepUp(null)}
        request={stepUp?.req ?? null}
        onConfirm={onConfirmRevoke}
        loading={busy}
      />
    </div>
  );
}
