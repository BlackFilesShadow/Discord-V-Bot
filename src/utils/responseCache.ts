/**
 * Generischer Response-Cache mit zwei Backends:
 *   - **Memory** (Default): in-process Map mit TTL + LRU-Eviction. Pro
 *     Bot-Prozess isoliert, nicht persistent. Ausreichend fuer Single-Shard.
 *   - **Redis** (optional): aktiv wenn `REDIS_URL` gesetzt ist. Persistent,
 *     ueber Shards/Restarts hinweg geteilt, ideal fuer mehrere Bot-Instanzen.
 *
 * **Sicherheits-/Konsistenz-Regel:** Cache NUR fuer deterministische,
 * kontextfreie Aufrufe verwenden (z.B. translateText(text, lang)). Niemals
 * fuer Chat-/Persona-Calls — sonst leakt der Kontext eines Users an andere.
 */

import { createHash } from 'crypto';
import { logger } from './logger';

interface MemoryEntry {
  value: string;
  expiresAt: number;
}

const MEMORY_MAX_ENTRIES = 1000;
const memory = new Map<string, MemoryEntry>();

let redisClient: { get: (k: string) => Promise<string | null>; set: (k: string, v: string, opts?: unknown) => Promise<unknown> } | null = null;
let redisInitPromise: Promise<void> | null = null;
let redisDisabled = false;

async function initRedis(): Promise<void> {
  if (redisClient || redisDisabled) return;
  const url = process.env.REDIS_URL;
  if (!url) {
    redisDisabled = true;
    return;
  }
  try {
    // Lazy-import damit der Bot ohne Redis-Server bootet.
    const mod = await import('redis');
    const client = mod.createClient({
      url,
      socket: {
        connectTimeout: 5000,
        // Reconnect mit Backoff, aber begrenzt — wenn Redis dauerhaft weg ist,
        // schalten wir auf Memory zurueck (siehe error-handler unten).
        reconnectStrategy: (retries: number) => {
          if (retries > 5) return new Error('Redis unreachable, falling back to memory');
          return Math.min(retries * 200, 2000);
        },
      },
    });
    client.on('error', (e: Error) => {
      logger.warn(`responseCache: Redis-Fehler -> Fallback Memory: ${e.message}`);
      redisDisabled = true;
      redisClient = null;
    });
    await client.connect();
    redisClient = client as unknown as typeof redisClient;
    logger.info('responseCache: Redis-Backend aktiv.');
  } catch (e) {
    logger.warn(`responseCache: Redis-Init fehlgeschlagen, nutze Memory: ${(e as Error).message}`);
    redisDisabled = true;
  }
}

/** Stabiler Hash fuer Cache-Keys (vermeidet riesige Schluessel + leakt nichts). */
function hashKey(namespace: string, parts: string[]): string {
  const h = createHash('sha256').update(parts.join('\u0001')).digest('hex').slice(0, 32);
  return `vbot:${namespace}:${h}`;
}

function memoryEvictIfNeeded(): void {
  if (memory.size < MEMORY_MAX_ENTRIES) return;
  const firstKey = memory.keys().next().value;
  if (firstKey !== undefined) memory.delete(firstKey);
}

function memoryGet(key: string): string | null {
  const e = memory.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) {
    memory.delete(key);
    return null;
  }
  // LRU touch: re-insert ans Ende
  memory.delete(key);
  memory.set(key, e);
  return e.value;
}

function memorySet(key: string, value: string, ttlSeconds: number): void {
  memoryEvictIfNeeded();
  memory.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

/**
 * Liefert den gecachten Wert oder ruft `producer` auf und cached das Ergebnis.
 * `keyParts` dient zum Zusammensetzen des Cache-Keys (jeder Bestandteil
 * traegt zur Eindeutigkeit bei — z.B. ['translate', text, lang]).
 */
export async function cached<T extends string>(
  namespace: string,
  keyParts: string[],
  ttlSeconds: number,
  producer: () => Promise<T>,
): Promise<T> {
  if (redisInitPromise === null) redisInitPromise = initRedis();
  await redisInitPromise;

  const key = hashKey(namespace, keyParts);

  // Lookup
  if (redisClient && !redisDisabled) {
    try {
      const hit = await redisClient.get(key);
      if (hit !== null) return hit as T;
    } catch (e) {
      logger.warn(`responseCache: Redis-GET-Fehler: ${(e as Error).message}`);
    }
  } else {
    const hit = memoryGet(key);
    if (hit !== null) return hit as T;
  }

  // Miss -> produce
  const value = await producer();

  // Store (best-effort)
  if (redisClient && !redisDisabled) {
    try {
      await redisClient.set(key, value, { EX: ttlSeconds });
    } catch (e) {
      logger.warn(`responseCache: Redis-SET-Fehler: ${(e as Error).message}`);
    }
  } else {
    memorySet(key, value, ttlSeconds);
  }

  return value;
}

/** Test-Hilfen. */
export function __resetResponseCache(): void {
  memory.clear();
}
export function __getBackendForTests(): 'redis' | 'memory' {
  return redisClient && !redisDisabled ? 'redis' : 'memory';
}
