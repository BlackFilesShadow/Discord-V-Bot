import {
  checkGlobalRateLimit,
  checkPerCommandRateLimit,
  checkComponentRateLimit,
  __resetRateLimits,
  RATE_LIMIT_GLOBAL_MAX,
  RATE_LIMIT_PER_COMMAND_MAX,
  RATE_LIMIT_COMPONENT_MAX,
  RATE_LIMIT_COMPONENT_WINDOW_MS,
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

  describe('checkComponentRateLimit', () => {
    it('erlaubt 25 Aktionen pro 30s und blockt die 26.', () => {
      const t = 4_000_000;
      for (let i = 0; i < RATE_LIMIT_COMPONENT_MAX; i++) {
        expect(checkComponentRateLimit('u1', t)).toBe(true);
      }
      expect(checkComponentRateLimit('u1', t)).toBe(false);
    });

    it('separiert Buckets pro User', () => {
      const t = 4_000_000;
      for (let i = 0; i < RATE_LIMIT_COMPONENT_MAX; i++) {
        checkComponentRateLimit('u1', t);
      }
      expect(checkComponentRateLimit('u1', t)).toBe(false);
      expect(checkComponentRateLimit('u2', t)).toBe(true);
    });

    it('öffnet Window nach 30s wieder', () => {
      const t = 4_000_000;
      for (let i = 0; i < RATE_LIMIT_COMPONENT_MAX; i++) {
        checkComponentRateLimit('u1', t);
      }
      expect(checkComponentRateLimit('u1', t)).toBe(false);
      expect(checkComponentRateLimit('u1', t + RATE_LIMIT_COMPONENT_WINDOW_MS + 1)).toBe(true);
    });

    it('ist unabhängig vom Command-Budget (eigener Bucket)', () => {
      const t = 5_000_000;
      // Komponenten-Budget erschöpfen
      for (let i = 0; i < RATE_LIMIT_COMPONENT_MAX; i++) {
        checkComponentRateLimit('u1', t);
      }
      expect(checkComponentRateLimit('u1', t)).toBe(false);
      // Command-Budgets bleiben unberührt
      expect(checkGlobalRateLimit('u1', t)).toBe(true);
      expect(checkPerCommandRateLimit('u1', 'ai', t)).toBe(true);
    });
  });
});
