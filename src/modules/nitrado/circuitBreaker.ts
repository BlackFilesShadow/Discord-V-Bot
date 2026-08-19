/**
 * Nitrado Circuit-Breaker.
 *
 * Zweck (P0-Hardening): Schutz vor Thundering-Herd, wenn Nitrado-API laenger
 * ausfaellt. Statt fortwaehrend HTTP-Calls + Retries (3x500/1000/2000ms) zu
 * fahren, faellt der Breaker nach `failureThreshold` Fehlern in einem
 * Rolling-Window in den `OPEN`-Zustand und blockt sofort fuer `cooldownMs`.
 *
 * State-Machine (klassisch):
 *   CLOSED       -> normaler Betrieb. Fehler werden gezaehlt.
 *   OPEN         -> Calls werden ohne HTTP-Versuch sofort mit
 *                   NitradoCircuitOpenError abgewiesen.
 *   HALF_OPEN    -> nach `cooldownMs` exakt einen Probe-Call zulassen. Erfolg ->
 *                   CLOSED; Fehler -> OPEN. Parallele Calls bleiben geblockt.
 *
 * Implementierung:
 *   - in-memory, pro Prozess (kein Multi-Replica-Sharing — Nitrado-Outage
 *     trifft alle Replicas gleichzeitig, Pro-Replica-Breaker reicht).
 *   - failureThreshold default 5 in 60s.
 *   - cooldownMs default 30s; bei wiederholtem OPEN -> exp. Backoff bis 5min.
 *   - 4xx-Fehler (429 ausgenommen) zaehlen NICHT als Circuit-Failure
 *     (Client-Fehler, Server lebt).
 */
import { logger } from '../../utils/logger';

export class NitradoCircuitOpenError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`Nitrado circuit breaker is OPEN — retry in ${Math.round(retryAfterMs / 1000)}s`);
    this.name = 'NitradoCircuitOpenError';
  }
}

type State = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface BreakerOpts {
  failureThreshold: number;
  rollingWindowMs: number;
  cooldownMs: number;
  cooldownMaxMs: number;
}

const DEFAULTS: BreakerOpts = {
  failureThreshold: 5,
  rollingWindowMs: 60_000,
  cooldownMs: 30_000,
  cooldownMaxMs: 300_000,
};

const HALF_OPEN_PROBE_RETRY_MS = 1_000;

class NitradoCircuitBreaker {
  private state: State = 'CLOSED';
  private failureTimestamps: number[] = [];
  private openedAt = 0;
  private openStreak = 0;
  private currentCooldown: number;

  constructor(private readonly opts: BreakerOpts = DEFAULTS) {
    this.currentCooldown = this.opts.cooldownMs;
  }

  preflight(): void {
    if (this.state === 'CLOSED') return;
    if (this.state === 'OPEN') {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed >= this.currentCooldown) {
        this.state = 'HALF_OPEN';
        logger.info('NitradoCircuitBreaker: -> HALF_OPEN (single probe call allowed)');
        return;
      }
      throw new NitradoCircuitOpenError(this.currentCooldown - elapsed);
    }

    throw new NitradoCircuitOpenError(HALF_OPEN_PROBE_RETRY_MS);
  }

  recordSuccess(): void {
    if (this.state === 'HALF_OPEN' || this.state === 'OPEN') {
      logger.info(`NitradoCircuitBreaker: ${this.state} -> CLOSED (probe success)`);
    }
    this.state = 'CLOSED';
    this.failureTimestamps.length = 0;
    this.openStreak = 0;
    this.currentCooldown = this.opts.cooldownMs;
  }

  recordFailure(): void {
    const now = Date.now();
    this.failureTimestamps.push(now);
    const cutoff = now - this.opts.rollingWindowMs;
    this.failureTimestamps = this.failureTimestamps.filter(t => t >= cutoff);

    if (this.state === 'HALF_OPEN') {
      this.trip(now);
      return;
    }
    if (this.failureTimestamps.length >= this.opts.failureThreshold) {
      this.trip(now);
    }
  }

  private trip(now: number): void {
    this.openStreak += 1;
    this.currentCooldown = Math.min(
      this.opts.cooldownMs * Math.pow(2, this.openStreak - 1),
      this.opts.cooldownMaxMs,
    );
    this.openedAt = now;
    this.state = 'OPEN';
    this.failureTimestamps.length = 0;
    logger.warn(`NitradoCircuitBreaker: -> OPEN (${this.openStreak}x in a row, cooldown ${Math.round(this.currentCooldown / 1000)}s)`);
  }

  getStatus(): { state: State; failures: number; openStreak: number; cooldownRemainingMs: number } {
    let cooldownRemainingMs = 0;
    if (this.state === 'OPEN') {
      cooldownRemainingMs = Math.max(0, this.currentCooldown - (Date.now() - this.openedAt));
    }
    return {
      state: this.state,
      failures: this.failureTimestamps.length,
      openStreak: this.openStreak,
      cooldownRemainingMs,
    };
  }

  reset(): void {
    this.state = 'CLOSED';
    this.failureTimestamps.length = 0;
    this.openedAt = 0;
    this.openStreak = 0;
    this.currentCooldown = this.opts.cooldownMs;
  }
}

export type NitradoOpClass = 'READ' | 'WRITE';

const breakers: Record<NitradoOpClass, NitradoCircuitBreaker> = {
  READ: new NitradoCircuitBreaker(),
  WRITE: new NitradoCircuitBreaker(),
};

export function opClassForMethod(method: string): NitradoOpClass {
  return method.toUpperCase() === 'GET' ? 'READ' : 'WRITE';
}

export function getNitradoBreaker(op: NitradoOpClass): NitradoCircuitBreaker {
  return breakers[op];
}

export function getNitradoBreakerStatus(): Record<NitradoOpClass, ReturnType<NitradoCircuitBreaker['getStatus']>> {
  return { READ: breakers.READ.getStatus(), WRITE: breakers.WRITE.getStatus() };
}

export function resetAllNitradoBreakers(): void {
  breakers.READ.reset();
  breakers.WRITE.reset();
}

export const nitradoBreaker = breakers.READ;
