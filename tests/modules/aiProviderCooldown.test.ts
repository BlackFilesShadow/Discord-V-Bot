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
} from '../../src/modules/ai/providerStats';

beforeEach(() => {
  clearCooldown('groq');
  clearCooldown('cerebras');
  clearCooldown('gemini');
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

  it('clearCooldown macht den Provider wieder verfuegbar', () => {
    markProviderUnavailable('groq', 'http_403');
    expect(isOnCooldown('groq')).toBe(true);
    clearCooldown('groq');
    expect(isOnCooldown('groq')).toBe(false);
  });
});
