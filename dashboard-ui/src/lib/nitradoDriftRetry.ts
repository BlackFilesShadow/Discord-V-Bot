export interface DriftApiErrorDescription {
  status: number;
  code: string | null;
  desc: string;
}

/**
 * The backend intentionally rejects drift reads while the canonical per-Nitrado
 * advisory lock is held. Those 409s are contention, not evidence of drift.
 *
 * The string fallbacks preserve compatibility with the already deployed 409
 * contract. Machine-readable codes are accepted as well so a later backend
 * hardening can add codes without another dashboard rollout.
 */
const TRANSIENT_DRIFT_MESSAGES = [
  'Nitrado-Verbindung wird gerade sicher verarbeitet oder parallel geaendert.',
  'Nitrado-Zuordnung hat sich waehrend der Drift-Pruefung geaendert.',
  'Nitrado-Zuordnung hat sich waehrend der Drift-Bestaetigung geaendert.',
] as const;

const TRANSIENT_DRIFT_CODES = new Set([
  'NITRADO_BINDING_BUSY',
  'NITRADO_BINDING_STALE',
]);

/**
 * Bounded client-side backoff. The worker can legitimately hold the shared
 * connection lock across remote Nitrado I/O, so a sub-second one-shot retry is
 * insufficient. The total retry window is ~21s, after which a persistent
 * contention condition is surfaced instead of being hidden forever.
 */
export const NITRADO_DRIFT_RETRY_DELAYS_MS = [500, 1_500, 3_000, 6_000, 10_000] as const;

export function isTransientNitradoDriftConflict(error: DriftApiErrorDescription): boolean {
  if (error.status !== 409) return false;
  if (error.code && TRANSIENT_DRIFT_CODES.has(error.code)) return true;
  return TRANSIENT_DRIFT_MESSAGES.some(message => error.desc.startsWith(message));
}

export function shouldRetryNitradoDrift(
  failureCount: number,
  error: DriftApiErrorDescription,
): boolean {
  return failureCount < NITRADO_DRIFT_RETRY_DELAYS_MS.length
    && isTransientNitradoDriftConflict(error);
}

export function nitradoDriftRetryDelay(attemptIndex: number): number {
  const boundedIndex = Math.min(
    Math.max(0, attemptIndex),
    NITRADO_DRIFT_RETRY_DELAYS_MS.length - 1,
  );
  return NITRADO_DRIFT_RETRY_DELAYS_MS[boundedIndex];
}
