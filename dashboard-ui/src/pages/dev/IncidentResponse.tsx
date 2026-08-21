/**
 * P2 — Incident-Response-Konsole.
 *
 * Bietet nur Incident-Aktionen an, die das Backend explizit als operational
 * ausweist. Ein Audit-/In-Memory-State ohne realen Runtime-Side-Effect darf
 * niemals als funktionierende Notfallsteuerung dargestellt werden.
 *
 * Backend:
 *   GET  /api/v2/dev/incident/state
 *   POST /api/v2/dev/incident/activate
 *   POST /api/v2/dev/incident/deactivate
 *   POST /api/v2/dev/incident/oneshot
 */
import { useState } from 'react';
import {
  AlertOctagon, Power, RefreshCw, Wrench, Database, HardDriveDownload, Clock, Brain, ShieldOff, Languages,
} from 'lucide-react';
import { api } from '@/lib/api';
import { useDevStatus } from '@/lib/useDevStatus';
import { useToast } from '@/lib/toast';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { StepUpModal, type StepUpRequest } from '@/components/ui/StepUpModal';

type IncidentAction =
  | 'kill.ai' | 'kill.automod' | 'kill.translation'
  | 'provider.force' | 'maintenance'
  | 'cache.flush' | 'backup.trigger';

interface ToggleState {
  action: IncidentAction;
  active: true;
  activatedAt: string;
  expiresAt: string;
  reason: string;
  byUserId: string;
  byDiscordId: string;
  payload?: Record<string, string | number | boolean>;
}

interface LimitConfig { maxDurationMs: number; defaultMs: number; kind: 'toggle' | 'oneshot' }
interface StateResponse {
  ok: boolean;
  toggles: ToggleState[];
  limits: Record<IncidentAction, LimitConfig>;
  operationalActions?: IncidentAction[];
}

interface ActionMeta {
  action: IncidentAction;
  title: string;
  description: string;
  icon: typeof Power;
  severity: 'warn' | 'danger';
}

const TOGGLE_META: ActionMeta[] = [
  { action: 'kill.ai',          title: 'Kill-Switch AI',           description: 'Stoppt alle AI-Aufrufe (OpenAI/Gemini/Anthropic). Max-Dauer 1h.', icon: Brain,     severity: 'danger' },
  { action: 'kill.automod',     title: 'Kill-Switch Auto-Moderation', description: 'Pausiert Auto-Mod-Regeln. Max-Dauer 1h.',                       icon: ShieldOff, severity: 'danger' },
  { action: 'kill.translation', title: 'Kill-Switch Translation',  description: 'Stoppt automatische Uebersetzungen. Max-Dauer 1h.',               icon: Languages, severity: 'warn' },
  { action: 'provider.force',   title: 'AI-Provider Force-Switch', description: 'Erzwingt einen bestimmten Provider (z.B. fallback auf Gemini). Max 4h.', icon: Power, severity: 'warn' },
  { action: 'maintenance',      title: 'Wartungsmodus',            description: 'Deaktiviert User-Schreibrouten. Max-Dauer 4h.',                    icon: Wrench,    severity: 'danger' },
];

const ONESHOT_META: ActionMeta[] = [
  { action: 'cache.flush',    title: 'Cache flushen',          description: 'Loescht alle Cache-Layer (in-memory + Prisma-Query-Cache).',  icon: RefreshCw,        severity: 'warn' },
  { action: 'backup.trigger', title: 'Manuelles Backup',       description: 'Loest sofort einen ausserplanmaessigen DB-Backup-Job aus.',     icon: HardDriveDownload, severity: 'warn' },
];

function fmtRemaining(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return 'abgelaufen';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function newIdempotencyKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

interface PendingStepUp {
  meta: ActionMeta;
  kind: 'activate' | 'deactivate' | 'oneshot';
  request: StepUpRequest;
}

export default function IncidentResponse() {
  const { data: state, loading, reload } = useDevStatus<StateResponse>('/api/v2/dev/incident/state', 15_000);
  const [pending, setPending] = useState<PendingStepUp | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  // Fail closed for older/partial responses too: absence of an explicit backend
  // operational allowlist means that no emergency control may be rendered.
  const operationalActions = state?.operationalActions ?? [];
  const operationalToggleMeta = TOGGLE_META.filter(meta => operationalActions.includes(meta.action));
  const operationalOneShotMeta = ONESHOT_META.filter(meta => operationalActions.includes(meta.action));
  const operationalToggles = state?.toggles.filter(toggle => operationalActions.includes(toggle.action)) ?? [];

  const isActive = (action: IncidentAction): ToggleState | undefined =>
    operationalToggles.find(t => t.action === action);

  const requestActivate = (meta: ActionMeta): void => {
    const limit = state?.limits[meta.action];
    setPending({
      meta, kind: 'activate',
      request: {
        action: meta.action, title: meta.title,
        description: `${meta.description}${limit ? `\n\nDefault-Dauer: ${Math.round(limit.defaultMs / 60000)}min · Max: ${Math.round(limit.maxDurationMs / 60000)}min.` : ''}`,
        severity: meta.severity,
        autoExpireNote: limit ? `Wird automatisch nach max. ${Math.round(limit.maxDurationMs / 60000)} Minuten aufgehoben.` : undefined,
      },
    });
  };

  const requestDeactivate = (meta: ActionMeta, t: ToggleState): void => {
    setPending({
      meta, kind: 'deactivate',
      request: {
        action: meta.action, title: `${meta.title} aufheben`,
        description: `Aktiviert seit ${new Date(t.activatedAt).toLocaleString()}. Manuelle Deaktivierung beendet die Wirkung sofort.`,
        severity: 'warn',
      },
    });
  };

  const requestOneShot = (meta: ActionMeta): void => {
    setPending({
      meta, kind: 'oneshot',
      request: {
        action: meta.action, title: meta.title,
        description: `${meta.description}\n\nDieser Vorgang wird unmittelbar ausgefuehrt und kann nicht rueckgaengig gemacht werden.`,
        severity: meta.severity,
      },
    });
  };

  const onConfirm = async ({ reason, reAuth }: { reason: string; reAuth: string }): Promise<void> => {
    if (!pending) return;
    setBusy(true);
    try {
      if (pending.kind === 'activate') {
        await api.post('/api/v2/dev/incident/activate', {
          action: pending.meta.action, reason, reAuth,
          idempotencyKey: newIdempotencyKey('activate'),
        });
        toast.push({ variant: 'success', title: 'Aktiviert', desc: pending.meta.title });
      } else if (pending.kind === 'deactivate') {
        await api.post('/api/v2/dev/incident/deactivate', {
          action: pending.meta.action, reason, reAuth,
        });
        toast.push({ variant: 'success', title: 'Aufgehoben', desc: pending.meta.title });
      } else {
        await api.post('/api/v2/dev/incident/oneshot', {
          action: pending.meta.action, reason, reAuth,
          idempotencyKey: newIdempotencyKey('oneshot'),
        });
        toast.push({ variant: 'success', title: 'Ausgefuehrt', desc: pending.meta.title });
      }
      setPending(null);
      await reload();
    } catch (e) {
      toast.push({ variant: 'danger', title: 'Aktion fehlgeschlagen', desc: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-gutter">
      <SectionHeader
        title="Incident Response"
        desc="Notfall-Steuerung zeigt nur nachweislich an produktive Runtime-Wirkungen gekoppelte Aktionen."
        actions={(
          <Button size="sm" variant="ghost" onClick={() => void reload()} disabled={loading}>
            <RefreshCw className="h-4 w-4 mr-1" /> Aktualisieren
          </Button>
        )}
      />

      {loading && state === null ? (
        <Card>
          <div className="space-y-2 p-4"><Skeleton className="h-8" /><Skeleton className="h-8" /></div>
        </Card>
      ) : operationalActions.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle><AlertOctagon className="h-4 w-4 inline mr-1 text-warn" /> Incident-Aktionen nicht freigegeben</CardTitle>
            <CardDesc>
              Die vorhandenen Incident-Definitionen besitzen aktuell keinen durchgaengig verifizierten Produktions-Side-Effect.
              Sie bleiben deshalb fail-closed deaktiviert, statt einen erfolgreichen Notfalleingriff vorzutäuschen.
            </CardDesc>
          </CardHeader>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle><AlertOctagon className="h-4 w-4 inline mr-1 text-warn" /> Aktive Vorfaelle</CardTitle>
              <CardDesc>Alle freigegebenen Toggles laufen automatisch nach Limit aus. Manuelle Deaktivierung ist jederzeit moeglich.</CardDesc>
            </CardHeader>
            {operationalToggles.length === 0 ? (
              <div className="px-4 pb-4 text-sm text-muted">Aktuell keine aktiven Notfall-Toggles.</div>
            ) : (
              <ul className="px-4 pb-4 space-y-2">
                {operationalToggles.map(t => {
                  const meta = operationalToggleMeta.find(m => m.action === t.action);
                  return (
                    <li key={t.action} className="flex items-center gap-3 rounded-md border border-warn/30 bg-warn/5 p-3">
                      <Badge variant="warn" pulse><Clock className="h-3 w-3 inline mr-1" />{fmtRemaining(t.expiresAt)}</Badge>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium">{meta?.title ?? t.action}</div>
                        <div className="text-xs text-muted truncate">Aktiviert {new Date(t.activatedAt).toLocaleString()} · Reason: {t.reason}</div>
                      </div>
                      {meta && (
                        <Button size="sm" variant="outline" onClick={() => requestDeactivate(meta, t)}>
                          Aufheben
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          {operationalToggleMeta.length > 0 && (
            <>
              <SectionHeader title="Kill-Switches & Modes" />
              <div className="grid gap-gutter md:grid-cols-2">
                {operationalToggleMeta.map(meta => {
                  const Icon = meta.icon;
                  const active = isActive(meta.action);
                  return (
                    <Card key={meta.action}>
                      <CardHeader>
                        <CardTitle><Icon className="h-4 w-4 inline mr-1" />{meta.title}</CardTitle>
                        <CardDesc>{meta.description}</CardDesc>
                      </CardHeader>
                      <div className="px-4 pb-4 flex items-center justify-between gap-3">
                        <Badge variant={active ? 'warn' : 'neutral'}>
                          {active ? `aktiv · ${fmtRemaining(active.expiresAt)}` : 'inaktiv'}
                        </Badge>
                        {active ? (
                          <Button size="sm" variant="outline" onClick={() => requestDeactivate(meta, active)}>Aufheben</Button>
                        ) : (
                          <Button size="sm" variant={meta.severity === 'danger' ? 'danger' : 'primary'} onClick={() => requestActivate(meta)}>
                            Aktivieren
                          </Button>
                        )}
                      </div>
                    </Card>
                  );
                })}
              </div>
            </>
          )}

          {operationalOneShotMeta.length > 0 && (
            <>
              <SectionHeader title="One-Shot-Aktionen" />
              <div className="grid gap-gutter md:grid-cols-2">
                {operationalOneShotMeta.map(meta => {
                  const Icon = meta.icon;
                  return (
                    <Card key={meta.action}>
                      <CardHeader>
                        <CardTitle><Icon className="h-4 w-4 inline mr-1" />{meta.title}</CardTitle>
                        <CardDesc>{meta.description}</CardDesc>
                      </CardHeader>
                      <div className="px-4 pb-4 flex items-center justify-end">
                        <Button size="sm" variant="primary" onClick={() => requestOneShot(meta)}>
                          <Database className="h-4 w-4 mr-1" /> Ausfuehren
                        </Button>
                      </div>
                    </Card>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}

      <StepUpModal
        open={!!pending}
        onClose={() => !busy && setPending(null)}
        request={pending?.request ?? null}
        onConfirm={onConfirm}
        loading={busy}
      />
    </div>
  );
}
