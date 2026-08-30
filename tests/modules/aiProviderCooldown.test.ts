process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

/**
 * AI-Provider-Cooldowns (Root-Cause-Fix):
 *  - Auth-/Modell-Fehler (401/403/404) nehmen den Provider LANGE aus der Rotation
 *    (markProviderUnavailable), damit ein kaputter Key nicht als „letzter
 *    Ueberlebender" alle Anfragen scheitern laesst.
 *  - 429 nutzt Retry-After (gedeckelt), sonst exponentiellen Backoff.
 */

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    aiProviderStat: {
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
      upsert: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  },
}));
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
  markRateLimited, markProviderUnavailable, isOnCooldown, getCooldownRemainingMs, clearCooldown,
  recordCall,
} from '../../src/modules/ai/providerStats';

beforeEach(() => {
  clearCooldown('groq');
  clearCooldown('cerebras');
  clearCooldown('gemini');
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('AI-Provider-Cooldowns', () => {
  it('nimmt Provider bei Auth-Fehler lange (>=10min) aus der Rotation', () => {
    expect(isOnCooldown('cerebras')).toBe(false);
    markProviderUnavailable('cerebras', 'http_401');
    expect(isOnCooldown('cerebras')).toBe(true);
    expect(getCooldownRemainingMs('cerebras')).toBeGreaterThan(10 * 60_000);
  });

  it('nutzt Retry-After bei 429 (gedeckelt, min. 1s)', () => {
    markRateLimited('groq', 2_000);
    const rem = getCooldownRemainingMs('groq');
    expect(rem).toBeGreaterThan(1_000);
    expect(rem).toBeLessThanOrEqual(2_000);
  });

  it('faellt ohne Retry-After auf den 30s-Basis-Backoff zurueck', () => {
    markRateLimited('gemini');
    const rem = getCooldownRemainingMs('gemini');
    expect(rem).toBeGreaterThan(25_000);
    expect(rem).toBeLessThanOrEqual(30_000);
  });

  it('erhoeht den 429-Backoff nach natuerlichem Ablauf bis maximal fuenf Minuten', () => {
    let now = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => now);

    for (const expectedMs of [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]) {
      expect(markRateLimited('groq')).toBe(expectedMs);
      expect(isOnCooldown('groq')).toBe(true);
      now += expectedMs;
      expect(isOnCooldown('groq')).toBe(false);
      expect(getCooldownRemainingMs('groq')).toBe(0);
    }
  });

  it('behaelt den 429-Streak auch nach Ablauf eines expliziten Retry-After', () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);

    expect(markRateLimited('gemini', 2_000)).toBe(2_000);
    clock.mockReturnValue(now + 2_000);
    expect(isOnCooldown('gemini')).toBe(false);
    expect(markRateLimited('gemini')).toBe(60_000);
  });

  it('setzt den abgelaufenen 429-Streak nach einem erfolgreichen Call zurueck', async () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    markRateLimited('groq');
    clock.mockReturnValue(now + 30_000);
    expect(isOnCooldown('groq')).toBe(false);

    await recordCall('groq', 'success', 123);

    expect(markRateLimited('groq')).toBe(30_000);
  });

  it('setzt den abgelaufenen 429-Streak durch explizites clearCooldown zurueck', () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    markRateLimited('groq');
    clock.mockReturnValue(now + 30_000);
    expect(isOnCooldown('groq')).toBe(false);

    clearCooldown('groq');

    expect(markRateLimited('groq')).toBe(30_000);
  });

  it('clearCooldown macht den Provider wieder verfuegbar', () => {
    markProviderUnavailable('groq', 'http_403');
    expect(isOnCooldown('groq')).toBe(true);
    clearCooldown('groq');
    expect(isOnCooldown('groq')).toBe(false);
  });
});
