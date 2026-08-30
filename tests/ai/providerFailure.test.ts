import {
  classifyProviderError,
  classifyProviderHttpStatus,
  parseProviderRetryAfterMs,
  safeProviderFailureLabel,
  updateAllRateLimitedState,
} from '../../src/modules/ai/providerFailure';

describe('AI provider failure classification', () => {
  it('klassifiziert ausschliesslich HTTP 429 als Rate-Limit', () => {
    expect(classifyProviderHttpStatus(429)).toEqual({ isRateLimit: true, isAuthOrModel: false });
    expect(classifyProviderHttpStatus(401)).toEqual({ isRateLimit: false, isAuthOrModel: true });
    expect(classifyProviderHttpStatus(403)).toEqual({ isRateLimit: false, isAuthOrModel: true });
    expect(classifyProviderHttpStatus(404)).toEqual({ isRateLimit: false, isAuthOrModel: true });
    expect(classifyProviderHttpStatus(500)).toEqual({ isRateLimit: false, isAuthOrModel: false });
    expect(classifyProviderHttpStatus(undefined)).toEqual({ isRateLimit: false, isAuthOrModel: false });
  });

  it('laesst allRateLimited nur bei einer reinen 429-Kette true', () => {
    let allRateLimited = true;
    allRateLimited = updateAllRateLimitedState(allRateLimited, 429);
    expect(allRateLimited).toBe(true);
    allRateLimited = updateAllRateLimitedState(allRateLimited, 429);
    expect(allRateLimited).toBe(true);
  });

  it.each([401, 403, 404, 500, undefined])(
    'ein Nicht-429 (%s) widerlegt allRateLimited dauerhaft',
    (status) => {
      let allRateLimited = updateAllRateLimitedState(true, 429);
      allRateLimited = updateAllRateLimitedState(allRateLimited, status);
      expect(allRateLimited).toBe(false);
      allRateLimited = updateAllRateLimitedState(allRateLimited, 429);
      expect(allRateLimited).toBe(false);
    },
  );

  it('trennt einen transienten 429-Burst von fehlendem Guthaben', () => {
    const burst = {
      response: {
        status: 429,
        headers: { 'retry-after': '2', 'x-request-id': 'req_safe-123' },
        data: { error: { type: 'rate_limit_exceeded' } },
      },
    };
    const quota = {
      response: {
        status: 429,
        headers: {},
        data: { error: { code: 'insufficient_quota', message: 'Check billing.' } },
      },
    };

    expect(classifyProviderError(burst)).toMatchObject({
      kind: 'rate_limit',
      isRateLimit: true,
      isAuthOrModel: false,
      retryAfterMs: 2000,
      requestIdHash: expect.stringMatching(/^[a-f0-9]{16}$/),
    });
    const hard = classifyProviderError(quota);
    expect(hard).toMatchObject({
      kind: 'quota_or_billing',
      providerCode: 'insufficient_quota',
      isRateLimit: false,
      isAuthOrModel: true,
      circuitReason: 'provider_insufficient_quota',
    });
    expect(safeProviderFailureLabel(hard)).toBe('http_429:insufficient_quota');
  });

  it('erkennt harte Quota auch aus einer Provider-Meldung ohne strukturierten Code', () => {
    expect(classifyProviderError({
      response: {
        status: 429,
        data: { error: { message: 'Your account has insufficient credits.' } },
      },
    })).toMatchObject({
      kind: 'quota_or_billing',
      isRateLimit: false,
      isAuthOrModel: true,
    });
  });

  it('erkennt Model-Fehler in 400/422 nur anhand eines strukturierten Codes', () => {
    expect(classifyProviderError({
      response: { status: 400, data: { error: { code: 'model_not_found' } } },
    })).toMatchObject({
      kind: 'auth_or_model',
      isAuthOrModel: true,
      circuitReason: 'provider_model_not_found',
    });
    expect(classifyProviderError({
      response: { status: 400, data: { error: { message: 'bad request' } } },
    }).isAuthOrModel).toBe(false);
  });

  it('versteht offizielle Reset-Dauern und wartet auf alle erschoepften Grenzen', () => {
    const error = {
      response: {
        headers: {
          'x-ratelimit-reset-requests': '1m2.5s',
          'x-ratelimit-remaining-requests': '0',
          'x-ratelimit-reset-tokens': '7.25s',
          'x-ratelimit-remaining-tokens': '0',
        },
      },
    };
    expect(parseProviderRetryAfterMs(error)).toBe(62500);
  });

  it('ignoriert den schnelleren Reset einer nicht erschoepften Dimension', () => {
    expect(parseProviderRetryAfterMs({
      response: {
        headers: {
          'x-ratelimit-reset-requests': '1s',
          'x-ratelimit-remaining-requests': '999',
          'x-ratelimit-reset-tokens': '60s',
          'x-ratelimit-remaining-tokens': '0',
        },
      },
    })).toBe(60_000);
  });

  it('prueft auch error.type, wenn error.code die Quota-Art genauer bezeichnet', () => {
    expect(classifyProviderError({
      response: {
        status: 429,
        data: { error: { code: 'project_spend_limit_exceeded', type: 'insufficient_quota' } },
      },
    })).toMatchObject({
      kind: 'quota_or_billing',
      providerCode: 'project_spend_limit_exceeded',
      isRateLimit: false,
      isAuthOrModel: true,
    });
  });

  it('behaelt ein generisches per-minute quota_exceeded als temporaeres Limit', () => {
    expect(classifyProviderError({
      response: {
        status: 429,
        headers: { 'retry-after': '2' },
        data: { error: { code: 'quota_exceeded', message: 'Per-minute quota exhausted' } },
      },
    })).toMatchObject({ kind: 'rate_limit', isRateLimit: true, isAuthOrModel: false });
  });

  it('gibt keine beliebigen Provider-/Netzwerkcodes oder Request-ID-Secrets aus', () => {
    const secret = 'sk-this-is-not-a-real-key';
    const error = {
      code: secret,
      message: secret,
      response: {
        status: 429,
        headers: { 'x-request-id': secret, authorization: `Bearer ${secret}` },
        data: { error: { code: secret, message: secret } },
      },
    };
    const classification = classifyProviderError(error);
    expect(JSON.stringify(classification)).not.toContain(secret);
    expect(safeProviderFailureLabel(classification, error)).toBe('http_429');
    expect(safeProviderFailureLabel(classifyProviderError({ code: secret }), { code: secret })).toBe('provider_error');
  });

  it('haelt Retry-After endlich und gedeckelt', () => {
    const now = Date.parse('2026-08-30T12:00:00Z');
    expect(parseProviderRetryAfterMs({ response: { headers: { 'retry-after': '99999999' } } }, now)).toBe(86_400_000);
    expect(parseProviderRetryAfterMs({ response: { headers: { 'retry-after': '9'.repeat(400) } } }, now)).toBe(0);
    expect(parseProviderRetryAfterMs({ response: { headers: { 'retry-after': 'Sun, 30 Aug 2026 11:59:00 GMT' } } }, now)).toBe(0);
    expect(parseProviderRetryAfterMs({ response: { headers: { 'retry-after': '0' } } }, now)).toBe(0);
  });
});
