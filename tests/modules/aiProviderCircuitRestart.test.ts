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
  recordCall,
} from '../../src/modules/ai/providerStats';

const stats = prisma.aiProviderStat as unknown as {
  findMany: jest.Mock;
  update: jest.Mock;
  create: jest.Mock;
  updateMany: jest.Mock;
  upsert: jest.Mock;
};

beforeEach(() => {
  for (const provider of ALL_PROVIDERS) clearCooldown(provider);
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

  it('bereinigt abgelaufene persistente Cooldowns statt stale DB-Zustand mitzuschleppen', async () => {
    const expired = new Date(Date.now() - 5_000);
    stats.findMany.mockResolvedValue([
      { provider: 'cerebras', cooldownUntil: expired, cooldownStreak: 4 },
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

  it('clearCooldown bereinigt persistent auch wenn lokal kein Circuit mehr existiert', () => {
    clearCooldown('gemini');

    expect(stats.updateMany).toHaveBeenCalledWith({
      where: { provider: 'gemini', cooldownUntil: { not: null } },
      data: { cooldownUntil: null, cooldownReason: null, cooldownStreak: 0 },
    });
  });
});
