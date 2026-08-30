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

const mockGetRecentTurns = jest.fn();
jest.mock('../../src/modules/ai/conversationMemory', () => ({
  getRecentTurns: (...args: unknown[]) => mockGetRecentTurns(...args),
  recordTurn: jest.fn(async () => undefined),
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
  shouldIncludeLiveTimeContext: jest.fn(() => false),
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
  getCooldownRemainingMs: jest.fn(() => 0),
  isOnCooldown: jest.fn(() => false),
  markProviderUnavailable: (...args: unknown[]) => markProviderUnavailable(...args),
}));

jest.mock('../../src/modules/ai/providerCapabilities', () => ({
  inferAiTaskProfile: jest.fn(() => 'chat'),
  providerSupportsTask: jest.fn(() => true),
}));

import axios from 'axios';
import { answerQuestion, BOT_PERSONA } from '../../src/modules/ai/aiHandler';

const post = axios.post as jest.Mock;

function httpError(status: number, data?: unknown) {
  const error = new Error(`Request failed with status code ${status}`) as Error & {
    response: { status: number; headers: Record<string, string>; data?: unknown };
  };
  error.response = { status, headers: {}, data };
  return error;
}

describe('answerQuestion provider failure mapping', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRecentTurns.mockResolvedValue([]);
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

  it('meldet 429 insufficient_quota + transienten 429 nicht als globales Rate-Limit', async () => {
    post
      .mockRejectedValueOnce(httpError(429, { error: { code: 'insufficient_quota' } }))
      .mockRejectedValueOnce(httpError(429));

    const result = await answerQuestion('Kannst du mir einen guten Kuchen empfehlen?');

    expect(result).toEqual({ success: false, error: 'AI nicht verfügbar.' });
    expect(markProviderUnavailable).toHaveBeenCalledWith('groq', 'provider_insufficient_quota');
  });

  it.each([
    ['hey', 'Hey! Was kann ich für dich tun?'],
    ['ich hab ne frage', 'Klar – stell deine Frage einfach.'],
  ])('beantwortet den Screenshot-Gespraechsoeffner lokal: %s', async (question, expected) => {
    const result = await answerQuestion(question);

    expect(result).toEqual({ success: true, result: expected });
    expect(post).not.toHaveBeenCalled();
    expect(recordCall).not.toHaveBeenCalled();
  });

  it('sendet eine inhaltliche Frage weiterhin an den Provider, ohne unnoetigen Zeitblock', async () => {
    post.mockResolvedValueOnce({ data: { choices: [{ message: { content: 'Eine inhaltliche Antwort.' } }] } });

    const result = await answerQuestion('Hey, wie funktioniert Photosynthese?');

    expect(result).toEqual({ success: true, result: 'Eine inhaltliche Antwort.' });
    expect(post).toHaveBeenCalledTimes(1);
    const body = post.mock.calls[0][1] as { messages: Array<{ role: string; content: string }> };
    expect(body.messages.some(message => message.content === 'ZEITKONTEXT')).toBe(false);
    expect(body.messages.at(-1)?.content).toBe('Hey, wie funktioniert Photosynthese?');
  });

  it('behaelt bei referentiellen Guild-Folgefragen die volle Sicherheits-Persona', async () => {
    mockGetRecentTurns.mockResolvedValue([
      { role: 'user', content: 'Welche Rollen gibt es?' },
      { role: 'assistant', content: 'Es gibt die öffentliche Community-Rolle.' },
    ]);
    post.mockResolvedValueOnce({ data: { choices: [{ message: { content: 'Mehr zur Community-Rolle.' } }] } });

    const result = await answerQuestion('Mehr dazu.', {
      userId: 'test-user', channelId: 'test-channel', guildId: 'test-guild',
    });

    expect(result.success).toBe(true);
    const body = post.mock.calls[0][1] as { messages: Array<{ role: string; content: string }> };
    expect(body.messages[0].content).toBe(BOT_PERSONA);
    expect(body.messages[0].content).toContain('KANAL-SICHERHEIT');
  });
});
