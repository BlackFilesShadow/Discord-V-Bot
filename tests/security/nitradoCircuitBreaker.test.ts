import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { NitradoCircuitOpenError, nitradoBreaker } from '../../src/modules/nitrado/circuitBreaker';

describe('NitradoCircuitBreaker', () => {
  beforeEach(() => {
    nitradoBreaker.reset();
  });

  afterEach(() => {
    jest.useRealTimers();
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

  it('laesst nach Cooldown exakt einen HALF_OPEN-Probe-Call zu und blockiert parallele Caller', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-19T02:00:00.000Z'));

    for (let i = 0; i < 5; i++) nitradoBreaker.recordFailure();
    expect(nitradoBreaker.getStatus().state).toBe('OPEN');

    jest.advanceTimersByTime(30_000);
    expect(() => nitradoBreaker.preflight()).not.toThrow();
    expect(nitradoBreaker.getStatus().state).toBe('HALF_OPEN');

    expect(() => nitradoBreaker.preflight()).toThrow(NitradoCircuitOpenError);

    nitradoBreaker.recordSuccess();
    expect(nitradoBreaker.getStatus().state).toBe('CLOSED');
    expect(() => nitradoBreaker.preflight()).not.toThrow();
  });

  it('HALF_OPEN-Fehler oeffnet sofort erneut und erhoeht den Cooldown-Streak', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-19T02:00:00.000Z'));

    for (let i = 0; i < 5; i++) nitradoBreaker.recordFailure();
    jest.advanceTimersByTime(30_000);
    nitradoBreaker.preflight();
    expect(nitradoBreaker.getStatus().state).toBe('HALF_OPEN');

    nitradoBreaker.recordFailure();
    expect(nitradoBreaker.getStatus().state).toBe('OPEN');
    expect(nitradoBreaker.getStatus().openStreak).toBe(2);
    expect(nitradoBreaker.getStatus().cooldownRemainingMs).toBe(60_000);
  });

  it('recordSuccess() schliesst auch einen offenen/probenden Circuit + reset Streak', () => {
    for (let i = 0; i < 5; i++) nitradoBreaker.recordFailure();
    expect(nitradoBreaker.getStatus().state).toBe('OPEN');

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
