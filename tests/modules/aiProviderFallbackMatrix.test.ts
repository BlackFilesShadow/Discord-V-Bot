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
      openrouterApiKey: 'openrouter-key',
      openrouterModel: 'custom/model',
      geminiApiKey: 'gemini-key',
      geminiModel: 'gemini-3.6-flash',
      openaiApiKey: 'openai-key',
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
  liveSearch: jest.fn(), looksFactQuestion: jest.fn(() => false), formatSearchResultsForPrompt: jest.fn(),
}));
jest.mock('../../src/modules/ai/commandCatalog', () => ({
  asksAboutCommands: jest.fn(() => false), formatCatalogForPromptFocused: jest.fn(),
}));
jest.mock('../../src/utils/rateLimiter', () => ({ checkRateLimit: jest.fn() }));
jest.mock('../../src/modules/ai/nitradoHelp', () => ({
  lookupNitradoHelp: jest.fn(() => ({ found: false, topicIds: [] })),
  looksLikeDayZFileQuestion: jest.fn(() => false),
  getDayZFileTruthBlock: jest.fn(() => ''),
  isDayzTechnicalAdminQuestion: jest.fn(() => false),
  validateDayzTechnicalAnswer: jest.fn(() => ({ valid: true, violations: [] })),
  buildDayzTechnicalFallback: jest.fn(() => ''),
}));
jest.mock('../../src/modules/nitrado/mirror/redactor', () => ({ redactText: (value: string) => value }));
jest.mock('../../src/utils/responseCache', () => ({ cached: jest.fn() }));
jest.mock('../../src/modules/ai/promptBudget', () => ({
  clampBlock: jest.fn((_kind: string, value: string) => value),
  clampHistory: jest.fn((value: unknown[]) => value),
}));
jest.mock('../../src/modules/ai/dayz129Catalog', () => ({ answerDayz129CatalogQuestion: jest.fn(() => null) }));

const mockRecordCall = jest.fn();
const mockGetRankedProviders = jest.fn();
const mockGetAllCooldowns = jest.fn();
const mockMarkProviderUnavailable = jest.fn();
const mockIsOnCooldown = jest.fn();

jest.mock('../../src/modules/ai/providerStats', () => ({
  __esModule: true,
  recordCall: (...args: unknown[]) => mockRecordCall(...args),
  getRankedProviders: (...args: unknown[]) => mockGetRankedProviders(...args),
  getAllCooldowns: (...args: unknown[]) => mockGetAllCooldowns(...args),
  markProviderUnavailable: (...args: unknown[]) => mockMarkProviderUnavailable(...args),
  getConfiguredModel: jest.fn((provider: string) => provider === 'openrouter' ? 'custom/model' : 'known-model'),
  isOnCooldown: (...args: unknown[]) => mockIsOnCooldown(...args),
}));

jest.mock('../../src/modules/ai/providerCapabilities', () => ({
  inferAiTaskProfile: jest.fn(() => 'chat'),
  providerSupportsTask: jest.fn(() => true),
}));

import axios from 'axios';
import { callAI } from '../../src/modules/ai/aiHandler';
import { classifyProviderHttpStatus, updateAllRateLimitedState } from '../../src/modules/ai/providerFailure';

const post = axios.post as jest.Mock;
const messages = [{ role: 'user', content: 'Hallo' }];

function ok(content = 'fallback-ok') {
  return { data: { choices: [{ message: { content } }] } };
}

function geminiOk(content = 'gemini-ok') {
  return { data: { candidates: [{ content: { parts: [{ text: content }] } }] } };
}

function httpError(status: number, headers: Record<string, string> = {}) {
  const error = new Error(`Request failed with status code ${status}`) as Error & {
    response: { status: number; headers: Record<string, string> };
  };
  error.response = { status, headers };
  return error;
}

function networkError(code: string, message: string) {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

describe('AI provider failure classification', () => {
  test.each([401, 403, 404])('HTTP %i ist permanent fuer den aktuellen Provider/Modellpfad', (status) => {
    expect(classifyProviderHttpStatus(status)).toEqual({ isRateLimit: false, isAuthOrModel: true });
  });

  it('429 ist ausschliesslich Rate-Limit', () => {
    expect(classifyProviderHttpStatus(429)).toEqual({ isRateLimit: true, isAuthOrModel: false });
  });

  it('5xx zerstoert den all-rate-limited Zustand', () => {
    expect(updateAllRateLimitedState(true, 429)).toBe(true);
    expect(updateAllRateLimitedState(true, 503)).toBe(false);
  });
});

describe('callAI circuit-breaker and fallback matrix', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRankedProviders.mockResolvedValue(['groq', 'cerebras']);
    mockGetAllCooldowns.mockReturnValue([]);
    mockIsOnCooldown.mockReturnValue(false);
  });

  test.each([401, 403, 404])('HTTP %i sperrt Provider ohne Same-Provider-Retry und faellt weiter', async (status) => {
    post.mockRejectedValueOnce(httpError(status)).mockResolvedValueOnce(ok());

    await expect(callAI(messages)).resolves.toBe('fallback-ok');

    expect(post).toHaveBeenCalledTimes(2);
    expect(String(post.mock.calls[0][0])).toContain('api.groq.com');
    expect(String(post.mock.calls[1][0])).toContain('api.cerebras.ai');
    expect(mockMarkProviderUnavailable).toHaveBeenCalledWith('groq', `http_${status}`);
    expect(mockRecordCall).toHaveBeenCalledWith('groq', 'failure', expect.any(Number), expect.any(String));
    expect(mockRecordCall).toHaveBeenCalledWith('cerebras', 'success', expect.any(Number));
  });

  it('behandelt 404 explizit wie Model-Removed/Endpoint-unavailable und probiert den Fallback', async () => {
    post.mockRejectedValueOnce(httpError(404)).mockResolvedValueOnce(ok('model-fallback'));

    await expect(callAI(messages)).resolves.toBe('model-fallback');
    expect(mockMarkProviderUnavailable).toHaveBeenCalledWith('groq', 'http_404');
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('uebernimmt Retry-After bei 429, retried denselben Provider nicht und faellt weiter', async () => {
    post.mockRejectedValueOnce(httpError(429, { 'retry-after': '2' })).mockResolvedValueOnce(ok());

    await expect(callAI(messages)).resolves.toBe('fallback-ok');

    expect(post).toHaveBeenCalledTimes(2);
    expect(String(post.mock.calls[0][0])).toContain('api.groq.com');
    expect(String(post.mock.calls[1][0])).toContain('api.cerebras.ai');
    expect(mockMarkProviderUnavailable).not.toHaveBeenCalled();
    expect(mockRecordCall).toHaveBeenCalledWith(
      'groq',
      'rateLimit',
      expect.any(Number),
      expect.any(String),
      { retryAfterMs: 2000 },
    );
  });

  it('liefert RATE_LIMIT nur wenn wirklich alle versuchten Provider 429 liefern', async () => {
    post.mockRejectedValueOnce(httpError(429)).mockRejectedValueOnce(httpError(429));

    await expect(callAI(messages)).rejects.toMatchObject({ code: 'RATE_LIMIT' });
    expect(post).toHaveBeenCalledTimes(2);
    expect(mockRecordCall).toHaveBeenCalledWith('groq', 'rateLimit', expect.any(Number), expect.any(String), { retryAfterMs: 0 });
    expect(mockRecordCall).toHaveBeenCalledWith('cerebras', 'rateLimit', expect.any(Number), expect.any(String), { retryAfterMs: 0 });
  });

  it('erholt sich nach all-provider-429 beim Folgerequest ueber einen verfuegbaren Chat-Fallback', async () => {
    mockGetRankedProviders
      .mockResolvedValueOnce(['groq', 'cerebras'])
      .mockResolvedValueOnce(['openrouter']);
    post
      .mockRejectedValueOnce(httpError(429))
      .mockRejectedValueOnce(httpError(429))
      .mockResolvedValueOnce(ok('recovered-via-openrouter'));

    await expect(callAI(messages)).rejects.toMatchObject({ code: 'RATE_LIMIT' });
    await expect(callAI([{ role: 'user', content: 'Was fuer ein Jahr haben wir heute?' }])).resolves.toBe('recovered-via-openrouter');

    expect(post).toHaveBeenCalledTimes(3);
    expect(String(post.mock.calls[2][0])).toContain('openrouter.ai');
  });

  it('behaelt RATE_LIMIT auch beim Folgerequest, wenn alle geeigneten Provider bereits im 429-Cooldown sind', async () => {
    mockGetRankedProviders.mockResolvedValue([]);
    mockIsOnCooldown.mockReturnValue(true);
    mockGetAllCooldowns.mockReturnValue([
      { provider: 'groq', remainingMs: 45_000, consecutive: 1 },
      { provider: 'cerebras', remainingMs: 60_000, consecutive: 1 },
    ]);

    await expect(callAI(messages)).rejects.toMatchObject({ code: 'RATE_LIMIT', retryAfterMs: 45_000 });
    expect(post).not.toHaveBeenCalled();
  });

  it('verwechselt leere Providerliste ohne aktiven 429-Cooldown nicht mit Rate-Limit', async () => {
    mockGetRankedProviders.mockResolvedValue([]);
    mockIsOnCooldown.mockReturnValue(true);
    mockGetAllCooldowns.mockReturnValue([]);

    await expect(callAI(messages)).rejects.not.toMatchObject({ code: 'RATE_LIMIT' });
    expect(post).not.toHaveBeenCalled();
  });

  it('sendet Gemini-3.x ohne deprecated Sampling-Parameter', async () => {
    mockGetRankedProviders.mockResolvedValue(['gemini']);
    post.mockResolvedValueOnce(geminiOk());

    await expect(callAI(messages)).resolves.toBe('gemini-ok');

    expect(post).toHaveBeenCalledTimes(1);
    expect(String(post.mock.calls[0][0])).toContain('generativelanguage.googleapis.com');
    const body = post.mock.calls[0][1] as { generationConfig?: Record<string, unknown> };
    expect(body.generationConfig).toEqual({ maxOutputTokens: 1500 });
    expect(body.generationConfig).not.toHaveProperty('temperature');
    expect(body.generationConfig).not.toHaveProperty('topP');
    expect(body.generationConfig).not.toHaveProperty('topK');
  });

  it('retried 503 genau einmal auf demselben Provider und akzeptiert danach Erfolg', async () => {
    post.mockRejectedValueOnce(httpError(503)).mockResolvedValueOnce(ok('retry-ok'));

    await expect(callAI(messages)).resolves.toBe('retry-ok');

    expect(post).toHaveBeenCalledTimes(2);
    expect(String(post.mock.calls[0][0])).toContain('api.groq.com');
    expect(String(post.mock.calls[1][0])).toContain('api.groq.com');
    expect(mockMarkProviderUnavailable).not.toHaveBeenCalled();
    expect(mockRecordCall).toHaveBeenCalledWith('groq', 'success', expect.any(Number));
    expect(mockRecordCall).not.toHaveBeenCalledWith('groq', 'failure', expect.anything(), expect.anything());
  });

  it('retried Timeout genau einmal und wechselt nach zweitem Fehler zum naechsten Provider', async () => {
    post
      .mockRejectedValueOnce(networkError('ETIMEDOUT', 'timeout'))
      .mockRejectedValueOnce(networkError('ETIMEDOUT', 'timeout'))
      .mockResolvedValueOnce(ok('timeout-fallback'));

    await expect(callAI(messages)).resolves.toBe('timeout-fallback');

    expect(post).toHaveBeenCalledTimes(3);
    expect(String(post.mock.calls[0][0])).toContain('api.groq.com');
    expect(String(post.mock.calls[1][0])).toContain('api.groq.com');
    expect(String(post.mock.calls[2][0])).toContain('api.cerebras.ai');
    expect(mockRecordCall).toHaveBeenCalledWith('groq', 'failure', expect.any(Number), 'timeout');
    expect(mockRecordCall).toHaveBeenCalledWith('cerebras', 'success', expect.any(Number));
  });

  it('verwechselt gemischte 429 + 5xx Fehler niemals mit all-rate-limited', async () => {
    post
      .mockRejectedValueOnce(httpError(429))
      .mockRejectedValueOnce(httpError(503))
      .mockRejectedValueOnce(httpError(503));

    try {
      await callAI(messages);
      throw new Error('expected callAI to fail');
    } catch (error) {
      expect((error as Error & { code?: string }).code).not.toBe('RATE_LIMIT');
      expect((error as Error).message).toContain('Kein AI-Provider verfügbar');
    }
    expect(post).toHaveBeenCalledTimes(3);
  });
});
