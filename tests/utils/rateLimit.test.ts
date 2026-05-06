import {
  checkGlobalRateLimit,
  checkPerCommandRateLimit,
  __resetRateLimits,
  RATE_LIMIT_GLOBAL_MAX,
  RATE_LIMIT_PER_COMMAND_MAX,
} from '../../src/utils/rateLimit';

describe('rateLimit', () => {
  beforeEach(() => __resetRateLimits());

  describe('checkGlobalRateLimit', () => {
    it('erlaubt erste 30 Aufrufe und blockt den 31.', () => {
      const t = 1_000_000;
      for (let i = 0; i < RATE_LIMIT_GLOBAL_MAX; i++) {
        expect(checkGlobalRateLimit('u1', t)).toBe(true);
      }
      expect(checkGlobalRateLimit('u1', t)).toBe(false);
    });

    it('separiert Buckets pro User', () => {
      const t = 1_000_000;
      for (let i = 0; i < RATE_LIMIT_GLOBAL_MAX; i++) {
        checkGlobalRateLimit('u1', t);
      }
      expect(checkGlobalRateLimit('u1', t)).toBe(false);
      expect(checkGlobalRateLimit('u2', t)).toBe(true);
    });

    it('öffnet Window nach 60s wieder', () => {
      const t = 1_000_000;
      for (let i = 0; i < RATE_LIMIT_GLOBAL_MAX; i++) {
        checkGlobalRateLimit('u1', t);
      }
      expect(checkGlobalRateLimit('u1', t)).toBe(false);
      expect(checkGlobalRateLimit('u1', t + 60_001)).toBe(true);
    });
  });

  describe('checkPerCommandRateLimit', () => {
    it('erlaubt 10 Aufrufe pro (User×Command) und blockt den 11.', () => {
      const t = 2_000_000;
      for (let i = 0; i < RATE_LIMIT_PER_COMMAND_MAX; i++) {
        expect(checkPerCommandRateLimit('u1', 'ai', t)).toBe(true);
      }
      expect(checkPerCommandRateLimit('u1', 'ai', t)).toBe(false);
    });

    it('separiert Buckets pro Command', () => {
      const t = 2_000_000;
      for (let i = 0; i < RATE_LIMIT_PER_COMMAND_MAX; i++) {
        checkPerCommandRateLimit('u1', 'ai', t);
      }
      expect(checkPerCommandRateLimit('u1', 'ai', t)).toBe(false);
      expect(checkPerCommandRateLimit('u1', 'help', t)).toBe(true);
    });

    it('separiert Buckets pro User auch beim selben Command', () => {
      const t = 2_000_000;
      for (let i = 0; i < RATE_LIMIT_PER_COMMAND_MAX; i++) {
        checkPerCommandRateLimit('u1', 'ai', t);
      }
      expect(checkPerCommandRateLimit('u2', 'ai', t)).toBe(true);
    });
  });

  it('global und per-command sind unabhängige Buckets', () => {
    const t = 3_000_000;
    // Per-Command erschöpft, global noch frei
    for (let i = 0; i < RATE_LIMIT_PER_COMMAND_MAX; i++) {
      checkPerCommandRateLimit('u1', 'ai', t);
    }
    expect(checkPerCommandRateLimit('u1', 'ai', t)).toBe(false);
    expect(checkGlobalRateLimit('u1', t)).toBe(true);
  });
});
