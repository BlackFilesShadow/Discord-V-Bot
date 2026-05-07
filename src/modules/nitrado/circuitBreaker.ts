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
 *   HALF_OPEN    -> nach `cooldownMs` einen Probe-Call zulassen. Erfolg ->
 *                   CLOSED; Fehler -> OPEN.
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
  failureThreshold: number;     // Fehler in Window -> OPEN
  rollingWindowMs: number;      // Window-Groesse fuer Failure-Count
  cooldownMs: number;           // Basisdauer im OPEN-Zustand
  cooldownMaxMs: number;        // Cap fuer exponentiellen Backoff
}

const DEFAULTS: BreakerOpts = {
  failureThreshold: 5,
  rollingWindowMs: 60_000,
  cooldownMs: 30_000,
  cooldownMaxMs: 300_000,
};

class NitradoCircuitBreaker {
  private state: State = 'CLOSED';
  private failureTimestamps: number[] = [];
  private openedAt = 0;
  private openStreak = 0; // wieviele Mal hintereinander OPEN -> exp. Backoff
  private currentCooldown: number;

  constructor(private readonly opts: BreakerOpts = DEFAULTS) {
    this.currentCooldown = this.opts.cooldownMs;
  }

  /**
   * Wirft `NitradoCircuitOpenError` wenn der Breaker offen ist.
   * Sollte VOR jedem HTTP-Aufruf in nitradoClient.request() gerufen werden.
   */
  preflight(): void {
    if (this.state === 'CLOSED') return;
    if (this.state === 'OPEN') {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed >= this.currentCooldown) {
        // Probe-Window: HALF_OPEN. Naechster Call ist der Probe-Call.
        this.state = 'HALF_OPEN';
        logger.info('NitradoCircuitBreaker: -> HALF_OPEN (probe call allowed)');
        return;
      }
      throw new NitradoCircuitOpenError(this.currentCooldown - elapsed);
    }
    // HALF_OPEN: ein Call ist erlaubt; recordSuccess()/recordFailure() schliesst/oeffnet wieder.
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

  /**
   * Rufe das nur fuer "echte" Server-Fehler (5xx, Timeouts, 429). 4xx<>429
   * sind Client-Fehler und sollen NICHT den Circuit kippen.
   */
  recordFailure(): void {
    const now = Date.now();
    this.failureTimestamps.push(now);
    // Sliding window
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

  /** Read-only Status fuer /admin oder Dashboard-Diagnostik. */
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

  /** Test-Helper: zurueck auf CLOSED. */
  reset(): void {
    this.state = 'CLOSED';
    this.failureTimestamps.length = 0;
    this.openedAt = 0;
    this.openStreak = 0;
    this.currentCooldown = this.opts.cooldownMs;
  }
}

// Singleton — alle NitradoClient-Instanzen teilen sich denselben Breaker.
// (Mehrere Tokens machen API-seitig keinen Unterschied: derselbe Endpoint.)
export const nitradoBreaker = new NitradoCircuitBreaker();
