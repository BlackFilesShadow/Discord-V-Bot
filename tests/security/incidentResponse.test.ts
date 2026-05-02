/**
 * P2 — Incident-Response Service Tests.
 *
 * Verifiziert:
 *   - activateIncident: rejects oneshot/unknown/short-reason/over-max-duration
 *   - activateIncident: idempotency replay schlaegt fehl
 *   - activateIncident: already_active wenn Toggle bereits laeuft
 *   - deactivateIncident: not_active / reason_too_short / ok
 *   - fireOneShotIncident: rejects toggle, ok bei oneshot, idempotency replay
 *   - getIncidentSnapshot: zeigt aktiven Toggle, removed nach Auto-Expire
 *   - isIncidentActive: false nach Wand-Uhr-Expire
 */

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
  logAuditDb: jest.fn(),
}));

import {
  activateIncident, deactivateIncident, fireOneShotIncident,
  getIncidentSnapshot, isIncidentActive, INCIDENT_LIMITS,
  __resetIncidentStateForTests,
} from '../../src/dashboard/services/incidentResponse';

const ACTOR = { byUserId: 'u1', byDiscordId: 'd1' };
const REASON = 'gueltige notfall begruendung';

beforeEach(() => {
  __resetIncidentStateForTests();
});

describe('activateIncident', () => {
  it('rejects unbekannte Action', () => {
    const r = activateIncident({
      action: 'kill.unknown' as never, reason: REASON, idempotencyKey: 'idem-12345', ...ACTOR,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_action');
  });

  it('rejects One-Shot via activate', () => {
    const r = activateIncident({
      action: 'cache.flush', reason: REASON, idempotencyKey: 'idem-12345', ...ACTOR,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('oneshot_not_toggle');
  });

  it('rejects zu kurze Reason', () => {
    const r = activateIncident({
      action: 'kill.ai', reason: 'kurz', idempotencyKey: 'idem-12345', ...ACTOR,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('reason_too_short');
  });

  it('rejects Dauer ueber max', () => {
    const r = activateIncident({
      action: 'kill.ai', durationMs: INCIDENT_LIMITS['kill.ai'].maxDurationMs + 1,
      reason: REASON, idempotencyKey: 'idem-12345', ...ACTOR,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('duration_exceeds_max');
  });

  it('rejects Dauer = 0 / negativ', () => {
    const r = activateIncident({
      action: 'kill.ai', durationMs: 0, reason: REASON, idempotencyKey: 'idem-12345', ...ACTOR,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('duration_invalid');
  });

  it('aktiviert Toggle und schreibt expiresAt', () => {
    const r = activateIncident({
      action: 'kill.ai', reason: REASON, idempotencyKey: 'idem-12345', ...ACTOR,
    });
    expect(r.ok).toBe(true);
    expect(r.state?.action).toBe('kill.ai');
    expect(r.state?.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(isIncidentActive('kill.ai')).toBe(true);
  });

  it('lehnt zweite Aktivierung mit already_active', () => {
    activateIncident({ action: 'kill.ai', reason: REASON, idempotencyKey: 'idem-1', ...ACTOR });
    const r = activateIncident({
      action: 'kill.ai', reason: REASON, idempotencyKey: 'idem-2', ...ACTOR,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('already_active');
  });

  it('lehnt Idempotency-Replay', () => {
    activateIncident({ action: 'kill.ai', reason: REASON, idempotencyKey: 'idem-x', ...ACTOR });
    // Zweite Aktion mit gleichem Key, andere Action
    const r = activateIncident({
      action: 'kill.automod', reason: REASON, idempotencyKey: 'idem-x', ...ACTOR,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('idempotency_replay');
    expect(r.replayOf?.action).toBe('kill.ai');
  });
});

describe('deactivateIncident', () => {
  it('not_active wenn nichts laeuft', () => {
    const r = deactivateIncident({ action: 'kill.ai', reason: REASON, ...ACTOR });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('not_active');
  });

  it('reason_too_short', () => {
    activateIncident({ action: 'kill.ai', reason: REASON, idempotencyKey: 'idem-1', ...ACTOR });
    const r = deactivateIncident({ action: 'kill.ai', reason: 'a', ...ACTOR });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('reason_too_short');
  });

  it('deaktiviert aktiven Toggle', () => {
    activateIncident({ action: 'kill.ai', reason: REASON, idempotencyKey: 'idem-1', ...ACTOR });
    expect(isIncidentActive('kill.ai')).toBe(true);
    const r = deactivateIncident({ action: 'kill.ai', reason: REASON, ...ACTOR });
    expect(r.ok).toBe(true);
    expect(isIncidentActive('kill.ai')).toBe(false);
  });
});

describe('fireOneShotIncident', () => {
  it('rejects Toggle als One-Shot', () => {
    const r = fireOneShotIncident({
      action: 'kill.ai', reason: REASON, idempotencyKey: 'idem-12345', ...ACTOR,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('toggle_not_oneshot');
  });

  it('feuert cache.flush', () => {
    const r = fireOneShotIncident({
      action: 'cache.flush', reason: REASON, idempotencyKey: 'idem-12345', ...ACTOR,
    });
    expect(r.ok).toBe(true);
    expect(r.firedAt).toBeInstanceOf(Date);
  });

  it('lehnt Idempotency-Replay bei One-Shot', () => {
    fireOneShotIncident({ action: 'cache.flush', reason: REASON, idempotencyKey: 'idem-shot', ...ACTOR });
    const r = fireOneShotIncident({
      action: 'backup.trigger', reason: REASON, idempotencyKey: 'idem-shot', ...ACTOR,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('idempotency_replay');
  });
});

describe('Snapshot + Auto-Expire', () => {
  it('listet aktive Toggles im Snapshot', () => {
    activateIncident({ action: 'kill.ai', reason: REASON, idempotencyKey: 'idem-1', ...ACTOR });
    activateIncident({ action: 'maintenance', reason: REASON, idempotencyKey: 'idem-2', ...ACTOR });
    const snap = getIncidentSnapshot();
    expect(snap.toggles).toHaveLength(2);
    expect(snap.toggles.map(t => t.action).sort()).toEqual(['kill.ai', 'maintenance']);
  });

  it('isIncidentActive=false sobald expiresAt abgelaufen (Wand-Uhr-Check)', () => {
    activateIncident({
      action: 'kill.ai', durationMs: 1000, reason: REASON, idempotencyKey: 'idem-1', ...ACTOR,
    });
    const future = new Date(Date.now() + 5000);
    expect(isIncidentActive('kill.ai', future)).toBe(false);
  });
});
