jest.mock('axios', () => ({
  __esModule: true,
  default: { post: jest.fn() },
}));

jest.mock('../../src/config', () => ({
  __esModule: true,
  config: {
    ai: {
      provider: 'groq',
      groqApiKey: 'groq-key',
      groqModel: 'openai/gpt-oss-120b',
      cerebrasApiKey: 'cerebras-key',
      cerebrasModel: 'gpt-oss-120b',
      openrouterApiKey: '',
      openrouterModel: 'openrouter/free',
      geminiApiKey: '',
      geminiModel: 'gemini-3.7-flash',
      openaiApiKey: '',
      openaiModel: 'gpt-5.6-luna',
    },
  },
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: { aiAnalysis: { create: jest.fn() } },
}));

jest.mock('../../src/modules/ai/webSearch', () => ({
  liveSearch: jest.fn(),
  looksFactQuestion: jest.fn(() => false),
  formatSearchResultsForPrompt: jest.fn(),
}));

jest.mock('../../src/modules/ai/commandCatalog', () => ({
  asksAboutCommands: jest.fn(() => false),
  formatCatalogForPromptFocused: jest.fn(),
}));

jest.mock('../../src/utils/rateLimiter', () => ({
  checkRateLimit: jest.fn(async () => ({ allowed: true, resetAt: new Date(Date.now() + 60_000) })),
}));

jest.mock('../../src/modules/ai/nitradoHelp', () => ({
  lookupNitradoHelp: jest.fn(() => ({ found: false, topicIds: [] })),
  looksLikeDayZFileQuestion: jest.fn(() => false),
  getDayZFileTruthBlock: jest.fn(() => ''),
  isDayzTechnicalAdminQuestion: jest.fn(() => false),
  validateDayzTechnicalAnswer: jest.fn(() => ({ valid: true, violations: [] })),
  buildDayzTechnicalFallback: jest.fn(() => ''),
}));

jest.mock('../../src/modules/nitrado/mirror/redactor', () => ({
  redactText: (value: string) => value,
}));

jest.mock('../../src/utils/responseCache', () => ({ cached: jest.fn() }));

jest.mock('../../src/modules/ai/promptBudget', () => ({
  clampBlock: jest.fn((_kind: string, value: string) => value),
  clampHistory: jest.fn((value: unknown[]) => value),
  getTotalPromptBudget: jest.fn(() => 32_000),
}));

jest.mock('../../src/modules/ai/dayz129Catalog', () => ({
  answerDayz129CatalogQuestion: jest.fn(() => null),
}));

jest.mock('../../src/modules/ai/conversationIntent', () => ({
  classifyAiConversationDomain: jest.fn(() => 'general'),
  filterCompatibleMemoryTurns: jest.fn((_question: string, turns: unknown[]) => turns),
  isDayzConversationDomain: jest.fn(() => false),
  mayUseExternalConversationContext: jest.fn(() => false),
}));

jest.mock('../../src/modules/ai/dayzHallucinationGuard', () => ({
  buildHallucinationGuardFallback: jest.fn(() => ''),
  consumeHallucinationGuardReference: jest.fn(() => ({ context: null, guard: null })),
  formatHallucinationGuardPrompt: jest.fn(() => ''),
  preflightLiveServerQuestion: jest.fn(() => ({ handled: false })),
  validateLiveServerAnswer: jest.fn(() => ({ valid: true, violations: [] })),
}));

jest.mock('../../src/modules/ai/liveTime', () => ({
  answerLiveTimeQuestion: jest.fn(() => null),
  buildLiveTimeContext: jest.fn(() => 'ZEITKONTEXT'),
}));

jest.mock('../../src/modules/ai/providerRequestCompatibility', () => ({
  normalizeAiProviderRequest: jest.fn((_url: string, body: unknown) => body),
}));

const recordCall = jest.fn();
const markProviderUnavailable = jest.fn();

jest.mock('../../src/modules/ai/providerStats', () => ({
  __esModule: true,
  recordCall: (...args: unknown[]) => recordCall(...args),
  getRankedProviders: jest.fn(async () => ['groq', 'cerebras']),
  getConfiguredModel: jest.fn((provider: string) => provider === 'groq' ? 'openai/gpt-oss-120b' : 'gpt-oss-120b'),
  getAllCooldowns: jest.fn(() => []),
  isOnCooldown: jest.fn(() => false),
  markProviderUnavailable: (...args: unknown[]) => markProviderUnavailable(...args),
}));

jest.mock('../../src/modules/ai/providerCapabilities', () => ({
  inferAiTaskProfile: jest.fn(() => 'chat'),
  providerSupportsTask: jest.fn(() => true),
}));

import axios from 'axios';
import { answerQuestion } from '../../src/modules/ai/aiHandler';

const post = axios.post as jest.Mock;

function httpError(status: number) {
  const error = new Error(`Request failed with status code ${status}`) as Error & {
    response: { status: number; headers: Record<string, string> };
  };
  error.response = { status, headers: {} };
  return error;
}

describe('answerQuestion provider failure mapping', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('meldet 402 + 429 nicht als globales Provider-Rate-Limit', async () => {
    post
      .mockRejectedValueOnce(httpError(402))
      .mockRejectedValueOnce(httpError(429));

    const result = await answerQuestion('Kannst du mir einen guten Kuchen empfehlen?');

    expect(result).toEqual({ success: false, error: 'AI nicht verfügbar.' });
    expect(markProviderUnavailable).toHaveBeenCalledWith('groq', 'http_402');
    expect(recordCall).toHaveBeenCalledWith('groq', 'failure', expect.any(Number), expect.any(String));
    expect(recordCall).toHaveBeenCalledWith('cerebras', 'rateLimit', expect.any(Number), expect.any(String), { retryAfterMs: 0 });
  });
});
