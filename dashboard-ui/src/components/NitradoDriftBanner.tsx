import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Ban, CheckCircle2, RefreshCw, ShieldCheck } from 'lucide-react';
import { api, describeApiError } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { Button } from '@/components/ui/Button';

interface WhitelistDriftItem {
  kind: 'WHITELIST';
  gameId: string;
  source: string;
  approvedAt: string;
  lastConfirmedRemoteAt: string | null;
  state: 'REMOTE_MISSING';
  canRestore: boolean;
}

interface BanDriftItem {
  kind: 'BAN';
  banId: string;
  identifier: string | null;
  identifierHint: string | null;
  reason: string | null;
  bannedAt: string;
  expiresAt: string | null;
  state: 'REMOTE_MISSING';
  canRestore: boolean;
}

interface DriftResponse<T> {
  observedAt: string;
  items: T[];
}

type DriftDecision = 'ACCEPT_NITRADO' | 'RESTORE_VBOT';
type ResolveTarget =
  | { kind: 'WHITELIST'; gameId: string; decision: DriftDecision; reason: string }
  | { kind: 'BAN'; banId: string; decision: DriftDecision; reason: string };
type ResolveTargetInput =
  | { kind: 'WHITELIST'; gameId: string; decision: DriftDecision }
  | { kind: 'BAN'; banId: string; decision: DriftDecision };

function confirmationReason(label: string, decision: DriftDecision): string | null {
  if (decision === 'ACCEPT_NITRADO') {
    return window.confirm(
      `${label}: Den aktuell auf Nitrado vorhandenen Zustand uebernehmen? `
      + 'Der lokale V-Bot-Sollzustand wird entsprechend entfernt bzw. aufgehoben.',
    ) ? 'Manuelle Nitrado-Abweichung bewusst uebernommen' : null;
  }

  const reason = window.prompt(
    `${label}: V-Bot-Zustand auf Nitrado wiederherstellen. Begruendung:`,
    'Manuelle Nitrado-Aenderung soll nicht bestehen bleiben',
  );
  if (reason === null) return null;
  const trimmed = reason.trim();
  if (trimmed.length < 3) return '';
  return trimmed;
}

function visibleError(error: unknown): ReturnType<typeof describeApiError> | null {
  if (!error) return null;
  const described = describeApiError(error);
  // 401 wird global vom AuthProvider verarbeitet; 403/404 sind erwartete
  // Permission-/Surface-Zustaende und sollen ebenfalls keinen Drift vortaeuschen.
  if (described.status === 401 || described.status === 403 || described.status === 404) return null;
  return described;
}

export function NitradoDriftBanner({ guildId, slot }: { guildId: string; slot: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const qs = `?slot=${encodeURIComponent(slot)}`;

  const whitelist = useQuery({
    queryKey: ['nitrado-drift', 'whitelist', guildId, slot],
    queryFn: () => api.get<DriftResponse<WhitelistDriftItem>>(`/api/v2/guilds/${guildId}/nitrado-drift/whitelist${qs}`),
    retry: false,
    refetchInterval: 60_000,
  });
  const bans = useQuery({
    queryKey: ['nitrado-drift', 'bans', guildId, slot],
    queryFn: () => api.get<DriftResponse<BanDriftItem>>(`/api/v2/guilds/${guildId}/nitrado-drift/bans${qs}`),
    retry: false,
    refetchInterval: 60_000,
  });

  const resolve = useMutation({
    mutationFn: (target: ResolveTarget) => {
      if (target.kind === 'WHITELIST') {
        return api.post(`/api/v2/guilds/${guildId}/nitrado-drift/whitelist/resolve${qs}`, {
          gameId: target.gameId,
          decision: target.decision,
          confirm: true,
          reason: target.reason,
        });
      }
      return api.post(`/api/v2/guilds/${guildId}/nitrado-drift/bans/resolve${qs}`, {
        banId: target.banId,
        decision: target.decision,
        confirm: true,
        reason: target.reason,
      });
    },
    onSuccess: (_res, target) => {
      void qc.invalidateQueries({ queryKey: ['nitrado-drift', 'whitelist', guildId, slot] });
      void qc.invalidateQueries({ queryKey: ['nitrado-drift', 'bans', guildId, slot] });
      void qc.invalidateQueries({ queryKey: ['whitelist', guildId, slot] });
      toast.push({
        variant: 'success',
        title: 'Abweichung aufgeloest',
        desc: target.decision === 'ACCEPT_NITRADO'
          ? 'Der aktuelle Nitrado-Zustand wurde als neue Wahrheit uebernommen.'
          : 'Der V-Bot-Zustand wurde zur kontrollierten Wiederherstellung eingereiht.',
      });
    },
    onError: error => {
      const described = describeApiError(error);
      toast.push({ variant: 'danger', title: described.title, desc: described.desc });
    },
  });

  const whitelistItems = whitelist.data?.items ?? [];
  const banItems = bans.data?.items ?? [];
  const total = whitelistItems.length + banItems.length;
  const rawErrors = [whitelist.error, bans.error].filter(Boolean);
  const hasAuthError = rawErrors.some(error => describeApiError(error).status === 401);

  // Eine fehlgeschlagene Authentifizierung ist KEIN Drift. Der zentrale API-
  // Client signalisiert den Session-Ablauf und Protected leitet zum Login um.
  if (hasAuthError) return null;

  const uniqueErrors = Array.from(new Map(
    rawErrors
      .map(visibleError)
      .filter((error): error is ReturnType<typeof describeApiError> => error !== null)
      .map(error => [`${error.status}:${error.code ?? ''}:${error.desc}`, error] as const),
  ).values());
  const hasDrift = total > 0;

  if (!hasDrift && uniqueErrors.length === 0) return null;

  const runDecision = (target: ResolveTargetInput, label: string) => {
    const reason = confirmationReason(label, target.decision);
    if (reason === null) return;
    if (reason.length < 3) {
      toast.push({ variant: 'danger', title: 'Begruendung erforderlich', desc: 'Bitte mindestens 3 Zeichen angeben.' });
      return;
    }
    resolve.mutate({ ...target, reason } as ResolveTarget);
  };

  return (
    <section
      className="mb-6 overflow-hidden rounded-xl border border-warn/45 bg-warn/[0.06] shadow-[0_16px_50px_-28px_rgba(0,0,0,0.85)]"
      aria-label={hasDrift ? 'Manuelle Nitrado-Abweichungen' : 'Nitrado-Driftpruefung fehlgeschlagen'}
      data-testid="nitrado-drift-banner"
    >
      <div className="flex flex-col gap-3 border-b border-warn/20 bg-warn/[0.05] px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex gap-3">
          <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-warn/35 bg-warn/10 text-warn">
            <AlertTriangle className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-white">
              {hasDrift ? 'Manuelle Nitrado-Abweichung erkannt' : 'Nitrado-Driftprüfung fehlgeschlagen'}
            </h2>
            <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted">
              {hasDrift
                ? 'V-Bot hatte diesen Zustand zuletzt auf Nitrado bestaetigt, Nitrado meldet ihn jetzt als entfernt. Die automatische Wiederherstellung ist pausiert, bis du dich bewusst fuer einen Zustand entscheidest.'
                : 'Die aktuelle Drift-Prüfung konnte nicht abgeschlossen werden. Es wurde keine Nitrado-Abweichung bestätigt.'}
            </p>
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          disabled={whitelist.isFetching || bans.isFetching || resolve.isPending}
          onClick={() => {
            void whitelist.refetch();
            void bans.refetch();
          }}
          aria-label="Nitrado-Abweichungen neu pruefen"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${(whitelist.isFetching || bans.isFetching) ? 'animate-spin' : ''}`} />
          Neu pruefen
        </Button>
      </div>

      <div className="space-y-3 p-4">
        {uniqueErrors.map(error => (
          <p key={`${error.status}:${error.code ?? ''}:${error.desc}`} className="text-xs text-danger" role="alert">
            Drift-Pruefung fehlgeschlagen: {error.desc}
          </p>
        ))}

        {whitelistItems.map(item => (
          <article key={`wl-${item.gameId}`} className="rounded-lg border border-border bg-bg-card/70 p-3 sm:p-4">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-warn" aria-hidden="true" />
                  <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-warn">Whitelist · Remote entfernt</span>
                </div>
                <p className="mt-1 break-all font-mono text-sm text-white">{item.gameId}</p>
                <p className="mt-1 text-xs text-muted">
                  Lokal weiterhin als freigeschaltet gespeichert{item.lastConfirmedRemoteAt
                    ? ` · zuletzt remote bestaetigt ${new Date(item.lastConfirmedRemoteAt).toLocaleString()}`
                    : ''}.
                </p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row xl:shrink-0">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={resolve.isPending}
                  onClick={() => runDecision({ kind: 'WHITELIST', gameId: item.gameId, decision: 'ACCEPT_NITRADO' }, `Whitelist ${item.gameId}`)}
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Nitrado-Zustand uebernehmen
                </Button>
                <Button
                  size="sm"
                  disabled={resolve.isPending || !item.canRestore}
                  onClick={() => runDecision({ kind: 'WHITELIST', gameId: item.gameId, decision: 'RESTORE_VBOT' }, `Whitelist ${item.gameId}`)}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  V-Bot-Zustand wiederherstellen
                </Button>
              </div>
            </div>
          </article>
        ))}

        {banItems.map(item => {
          const label = item.identifier ?? `Ban ${item.identifierHint ?? item.banId.slice(0, 8)}`;
          return (
            <article key={`ban-${item.banId}`} className="rounded-lg border border-border bg-bg-card/70 p-3 sm:p-4">
              <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Ban className="h-4 w-4 text-warn" aria-hidden="true" />
                    <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-warn">Banliste · Remote entfernt</span>
                  </div>
                  <p className="mt-1 break-all font-mono text-sm text-white">{label}</p>
                  <p className="mt-1 text-xs text-muted">
                    Lokal weiterhin als aktiver Ban gespeichert{item.reason ? ` · Grund: ${item.reason}` : ''}.
                    {!item.canRestore && ' Der verschluesselte Remote-Identifier fehlt; eine automatische Wiederherstellung ist deshalb gesperrt.'}
                  </p>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row xl:shrink-0">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={resolve.isPending}
                    onClick={() => runDecision({ kind: 'BAN', banId: item.banId, decision: 'ACCEPT_NITRADO' }, label)}
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Nitrado-Zustand uebernehmen
                  </Button>
                  <Button
                    size="sm"
                    disabled={resolve.isPending || !item.canRestore}
                    onClick={() => runDecision({ kind: 'BAN', banId: item.banId, decision: 'RESTORE_VBOT' }, label)}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    V-Bot-Zustand wiederherstellen
                  </Button>
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
