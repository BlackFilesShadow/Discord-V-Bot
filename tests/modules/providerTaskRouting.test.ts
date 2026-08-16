process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    aiProviderStat: {
      findMany: jest.fn().mockResolvedValue([]),
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
      provider: 'openrouter',
      groqApiKey: 'groq-key',
      groqModel: 'openai/gpt-oss-120b',
      cerebrasApiKey: 'cerebras-key',
      cerebrasModel: 'gpt-oss-120b',
      openrouterApiKey: 'openrouter-key',
      openrouterModel: 'custom/company-secret-model',
      geminiApiKey: 'gemini-key',
      geminiModel: 'gemini-3.6-flash',
      openaiApiKey: 'openai-key',
      openaiModel: 'gpt-5.6-luna',
    },
  },
}));

import { config } from '../../src/config';
import {
  clearCooldown,
  getRankedProviders,
  markProviderUnavailable,
  type ProviderName,
} from '../../src/modules/ai/providerStats';

const ai = config.ai as unknown as Record<string, string>;
const initial = { ...ai };
const providers: ProviderName[] = ['groq', 'cerebras', 'openrouter', 'gemini', 'openai'];

function restoreConfig(): void {
  for (const key of Object.keys(ai)) delete ai[key];
  Object.assign(ai, initial);
  for (const provider of providers) clearCooldown(provider);
}

beforeEach(() => {
  restoreConfig();
});

afterAll(() => {
  restoreConfig();
});

describe('AI task-specific provider routing', () => {
  it('schliesst chat-only Custom-Modelle aus einem Structured-Task aus', async () => {
    const ranked = await getRankedProviders('structured');

    expect(ranked).toEqual(expect.arrayContaining(['groq', 'cerebras', 'gemini', 'openai']));
    expect(ranked).not.toContain('openrouter');
  });

  it('faellt fuer Spezialtasks ohne belegte Capability geschlossen aus', async () => {
    ai.groqApiKey = '';
    ai.cerebrasApiKey = '';
    ai.geminiApiKey = '';
    ai.openaiApiKey = '';
    ai.openrouterApiKey = 'openrouter-key';
    ai.openrouterModel = 'custom/company-secret-model';

    await expect(getRankedProviders('structured')).resolves.toEqual([]);
    await expect(getRankedProviders('tool')).resolves.toEqual([]);
    await expect(getRankedProviders('long_context')).resolves.toEqual([]);
  });

  it('erlaubt dasselbe Custom-Modell fuer normalen Chat', async () => {
    ai.groqApiKey = '';
    ai.cerebrasApiKey = '';
    ai.geminiApiKey = '';
    ai.openaiApiKey = '';
    ai.openrouterApiKey = 'openrouter-key';
    ai.openrouterModel = 'custom/company-secret-model';

    await expect(getRankedProviders('chat')).resolves.toEqual(['openrouter']);
  });

  it('respektiert Cooldown auch bei passender Capability', async () => {
    ai.cerebrasApiKey = '';
    ai.openrouterApiKey = '';
    ai.geminiApiKey = '';
    ai.openaiApiKey = '';
    ai.groqApiKey = 'groq-key';

    markProviderUnavailable('groq', 'test');
    await expect(getRankedProviders('reasoning')).resolves.toEqual([]);
  });
});
