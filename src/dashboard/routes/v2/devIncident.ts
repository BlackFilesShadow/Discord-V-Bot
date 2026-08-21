/**
 * P2 — Incident-Response-Routes.
 *
 * Alle Routen:
 *   - hinter requireDev (Role + DevSession + MFA + IP)
 *   - Mutationen zusaetzlich hinter kryptografisch verifiziertem DEV-Step-Up
 *   - audit-loggen via incidentResponse-Service
 *
 * WICHTIG: Eine IncidentAction darf erst ueber die produktive API ausgeloest
 * werden, wenn ihr realer Runtime-Consumer bzw. One-Shot-Side-Effect belegt ist.
 * Ein reiner In-Memory-/Audit-State gilt nicht als produktive Wirkung.
 *
 * Endpoints:
 *   GET  /v2/dev/incident/state                         - Snapshot aller Toggles
 *   POST /v2/dev/incident/activate                      - Body: { action, durationMs?, reason, reAuth, idempotencyKey, payload? }
 *   POST /v2/dev/incident/deactivate                    - Body: { action, reason, reAuth }
 *   POST /v2/dev/incident/oneshot                       - Body: { action, reason, reAuth, idempotencyKey, payload? }
 */
import { Router } from 'express';
import { requireDev } from '../../middleware/auth';
import { requireVerifiedDevMutationStepUp } from '../../middleware/devStepUp';
import {
  activateIncident, deactivateIncident, fireOneShotIncident,
  getIncidentSnapshot, INCIDENT_LIMITS,
  type IncidentAction,
} from '../../services/incidentResponse';

export const devIncidentRouter = Router();

/**
 * Stage 27 action-coupling gate.
 *
 * Repository-wide coupling audit on the Stage-26 verified main found no
 * production consumer of `isIncidentActive(...)`. `cache.flush` and
 * `backup.trigger` likewise only wrote audit/idempotency state and did not
 * execute the UI-advertised cache/backup effects. Advertising these controls
 * as operational would therefore create a false-success emergency console.
 *
 * Keep this allowlist empty until a later change provides and tests the real
 * production side effect end-to-end. Adding an action here is intentionally a
 * reviewed code change and must come with its runtime coupling evidence.
 */
export const OPERATIONAL_INCIDENT_ACTIONS: readonly IncidentAction[] = [];

function isOperationalIncidentAction(action: IncidentAction): boolean {
  return OPERATIONAL_INCIDENT_ACTIONS.includes(action);
}

// Util: rejects die Request mit konsistentem Schema.
function bad(res: Parameters<Parameters<typeof devIncidentRouter.post>[1]>[1], status: number, code: string): void {
  res.status(status).json({ ok: false, error: code });
}

devIncidentRouter.get('/state', requireDev, (_req, res) => {
  const snap = getIncidentSnapshot();
  res.json({ ok: true, ...snap, operationalActions: OPERATIONAL_INCIDENT_ACTIONS });
});

devIncidentRouter.post('/activate', requireDev, requireVerifiedDevMutationStepUp, (req, res) => {
  if (!req.auth) { bad(res, 401, 'unauthenticated'); return; }
  const body = (req.body ?? {}) as {
    action?: string; durationMs?: number; reason?: string; reAuth?: string;
    idempotencyKey?: string; payload?: Record<string, string | number | boolean>;
  };
  const action = String(body.action ?? '') as IncidentAction;
  if (!(action in INCIDENT_LIMITS)) { bad(res, 400, 'unknown_action'); return; }
  if (!isOperationalIncidentAction(action)) { bad(res, 503, 'incident_action_not_operational'); return; }

  const idempotencyKey = String(body.idempotencyKey ?? '').trim();
  if (idempotencyKey.length < 8) { bad(res, 400, 'idempotency_key_too_short'); return; }

  const r = activateIncident({
    action, durationMs: typeof body.durationMs === 'number' ? body.durationMs : undefined,
    reason: String(body.reason ?? ''), byUserId: req.auth.userId, byDiscordId: String(req.auth.discordId),
    ip: req.ip ?? null, idempotencyKey, payload: body.payload,
  });
  if (!r.ok) {
    const status = r.error === 'already_active' ? 409
      : r.error === 'idempotency_replay' ? 409
      : 400;
    res.status(status).json({ ok: false, error: r.error, replayOf: r.replayOf });
    return;
  }
  res.json({ ok: true, state: r.state });
});

devIncidentRouter.post('/deactivate', requireDev, requireVerifiedDevMutationStepUp, (req, res) => {
  if (!req.auth) { bad(res, 401, 'unauthenticated'); return; }
  const body = (req.body ?? {}) as { action?: string; reason?: string; reAuth?: string };
  const action = String(body.action ?? '') as IncidentAction;
  if (!(action in INCIDENT_LIMITS)) { bad(res, 400, 'unknown_action'); return; }
  if (!isOperationalIncidentAction(action)) { bad(res, 503, 'incident_action_not_operational'); return; }

  const r = deactivateIncident({
    action, reason: String(body.reason ?? ''),
    byUserId: req.auth.userId, byDiscordId: String(req.auth.discordId), ip: req.ip ?? null,
  });
  if (!r.ok) {
    const status = r.error === 'not_active' ? 404 : 400;
    res.status(status).json({ ok: false, error: r.error });
    return;
  }
  res.json({ ok: true });
});

devIncidentRouter.post('/oneshot', requireDev, requireVerifiedDevMutationStepUp, (req, res) => {
  if (!req.auth) { bad(res, 401, 'unauthenticated'); return; }
  const body = (req.body ?? {}) as {
    action?: string; reason?: string; reAuth?: string; idempotencyKey?: string;
    payload?: Record<string, string | number | boolean>;
  };
  const action = String(body.action ?? '') as IncidentAction;
  if (!(action in INCIDENT_LIMITS)) { bad(res, 400, 'unknown_action'); return; }
  if (!isOperationalIncidentAction(action)) { bad(res, 503, 'incident_action_not_operational'); return; }

  const idempotencyKey = String(body.idempotencyKey ?? '').trim();
  if (idempotencyKey.length < 8) { bad(res, 400, 'idempotency_key_too_short'); return; }

  const r = fireOneShotIncident({
    action, reason: String(body.reason ?? ''),
    byUserId: req.auth.userId, byDiscordId: String(req.auth.discordId),
    ip: req.ip ?? null, idempotencyKey, payload: body.payload,
  });
  if (!r.ok) {
    const status = r.error === 'idempotency_replay' ? 409 : 400;
    res.status(status).json({ ok: false, error: r.error, replayOf: r.replayOf });
    return;
  }
  res.json({ ok: true, firedAt: r.firedAt });
});
