import {
  classifyProviderHttpStatus,
  updateAllRateLimitedState,
} from '../../src/modules/ai/providerFailure';

describe('AI provider billing failure classification', () => {
  it('behandelt HTTP 402 als harten Provider-Ausfall und niemals als Rate-Limit', () => {
    expect(classifyProviderHttpStatus(402)).toEqual({
      isRateLimit: false,
      isAuthOrModel: true,
    });
    expect(updateAllRateLimitedState(true, 402)).toBe(false);
  });
});
