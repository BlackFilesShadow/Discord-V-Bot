jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    aiProviderStat: {
      findMany: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      upsert: jest.fn().mockResolvedValue({}),
    },
  },
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../src/config', () => ({
  __esModule: true,
  config: {
    ai: {
      provider: 'groq',
      groqApiKey: 'groq-key', groqModel: 'openai/gpt-oss-120b',
      cerebrasApiKey: 'cerebras-key', cerebrasModel: 'gpt-oss-120b',
      openrouterApiKey: 'openrouter-key', openrouterModel: 'custom/model',
      geminiApiKey: 'gemini-key', geminiModel: 'gemini-3.6-flash',
      openaiApiKey: 'openai-key', openaiModel: 'gpt-5.6-luna',
    },
  },
}));

import prisma from '../../src/database/prisma';
import {
  ALL_PROVIDERS,
  clearCooldown,
  getCooldownRemainingMs,
  hydrateCooldownsFromDb,
  isOnCooldown,
  markRateLimited,
  recordCall,
} from '../../src/modules/ai/providerStats';

const stats = prisma.aiProviderStat as unknown as {
  findMany: jest.Mock;
  update: jest.Mock;
  create: jest.Mock;
  updateMany: jest.Mock;
  upsert: jest.Mock;
};

beforeEach(async () => {
  for (const provider of ALL_PROVIDERS) clearCooldown(provider);
  await Promise.resolve();
  await Promise.resolve();
  jest.clearAllMocks();
});

describe('AI provider circuit-breaker restart lifecycle', () => {
  it('hydriert einen aktiven persistenten Cooldown nach Restart wieder in den Runtime-State', async () => {
    const until = new Date(Date.now() + 120_000);
    stats.findMany.mockResolvedValue([
      { provider: 'groq', cooldownUntil: until, cooldownStreak: 3 },
    ]);

    await hydrateCooldownsFromDb();

    expect(isOnCooldown('groq')).toBe(true);
    expect(getCooldownRemainingMs('groq')).toBeGreaterThan(100_000);
    expect(stats.updateMany).not.toHaveBeenCalled();
  });

  it('bereinigt abgelaufene persistente harte Circuits weiterhin vollstaendig', async () => {
    markRateLimited('cerebras', 120_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(isOnCooldown('cerebras')).toBe(true);

    const expired = new Date(Date.now() - 5_000);
    stats.findMany.mockResolvedValue([
      { provider: 'cerebras', cooldownUntil: expired, cooldownStreak: 4, cooldownReason: 'http_401' },
    ]);

    await hydrateCooldownsFromDb();

    expect(isOnCooldown('cerebras')).toBe(false);
    expect(stats.updateMany).toHaveBeenCalledTimes(1);
    expect(stats.updateMany).toHaveBeenCalledWith({
      where: {
        provider: { in: ['cerebras'] },
        cooldownUntil: { lte: expect.any(Date) },
      },
      data: { cooldownUntil: null, cooldownReason: null, cooldownStreak: 0 },
    });
  });

  it('behaelt einen abgelaufenen persistenten 429-Streak nach Restart ohne Routing-Sperre', async () => {
    stats.findMany.mockResolvedValue([
      {
        provider: 'groq',
        cooldownUntil: new Date(Date.now() - 5_000),
        cooldownStreak: 2,
        cooldownReason: '429_rate_limit',
      },
    ]);

    await hydrateCooldownsFromDb();

    expect(isOnCooldown('groq')).toBe(false);
    expect(getCooldownRemainingMs('groq')).toBe(0);
    expect(stats.updateMany).not.toHaveBeenCalled();

    await recordCall('groq', 'rateLimit', 87, 'HTTP 429');

    expect(getCooldownRemainingMs('groq')).toBeGreaterThan(110_000);
    expect(getCooldownRemainingMs('groq')).toBeLessThanOrEqual(120_000);
    expect(stats.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { provider: 'groq' },
      update: expect.objectContaining({ cooldownReason: '429_rate_limit', cooldownStreak: 3 }),
    }));
  });

  it('setzt einen behaltenen 429-Streak nach externem DB-Clear beim Sync zurueck', async () => {
    stats.findMany.mockResolvedValueOnce([
      {
        provider: 'groq',
        cooldownUntil: new Date(Date.now() - 5_000),
        cooldownStreak: 3,
        cooldownReason: '429_rate_limit',
      },
    ]);
    await hydrateCooldownsFromDb();

    stats.findMany.mockResolvedValueOnce([]);
    await hydrateCooldownsFromDb();

    expect(markRateLimited('groq')).toBe(30_000);
  });

  it('setzt bei Erfolg den persistenten Circuit atomar im Stat-Upsert zurueck', async () => {
    await recordCall('openai', 'success', 123);

    expect(stats.upsert).toHaveBeenCalledTimes(1);
    expect(stats.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { provider: 'openai' },
      update: expect.objectContaining({
        successCount: { increment: 1 },
        cooldownUntil: null,
        cooldownReason: null,
        cooldownStreak: 0,
      }),
    }));
    // recordCall(success) darf nicht auf einen vorher vorhandenen In-Memory-Circuit angewiesen sein.
    expect(stats.updateMany).not.toHaveBeenCalled();
  });

  it('persistiert 429-Circuit und Statistik gemeinsam in genau einem Upsert', async () => {
    await recordCall('groq', 'rateLimit', 87, 'HTTP 429', { retryAfterMs: 45_000 });

    expect(stats.upsert).toHaveBeenCalledTimes(1);
    expect(stats.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { provider: 'groq' },
      update: expect.objectContaining({
        rateLimitCount: { increment: 1 },
        cooldownUntil: expect.any(Date),
        cooldownReason: '429_rate_limit',
        cooldownStreak: 1,
      }),
      create: expect.objectContaining({
        provider: 'groq',
        rateLimitCount: 1,
        cooldownUntil: expect.any(Date),
        cooldownReason: '429_rate_limit',
        cooldownStreak: 1,
      }),
    }));
  });

  it('uebernimmt einen von einer anderen Instanz geloeschten DB-Circuit sofort', async () => {
    markRateLimited('cerebras', 120_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(isOnCooldown('cerebras')).toBe(true);

    stats.findMany.mockResolvedValue([]);
    await hydrateCooldownsFromDb();

    expect(isOnCooldown('cerebras')).toBe(false);
  });

  it('clearCooldown bereinigt persistent auch wenn lokal kein Circuit mehr existiert', () => {
    clearCooldown('gemini');

    expect(stats.updateMany).toHaveBeenCalledWith({
      where: { provider: 'gemini', cooldownUntil: { not: null } },
      data: { cooldownUntil: null, cooldownReason: null, cooldownStreak: 0 },
    });
  });
});
