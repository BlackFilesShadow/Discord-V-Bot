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
const componentBuckets = new Map<string, Bucket>();

/**
 * Harte Obergrenze je Bucket-Map. Ohne diese Grenze konnten einmalig gesehene
 * Discord-IDs bzw. User×Command-Kombinationen bis zum Prozessneustart im Heap
 * verbleiben. Bei Erreichen der Grenze werden zuerst abgelaufene Windows
 * entfernt; nur wenn danach weiterhin kein Platz frei ist, wird der älteste
 * verbleibende Eintrag verworfen. Dadurch bleibt der Speicher deterministisch
 * begrenzt und das Fail-safe-Verhalten unter extremer Key-Kardinalität erhalten.
 */
export const RATE_LIMIT_BUCKET_MAX_ENTRIES = 50_000;

export const RATE_LIMIT_GLOBAL_WINDOW_MS = 60_000;
export const RATE_LIMIT_GLOBAL_MAX = 30;

export const RATE_LIMIT_PER_COMMAND_WINDOW_MS = 60_000;
/**
 * 10 Aufrufe / 60s pro (User × Command). Bewusst tiefer als das globale
 * Limit (30/60s) — verhindert dass ein einzelner teurer Command (AI,
 * Help-Pagination etc.) die kompletten 30 Slots verbrennt.
 */
export const RATE_LIMIT_PER_COMMAND_MAX = 10;

/**
 * Komponenten-Interaktionen (Buttons/Modals/Select-Menus) haben einen
 * EIGENEN Bucket, damit Button-Klicks nicht das Command-Budget verbrennen
 * (und umgekehrt). Etwas großzügiger als Commands, da UI-Klicks legitim in
 * kurzer Folge auftreten (z.B. Help-Pagination, Selfrole-Toggles).
 */
export const RATE_LIMIT_COMPONENT_WINDOW_MS = 30_000;
export const RATE_LIMIT_COMPONENT_MAX = 25;

function pruneExpired(map: Map<string, Bucket>, now: number, windowMs: number): void {
  for (const [key, entry] of map) {
    if (now - entry.windowStart > windowMs) map.delete(key);
  }
}

function ensureCapacity(map: Map<string, Bucket>, now: number, windowMs: number): void {
  if (map.size < RATE_LIMIT_BUCKET_MAX_ENTRIES) return;

  pruneExpired(map, now, windowMs);
  while (map.size >= RATE_LIMIT_BUCKET_MAX_ENTRIES) {
    const oldestKey = map.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}

function check(map: Map<string, Bucket>, key: string, windowMs: number, max: number, now: number): boolean {
  const entry = map.get(key);
  if (!entry || now - entry.windowStart > windowMs) {
    if (!entry) ensureCapacity(map, now, windowMs);
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
 * Globaler Per-User-Bucket für Komponenten-Interaktionen (Buttons/Modals/
 * Select-Menus). Gibt `false` zurück, wenn das Limit überschritten ist.
 * Schützt die Komponenten-Handler vor Klick-Spam (eigener Bucket, koppelt
 * nicht an das Command-Budget).
 */
export function checkComponentRateLimit(userId: string, now: number = Date.now()): boolean {
  return check(componentBuckets, userId, RATE_LIMIT_COMPONENT_WINDOW_MS, RATE_LIMIT_COMPONENT_MAX, now);
}

/**
 * Test-Hilfe: leert alle Buckets. NICHT in Produktion aufrufen.
 */
export function __resetRateLimits(): void {
  globalBuckets.clear();
  perCommandBuckets.clear();
  componentBuckets.clear();
}

/** Test-/Audit-Hilfe für die Stage-49-Boundedness-Verifikation. */
export function __getRateLimitBucketStats(): { global: number; perCommand: number; component: number } {
  return {
    global: globalBuckets.size,
    perCommand: perCommandBuckets.size,
    component: componentBuckets.size,
  };
}
