/**
 * In-Memory Sliding-Window-Rate-Limits für Discord-Interactions.
 *
 * Synchron, 0 DB-Calls, ms-Latenz — wichtig damit wir Discord's
 * 3s-Interaction-Timeout nicht reißen, wenn der Bot unter Last steht.
 *
 * Zwei unabhängige Buckets:
 * - **global**:  per User insgesamt (Schutz gegen Spam-Bots).
 * - **perCommand**:  per (User × Command) — fängt Floods auf einzelne
 *   teure Commands ab (z.B. AI-Calls, große DB-Queries), ohne dass der
 *   Nutzer dafür einen `command.cooldown` setzen muss.
 *
 * Hinweis: `command.cooldown` (siehe `utils/cooldown.ts`) ist eine pro-
 * Command-Spacing-Regel ("X Sekunden Abstand zwischen 2 Aufrufen").
 * Hier dagegen: "max N Aufrufe pro Window".
 */

interface Bucket {
  count: number;
  windowStart: number;
}

const globalBuckets = new Map<string, Bucket>();
const perCommandBuckets = new Map<string, Bucket>();

export const RATE_LIMIT_GLOBAL_WINDOW_MS = 60_000;
export const RATE_LIMIT_GLOBAL_MAX = 30;

export const RATE_LIMIT_PER_COMMAND_WINDOW_MS = 60_000;
/**
 * 10 Aufrufe / 60s pro (User × Command). Bewusst tiefer als das globale
 * Limit (30/60s) — verhindert dass ein einzelner teurer Command (AI,
 * Help-Pagination etc.) die kompletten 30 Slots verbrennt.
 */
export const RATE_LIMIT_PER_COMMAND_MAX = 10;

function check(map: Map<string, Bucket>, key: string, windowMs: number, max: number, now: number): boolean {
  const entry = map.get(key);
  if (!entry || now - entry.windowStart > windowMs) {
    map.set(key, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count++;
  return true;
}

/**
 * Globaler Per-User-Bucket. Gibt `false` zurück wenn das Limit überschritten ist.
 */
export function checkGlobalRateLimit(userId: string, now: number = Date.now()): boolean {
  return check(globalBuckets, userId, RATE_LIMIT_GLOBAL_WINDOW_MS, RATE_LIMIT_GLOBAL_MAX, now);
}

/**
 * Per (User × Command)-Bucket. Liefert das Restkontingent oder `null` wenn ok.
 */
export function checkPerCommandRateLimit(
  userId: string,
  commandName: string,
  now: number = Date.now(),
): boolean {
  const key = `${userId}::${commandName}`;
  return check(perCommandBuckets, key, RATE_LIMIT_PER_COMMAND_WINDOW_MS, RATE_LIMIT_PER_COMMAND_MAX, now);
}

/**
 * Test-Hilfe: leert beide Buckets. NICHT in Produktion aufrufen.
 */
export function __resetRateLimits(): void {
  globalBuckets.clear();
  perCommandBuckets.clear();
}
