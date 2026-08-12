import {
  classifyProviderHttpStatus,
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
});
