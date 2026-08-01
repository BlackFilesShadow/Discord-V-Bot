import type { Request, Response } from 'express';

/**
 * F-007: Trennung von Liveness (Prozess laeuft) und Readiness (DB + Session-
 * Store erreichbar). `/health` bleibt Liveness; `/health/ready` prueft die
 * Abhaengigkeiten und liefert 503, wenn der Bot Requests NICHT sicher bedienen
 * kann (z.B. defekter Session-Store -> Auth kaputt).
 */
export interface ReadinessDeps {
  pingDb: () => Promise<unknown>;
  pingSessionStore: () => Promise<unknown>;
}

export interface ReadinessResult {
  ready: boolean;
  checks: { database: 'ok' | 'fail'; sessionStore: 'ok' | 'fail' };
}

export async function checkReadiness(deps: ReadinessDeps): Promise<ReadinessResult> {
  const checks: ReadinessResult['checks'] = { database: 'fail', sessionStore: 'fail' };
  try { await deps.pingDb(); checks.database = 'ok'; } catch { /* bleibt fail */ }
  try { await deps.pingSessionStore(); checks.sessionStore = 'ok'; } catch { /* bleibt fail */ }
  return { ready: checks.database === 'ok' && checks.sessionStore === 'ok', checks };
}

export function readinessHandler(deps: ReadinessDeps) {
  return async (_req: Request, res: Response): Promise<void> => {
    const r = await checkReadiness(deps);
    res.status(r.ready ? 200 : 503).json({ status: r.ready ? 'ready' : 'not_ready', checks: r.checks });
  };
}
