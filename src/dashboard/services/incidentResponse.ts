/**
 * P2 — Incident-Response-State.
 *
 * Liefert einen In-Memory-State fuer kritische Notfall-Aktionen, jeweils mit
 *   - Auto-Expire (Timer + Wand-Uhr-Vergleich)
 *   - Idempotency-Key (replay-safe)
 *   - SECURITY-Audit jeder Transition (activate / deactivate / refresh)
 *
 * Aktions-Typen (siehe IncidentAction):
 *
 *   Toggle (Aktivieren / Aufheben mit max-Dauer):
 *     - kill.ai          (Kill-Switch fuer AI-Layer, max 1h)
 *     - kill.automod     (Kill-Switch fuer Auto-Moderation, max 1h)
 *     - kill.translation (Kill-Switch fuer Translation, max 1h)
 *     - provider.force   (Force-Switch AI-Provider, max 4h)
 *     - maintenance      (Wartungsmodus, max 4h)
 *
 *   One-Shot (Aktion "feuert", kein State zu halten):
 *     - cache.flush
 *     - backup.trigger
 *
 * Fuer Multi-Process-Deployments waere ein DB-Persisted-State noetig — der
 * aktuelle Bot laeuft single-process, daher reicht in-memory + Audit-Log.
 */

import { logger, logAudit, logAuditDb } from '../../utils/logger';

// --- Konstanten -----------------------------------------------------------

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

export const INCIDENT_LIMITS = {
  'kill.ai':          { maxDurationMs: 1 * HOUR, defaultMs: 30 * MIN, kind: 'toggle' as const },
  'kill.automod':     { maxDurationMs: 1 * HOUR, defaultMs: 30 * MIN, kind: 'toggle' as const },
  'kill.translation': { maxDurationMs: 1 * HOUR, defaultMs: 30 * MIN, kind: 'toggle' as const },
  'provider.force':   { maxDurationMs: 4 * HOUR, defaultMs: 1 * HOUR, kind: 'toggle' as const },
  'maintenance':      { maxDurationMs: 4 * HOUR, defaultMs: 30 * MIN, kind: 'toggle' as const },
  'cache.flush':      { maxDurationMs: 0,         defaultMs: 0,        kind: 'oneshot' as const },
  'backup.trigger':   { maxDurationMs: 0,         defaultMs: 0,        kind: 'oneshot' as const },
} as const;

export type IncidentAction = keyof typeof INCIDENT_LIMITS;

export const TOGGLE_ACTIONS: ReadonlyArray<IncidentAction> = (Object.keys(INCIDENT_LIMITS) as IncidentAction[])
  .filter(a => INCIDENT_LIMITS[a].kind === 'toggle');

// --- State ----------------------------------------------------------------

export interface ToggleState {
  action: IncidentAction;
  active: true;
  activatedAt: Date;
  expiresAt: Date;
  reason: string;
  byUserId: string;
  byDiscordId: string;
  idempotencyKey: string;
  /** Fuer provider.force: zusaetzlich provider-name. */
  payload?: Record<string, string | number | boolean>;
}

interface InternalToggleEntry extends ToggleState {
  timer?: NodeJS.Timeout;
}

// Pro Action max ein aktiver Toggle (pro Provider-Force koennte man später
// pro provider differenzieren — aktuell global).
const toggles = new Map<IncidentAction, InternalToggleEntry>();

// Idempotency-Cache: key -> { action, expiresAt }. Verhindert Doppel-Auslosen.
const idempotency = new Map<string, { action: IncidentAction; until: number }>();
const IDEMPOTENCY_TTL_MS = 10 * MIN;

// --- Public API: Status ---------------------------------------------------

export function getIncidentSnapshot(now: Date = new Date()): {
  toggles: ToggleState[];
  limits: typeof INCIDENT_LIMITS;
} {
  // Lazy expire-cleanup falls Timer (z.B. nach Boot/Restore) gefehlt hat.
  for (const [key, t] of toggles) {
    if (t.expiresAt.getTime() <= now.getTime()) {
      clearToggleInternal(key, 'auto_expire');
    }
  }
  const list: ToggleState[] = [];
  for (const t of toggles.values()) {
    list.push({
      action: t.action, active: true, activatedAt: t.activatedAt,
      expiresAt: t.expiresAt, reason: t.reason, byUserId: t.byUserId,
      byDiscordId: t.byDiscordId, idempotencyKey: t.idempotencyKey, payload: t.payload,
    });
  }
  return { toggles: list, limits: INCIDENT_LIMITS };
}

export function isIncidentActive(action: IncidentAction, now: Date = new Date()): boolean {
  const t = toggles.get(action);
  if (!t) return false;
  if (t.expiresAt.getTime() <= now.getTime()) {
    clearToggleInternal(action, 'auto_expire');
    return false;
  }
  return true;
}

// --- Public API: Activate / Deactivate ------------------------------------

export interface ActivateInput {
  action: IncidentAction;
  durationMs?: number;
  reason: string;
  byUserId: string;
  byDiscordId: string;
  ip?: string | null;
  idempotencyKey: string;
  payload?: Record<string, string | number | boolean>;
}

export interface ActivateResult {
  ok: boolean;
  state?: ToggleState;
  error?:
    | 'unknown_action'
    | 'oneshot_not_toggle'
    | 'duration_invalid'
    | 'duration_exceeds_max'
    | 'reason_too_short'
    | 'idempotency_replay'
    | 'already_active';
  replayOf?: { action: IncidentAction };
}

const REASON_MIN = 6;

export function activateIncident(input: ActivateInput): ActivateResult {
  const limits = INCIDENT_LIMITS[input.action];
  if (!limits) return { ok: false, error: 'unknown_action' };
  if (limits.kind !== 'toggle') return { ok: false, error: 'oneshot_not_toggle' };

  const reason = (input.reason ?? '').trim();
  if (reason.length < REASON_MIN) return { ok: false, error: 'reason_too_short' };

  const duration = input.durationMs ?? limits.defaultMs;
  if (!Number.isFinite(duration) || duration <= 0) return { ok: false, error: 'duration_invalid' };
  if (duration > limits.maxDurationMs) return { ok: false, error: 'duration_exceeds_max' };

  // Idempotency
  cleanupIdempotency();
  const replay = idempotency.get(input.idempotencyKey);
  if (replay) {
    return { ok: false, error: 'idempotency_replay', replayOf: { action: replay.action } };
  }

  if (toggles.has(input.action)) {
    return { ok: false, error: 'already_active' };
  }

  const activatedAt = new Date();
  const expiresAt = new Date(activatedAt.getTime() + duration);
  const entry: InternalToggleEntry = {
    action: input.action, active: true, activatedAt, expiresAt, reason,
    byUserId: input.byUserId, byDiscordId: input.byDiscordId,
    idempotencyKey: input.idempotencyKey, payload: input.payload,
  };
  entry.timer = setTimeout(() => { clearToggleInternal(input.action, 'auto_expire'); },
    Math.max(0, expiresAt.getTime() - Date.now()));
  if (typeof entry.timer.unref === 'function') entry.timer.unref();
  toggles.set(input.action, entry);
  idempotency.set(input.idempotencyKey, { action: input.action, until: Date.now() + IDEMPOTENCY_TTL_MS });

  logAudit('INCIDENT_ACTIVATED', 'SECURITY', {
    actorUserId: input.byUserId, ip: input.ip ?? null,
    action: input.action, reason, durationMs: duration,
    expiresAt: expiresAt.toISOString(), idempotencyKey: input.idempotencyKey,
    payload: input.payload ?? null,
  });
  logAuditDb('INCIDENT_ACTIVATED', 'SECURITY', {
    actorUserId: input.byUserId,
    details: {
      action: input.action, reason, durationMs: duration,
      expiresAt: expiresAt.toISOString(), idempotencyKey: input.idempotencyKey,
      payload: input.payload ?? null,
    },
    ip: input.ip ?? null,
  });
  return { ok: true, state: {
    action: entry.action, active: true, activatedAt: entry.activatedAt,
    expiresAt: entry.expiresAt, reason: entry.reason, byUserId: entry.byUserId,
    byDiscordId: entry.byDiscordId, idempotencyKey: entry.idempotencyKey, payload: entry.payload,
  } };
}

export interface DeactivateInput {
  action: IncidentAction;
  reason: string;
  byUserId: string;
  byDiscordId: string;
  ip?: string | null;
}

export interface DeactivateResult {
  ok: boolean;
  error?: 'unknown_action' | 'not_active' | 'reason_too_short';
}

export function deactivateIncident(input: DeactivateInput): DeactivateResult {
  const limits = INCIDENT_LIMITS[input.action];
  if (!limits) return { ok: false, error: 'unknown_action' };
  const reason = (input.reason ?? '').trim();
  if (reason.length < REASON_MIN) return { ok: false, error: 'reason_too_short' };
  const entry = toggles.get(input.action);
  if (!entry) return { ok: false, error: 'not_active' };
  clearToggleInternal(input.action, 'manual', { actorUserId: input.byUserId, ip: input.ip ?? null, reason });
  return { ok: true };
}

// --- One-Shots ------------------------------------------------------------

export interface OneShotInput {
  action: IncidentAction;
  reason: string;
  byUserId: string;
  byDiscordId: string;
  ip?: string | null;
  idempotencyKey: string;
  payload?: Record<string, string | number | boolean>;
}

export interface OneShotResult {
  ok: boolean;
  error?: 'unknown_action' | 'toggle_not_oneshot' | 'reason_too_short' | 'idempotency_replay';
  firedAt?: Date;
  replayOf?: { action: IncidentAction };
}

export function fireOneShotIncident(input: OneShotInput): OneShotResult {
  const limits = INCIDENT_LIMITS[input.action];
  if (!limits) return { ok: false, error: 'unknown_action' };
  if (limits.kind !== 'oneshot') return { ok: false, error: 'toggle_not_oneshot' };
  const reason = (input.reason ?? '').trim();
  if (reason.length < REASON_MIN) return { ok: false, error: 'reason_too_short' };

  cleanupIdempotency();
  const replay = idempotency.get(input.idempotencyKey);
  if (replay) return { ok: false, error: 'idempotency_replay', replayOf: { action: replay.action } };

  const firedAt = new Date();
  idempotency.set(input.idempotencyKey, { action: input.action, until: Date.now() + IDEMPOTENCY_TTL_MS });
  logAudit('INCIDENT_FIRED', 'SECURITY', {
    actorUserId: input.byUserId, ip: input.ip ?? null,
    action: input.action, reason, idempotencyKey: input.idempotencyKey,
    payload: input.payload ?? null,
  });
  logAuditDb('INCIDENT_FIRED', 'SECURITY', {
    actorUserId: input.byUserId,
    details: {
      action: input.action, reason, idempotencyKey: input.idempotencyKey,
      payload: input.payload ?? null,
    },
    ip: input.ip ?? null,
  });
  return { ok: true, firedAt };
}

// --- Internals ------------------------------------------------------------

function clearToggleInternal(
  action: IncidentAction,
  reason: 'auto_expire' | 'manual',
  meta?: { actorUserId?: string | null; ip?: string | null; reason?: string },
): void {
  const t = toggles.get(action);
  if (!t) return;
  if (t.timer) clearTimeout(t.timer);
  toggles.delete(action);
  logAudit('INCIDENT_DEACTIVATED', 'SECURITY', {
    actorUserId: meta?.actorUserId ?? null, ip: meta?.ip ?? null,
    action, reason, manualReason: meta?.reason ?? null,
    activatedAt: t.activatedAt.toISOString(), expiresAt: t.expiresAt.toISOString(),
  });
  logAuditDb('INCIDENT_DEACTIVATED', 'SECURITY', {
    actorUserId: meta?.actorUserId ?? null,
    details: {
      action, reason, manualReason: meta?.reason ?? null,
      activatedAt: t.activatedAt.toISOString(), expiresAt: t.expiresAt.toISOString(),
    },
    ip: meta?.ip ?? null,
  });
}

function cleanupIdempotency(): void {
  const now = Date.now();
  for (const [k, v] of idempotency) {
    if (v.until <= now) idempotency.delete(k);
  }
}

// --- Test-Helper (nur in Test-Pfaden zu nutzen) ---------------------------

/** Setzt den gesamten Modul-State zurueck. NUR fuer Tests. */
export function __resetIncidentStateForTests(): void {
  for (const t of toggles.values()) {
    if (t.timer) clearTimeout(t.timer);
  }
  toggles.clear();
  idempotency.clear();
  logger.debug('[incidentResponse] state reset (tests)');
}
