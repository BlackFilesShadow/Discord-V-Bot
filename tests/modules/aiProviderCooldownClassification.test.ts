jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    aiProviderStat: {
      findMany: jest.fn(),
      upsert: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
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
      openrouterApiKey: 'openrouter-key', openrouterModel: 'openrouter/free',
      geminiApiKey: 'gemini-key', geminiModel: 'gemini-3.7-flash',
      openaiApiKey: 'openai-key', openaiModel: 'gpt-5.6-luna',
    },
  },
}));

jest.mock('../../src/modules/ai/providerCapabilities', () => ({
  providerSupportsTask: jest.fn(() => true),
  taskAffinity: jest.fn(() => 1),
}));

jest.mock('../../src/modules/ai/aiObservability', () => ({
  recordAiFallback: jest.fn(),
  recordAiProviderAttempt: jest.fn(),
}));

jest.mock('../../src/modules/ai/providerRequestCompatibility', () => ({
  normalizeAiProviderRequest: jest.fn((_url: string, data: unknown) => data),
}));

import prisma from '../../src/database/prisma';
import {
  ALL_PROVIDERS,
  clearCooldown,
  getAllCooldowns,
  getCooldownRemainingMs,
  hydrateCooldownsFromDb,
  isOnCooldown,
  markProviderUnavailable,
  markRateLimited,
} from '../../src/modules/ai/providerStats';

const stats = prisma.aiProviderStat as unknown as {
  findMany: jest.Mock;
  upsert: jest.Mock;
  updateMany: jest.Mock;
};

beforeEach(async () => {
  for (const provider of ALL_PROVIDERS) clearCooldown(provider);
  await Promise.resolve();
  await Promise.resolve();
  jest.clearAllMocks();
  stats.findMany.mockResolvedValue([]);
});

describe('AI provider cooldown classification', () => {
  it('blockiert Auth-/Modellfehler fuer Routing, meldet sie aber nicht als 429-Rate-Limit', () => {
    markProviderUnavailable('groq', 'http_401');

    expect(isOnCooldown('groq')).toBe(true);
    expect(getAllCooldowns().some(entry => entry.provider === 'groq')).toBe(false);
  });

  it('liefert echte 429-Cooldowns weiterhin an den Rate-Limit-Fallback', () => {
    markRateLimited('cerebras', 45_000);

    expect(isOnCooldown('cerebras')).toBe(true);
    expect(getAllCooldowns()).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'cerebras' }),
    ]));
  });

  it('kuerzt einen expliziten langen Retry-After nicht auf den 5-Minuten-Backoff', () => {
    markRateLimited('openrouter', 30 * 60_000);

    const remaining = getCooldownRemainingMs('openrouter');
    expect(remaining).toBeGreaterThan(25 * 60_000);
    expect(remaining).toBeLessThanOrEqual(30 * 60_000);
  });

  it('rehydriert einen persistenten Auth-/Modell-Circuit getrennt von echten 429-Cooldowns', async () => {
    stats.findMany.mockResolvedValue([
      {
        provider: 'openai',
        cooldownUntil: new Date(Date.now() + 10 * 60_000),
        cooldownStreak: 2,
        cooldownReason: 'http_404',
      },
    ]);

    await hydrateCooldownsFromDb();

    expect(isOnCooldown('openai')).toBe(true);
    expect(getAllCooldowns().some(entry => entry.provider === 'openai')).toBe(false);
  });
});
