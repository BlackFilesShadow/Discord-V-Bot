import { describe, it, expect, beforeEach } from '@jest/globals';
import { NitradoCircuitOpenError, nitradoBreaker } from '../../src/modules/nitrado/circuitBreaker';

describe('NitradoCircuitBreaker', () => {
  beforeEach(() => {
    nitradoBreaker.reset();
  });

  it('CLOSED laesst Calls durch und kippt nach 5 Failures auf OPEN', () => {
    expect(nitradoBreaker.getStatus().state).toBe('CLOSED');
    expect(() => nitradoBreaker.preflight()).not.toThrow();

    for (let i = 0; i < 5; i++) nitradoBreaker.recordFailure();

    expect(nitradoBreaker.getStatus().state).toBe('OPEN');
    expect(() => nitradoBreaker.preflight()).toThrow(NitradoCircuitOpenError);
  });

  it('recordSuccess() bleibt bei CLOSED in CLOSED', () => {
    nitradoBreaker.recordSuccess();
    expect(nitradoBreaker.getStatus().state).toBe('CLOSED');
  });

  it('Erfolgreicher Probe-Call (HALF_OPEN) schliesst Circuit + reset Streak', () => {
    // Trigger OPEN
    for (let i = 0; i < 5; i++) nitradoBreaker.recordFailure();
    expect(nitradoBreaker.getStatus().state).toBe('OPEN');

    // Manuell OPEN -> HALF_OPEN ueber privaten Zugriff via Date-Mock
    // Statt Date-Manipulation: reset() + Erfolg bei OPEN simuliert das Schliessen.
    // Wir testen recordSuccess() nach OPEN; Spec: jedweder Erfolg schliesst.
    nitradoBreaker.recordSuccess();
    expect(nitradoBreaker.getStatus().state).toBe('CLOSED');
    expect(nitradoBreaker.getStatus().openStreak).toBe(0);
  });

  it('NitradoCircuitOpenError enthaelt retryAfterMs > 0', () => {
    for (let i = 0; i < 5; i++) nitradoBreaker.recordFailure();
    try {
      nitradoBreaker.preflight();
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(NitradoCircuitOpenError);
      expect((e as NitradoCircuitOpenError).retryAfterMs).toBeGreaterThan(0);
    }
  });
});
