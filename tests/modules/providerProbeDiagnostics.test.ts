jest.mock('axios', () => ({
  __esModule: true,
  default: { post: jest.fn() },
}));

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: { aiProviderStat: { findMany: jest.fn().mockResolvedValue([]) } },
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../src/modules/ai/aiObservability', () => ({
  recordAiFallback: jest.fn(),
  recordAiProviderAttempt: jest.fn(),
}));

jest.mock('../../src/modules/ai/providerRequestCompatibility', () => ({
  normalizeAiProviderRequest: jest.fn((_url: string, data: unknown) => data),
}));

jest.mock('../../src/config', () => ({
  __esModule: true,
  config: {
    ai: {
      provider: 'groq',
      groqApiKey: 'fixture-groq-api-key-not-real',
      groqModel: 'openai/gpt-oss-120b',
      cerebrasApiKey: 'fixture-cerebras-api-key-not-real',
      cerebrasModel: 'gpt-oss-120b',
      openrouterApiKey: 'fixture-openrouter-api-key-not-real',
      openrouterModel: 'openrouter/free',
      geminiApiKey: 'fixture-gemini-api-key-not-real',
      geminiModel: 'gemini-3.7-flash',
      openaiApiKey: 'fixture-openai-api-key-not-real',
      openaiModel: 'gpt-5.6-luna',
    },
  },
}));

import { createHash } from 'node:crypto';
import axios from 'axios';
import { config } from '../../src/config';
import { probeProvider, type ProviderName } from '../../src/modules/ai/providerStats';

const post = axios.post as jest.Mock;
const ai = config.ai as unknown as Record<string, string>;
const initialAi = { ...ai };
const PROVIDERS = [
  { provider: 'groq', keyField: 'groqApiKey', endpoint: 'https://api.groq.com/openai/v1/chat/completions' },
  { provider: 'cerebras', keyField: 'cerebrasApiKey', endpoint: 'https://api.cerebras.ai/v1/chat/completions' },
  { provider: 'openrouter', keyField: 'openrouterApiKey', endpoint: 'https://openrouter.ai/api/v1/chat/completions' },
  { provider: 'gemini', keyField: 'geminiApiKey', endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent' },
  { provider: 'openai', keyField: 'openaiApiKey', endpoint: 'https://api.openai.com/v1/chat/completions' },
] satisfies Array<{ provider: ProviderName; keyField: string; endpoint: string }>;

const RAW_ERROR_MESSAGE = 'raw-error-message-private-fixture';
const PRIVATE_BODY = 'private-provider-body-fixture';
const PRIVATE_PROMPT = 'private-request-prompt-fixture';
const REQUEST_ID = 'request-id-private-fixture';

function httpError(status: number, data: unknown, headers: Record<string, string> = {}) {
  return Object.assign(new Error(RAW_ERROR_MESSAGE), {
    code: 'ERR_BAD_RESPONSE',
    config: {
      headers: { Authorization: `Bearer ${ai.openaiApiKey}` },
      data: PRIVATE_PROMPT,
    },
    response: {
      status,
      headers: { Authorization: `Bearer ${ai.openaiApiKey}`, ...headers },
      data,
    },
  });
}

function expectSafeDiagnostic(result: Awaited<ReturnType<typeof probeProvider>>, extraSecrets: string[] = []): void {
  const json = JSON.stringify(result);
  for (const secret of [
    ...PROVIDERS.map(({ keyField }) => initialAi[keyField]),
    RAW_ERROR_MESSAGE,
    PRIVATE_BODY,
    PRIVATE_PROMPT,
    REQUEST_ID,
    ...extraSecrets,
  ]) {
    expect(json).not.toContain(secret);
  }
  expect(json.toLowerCase()).not.toContain('authorization');
  expect(json).not.toContain('Bearer ');
  expect(result).not.toHaveProperty('requestId');
  expect(result).not.toHaveProperty('response');
  expect(result).not.toHaveProperty('headers');
  expect(result).not.toHaveProperty('data');
  expect(result).not.toHaveProperty('config');
}

beforeEach(() => {
  Object.assign(ai, initialAi);
  post.mockReset();
  jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-30T12:00:00Z'));
});

afterEach(() => {
  Object.assign(ai, initialAi);
  jest.restoreAllMocks();
});

describe('AI provider probe diagnostics', () => {
  it.each(PROVIDERS)('sendet ohne $provider-Key keinen HTTP-Request', async ({ provider, keyField }) => {
    ai[keyField] = '';

    await expect(probeProvider(provider)).resolves.toEqual({
      ok: false,
      latencyMs: 0,
      error: 'Kein API-Key konfiguriert',
    });
    expect(post).not.toHaveBeenCalled();
  });

  it.each(PROVIDERS)('liefert ein erfolgreiches pong fuer $provider', async ({ provider, keyField, endpoint }) => {
    post.mockResolvedValueOnce(provider === 'gemini'
      ? { data: { candidates: [{ content: { parts: [{ text: ' \npong\t ' }] } }] } }
      : { data: { choices: [{ message: { content: ' \npong\t ' } }] } });

    const result = await probeProvider(provider);

    expect(result).toEqual({ ok: true, latencyMs: 0, reply: 'pong' });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      endpoint,
      expect.any(Object),
      expect.objectContaining({
        timeout: 10000,
        headers: expect.objectContaining(provider === 'gemini'
          ? { 'x-goog-api-key': ai[keyField] }
          : { Authorization: `Bearer ${ai[keyField]}` }),
      }),
    );
    expectSafeDiagnostic(result);
  });

  it('klassifiziert HTTP 429 insufficient_quota als Quota/Billing und gibt nur sichere Metadaten aus', async () => {
    post.mockRejectedValueOnce(httpError(429, {
      error: {
        code: 'insufficient_quota',
        type: 'invalid_request_error',
        message: `${PRIVATE_BODY} Authorization: Bearer ${ai.openaiApiKey}`,
      },
    }, { 'X-Request-ID': REQUEST_ID }));

    const result = await probeProvider('openai');

    expect(result).toEqual({
      ok: false,
      latencyMs: 0,
      error: 'http_429:insufficient_quota',
      classification: 'quota_or_billing',
      httpStatus: 429,
      providerCode: 'insufficient_quota',
      requestIdHash: createHash('sha256').update(REQUEST_ID).digest('hex').slice(0, 16),
    });
    expect(post).toHaveBeenCalledTimes(1);
    expectSafeDiagnostic(result);
  });

  it('klassifiziert einen temporaeren 429-Burst als Rate-Limit und uebernimmt Retry-After', async () => {
    post.mockRejectedValueOnce(httpError(429, {
      error: { code: 'rate_limit_exceeded', message: PRIVATE_BODY },
    }, { 'retry-after': '1.5' }));

    const result = await probeProvider('groq');

    expect(result).toEqual({
      ok: false,
      latencyMs: 0,
      error: 'http_429:rate_limit_exceeded',
      classification: 'rate_limit',
      httpStatus: 429,
      providerCode: 'rate_limit_exceeded',
      retryAfterMs: 1500,
    });
    expect(post).toHaveBeenCalledTimes(1);
    expectSafeDiagnostic(result);
  });

  it.each(['x-request-id', 'request-id', 'x-goog-request-id'])(
    'gibt %s ausschliesslich als deterministischen 16-stelligen Hash zurueck',
    async (header) => {
      post.mockRejectedValueOnce(httpError(503, {
        error: { code: 'service_unavailable', message: PRIVATE_BODY },
      }, { [header]: REQUEST_ID }));

      const result = await probeProvider(header === 'x-goog-request-id' ? 'gemini' : 'openai');

      expect(result).toMatchObject({
        ok: false,
        classification: 'transient',
        httpStatus: 503,
        error: 'http_503:service_unavailable',
        requestIdHash: createHash('sha256').update(REQUEST_ID).digest('hex').slice(0, 16),
      });
      expect(result.requestIdHash).toMatch(/^[a-f0-9]{16}$/);
      expectSafeDiagnostic(result);
    },
  );

  it('verwirft nicht allowlistete Provider-Codes und rohen Fehlerinhalt statt sie in Diagnose-JSON zu spiegeln', async () => {
    const injectedCode = 'secret-upstream-error-code-fixture';
    post.mockRejectedValueOnce(httpError(429, {
      error: {
        code: injectedCode,
        type: ai.openaiApiKey,
        message: `${PRIVATE_BODY} ${PRIVATE_PROMPT}`,
      },
    }, { 'request-id': REQUEST_ID, 'retry-after-ms': '750' }));

    const result = await probeProvider('openrouter');

    expect(result).toEqual({
      ok: false,
      latencyMs: 0,
      error: 'http_429',
      classification: 'rate_limit',
      httpStatus: 429,
      retryAfterMs: 750,
      requestIdHash: createHash('sha256').update(REQUEST_ID).digest('hex').slice(0, 16),
    });
    expect(result).not.toHaveProperty('providerCode');
    expectSafeDiagnostic(result, [injectedCode]);
  });

  it('gibt bei einem Fehler ohne HTTP-Antwort niemals rawError.message oder einen beliebigen Fehlercode aus', async () => {
    const unknownCode = 'private-network-error-code-fixture';
    post.mockRejectedValueOnce(Object.assign(new Error(`${RAW_ERROR_MESSAGE} ${ai.openaiApiKey}`), {
      code: unknownCode,
      config: { headers: { Authorization: `Bearer ${ai.openaiApiKey}` }, data: PRIVATE_PROMPT },
    }));

    const result = await probeProvider('openai');

    expect(result).toEqual({
      ok: false,
      latencyMs: 0,
      error: 'provider_error',
      classification: 'unknown',
    });
    expectSafeDiagnostic(result, [unknownCode]);
  });
});
