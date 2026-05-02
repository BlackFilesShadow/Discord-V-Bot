/**
 * P2 — Incident-Response-Routes.
 *
 * Alle Routen:
 *   - hinter requireDev (Role + DevSession + MFA + IP)
 *   - validieren Step-Up-Body via validateStepUpInput  (Reason + Re-Auth)
 *   - audit-loggen via incidentResponse-Service
 *
 * Endpoints:
 *   GET  /v2/dev/incident/state                         - Snapshot aller Toggles
 *   POST /v2/dev/incident/activate                      - Body: { action, durationMs?, reason, reAuth, idempotencyKey, payload? }
 *   POST /v2/dev/incident/deactivate                    - Body: { action, reason, reAuth }
 *   POST /v2/dev/incident/oneshot                       - Body: { action, reason, reAuth, idempotencyKey, payload? }
 */
import { Router } from 'express';
import { requireDev } from '../../middleware/auth';
import { validateStepUpInput } from '../../middleware/devSecurity';
import {
  activateIncident, deactivateIncident, fireOneShotIncident,
  getIncidentSnapshot, INCIDENT_LIMITS,
  type IncidentAction,
} from '../../services/incidentResponse';

export const devIncidentRouter = Router();

// Util: rejects die Request mit konsistentem Schema.
function bad(res: Parameters<Parameters<typeof devIncidentRouter.post>[1]>[1], status: number, code: string): void {
  res.status(status).json({ ok: false, error: code });
}

devIncidentRouter.get('/state', requireDev, (_req, res) => {
  const snap = getIncidentSnapshot();
  res.json({ ok: true, ...snap });
});

devIncidentRouter.post('/activate', requireDev, (req, res) => {
  if (!req.auth) { bad(res, 401, 'unauthenticated'); return; }
  const body = (req.body ?? {}) as {
    action?: string; durationMs?: number; reason?: string; reAuth?: string;
    idempotencyKey?: string; payload?: Record<string, string | number | boolean>;
  };
  const action = String(body.action ?? '') as IncidentAction;
  if (!(action in INCIDENT_LIMITS)) { bad(res, 400, 'unknown_action'); return; }

  const stepUp = validateStepUpInput({ reason: body.reason, reAuth: body.reAuth });
  if (!stepUp.ok) { bad(res, 400, stepUp.error ?? 'step_up_invalid'); return; }

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

devIncidentRouter.post('/deactivate', requireDev, (req, res) => {
  if (!req.auth) { bad(res, 401, 'unauthenticated'); return; }
  const body = (req.body ?? {}) as { action?: string; reason?: string; reAuth?: string };
  const action = String(body.action ?? '') as IncidentAction;
  if (!(action in INCIDENT_LIMITS)) { bad(res, 400, 'unknown_action'); return; }
  const stepUp = validateStepUpInput({ reason: body.reason, reAuth: body.reAuth });
  if (!stepUp.ok) { bad(res, 400, stepUp.error ?? 'step_up_invalid'); return; }

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

devIncidentRouter.post('/oneshot', requireDev, (req, res) => {
  if (!req.auth) { bad(res, 401, 'unauthenticated'); return; }
  const body = (req.body ?? {}) as {
    action?: string; reason?: string; reAuth?: string; idempotencyKey?: string;
    payload?: Record<string, string | number | boolean>;
  };
  const action = String(body.action ?? '') as IncidentAction;
  if (!(action in INCIDENT_LIMITS)) { bad(res, 400, 'unknown_action'); return; }

  const stepUp = validateStepUpInput({ reason: body.reason, reAuth: body.reAuth });
  if (!stepUp.ok) { bad(res, 400, stepUp.error ?? 'step_up_invalid'); return; }
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
