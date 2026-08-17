import { sanitizeLeaveCleanupError } from '../../src/modules/moderation/leaveCleanupSecurity';

describe('Leave cleanup error redaction', () => {
  it('removes concrete player identifiers case-insensitively and strips line breaks', () => {
    const result = sanitizeLeaveCleanupError(
      new Error('Remote failed for TARGETPLAYER\nretry later'),
      ['TargetPlayer'],
    );
    expect(result).toBe('Remote failed for [REDACTED] retry later');
    expect(result).not.toMatch(/targetplayer/i);
    expect(result).not.toContain('\n');
  });

  it('redacts bearer, token, api-key, secret and password style values', () => {
    const result = sanitizeLeaveCleanupError(
      'Bearer abc.def.ghi token=raw-token api_key:raw-key secret=raw-secret password:raw-password',
    );
    expect(result).toContain('Bearer [REDACTED]');
    expect(result).not.toContain('abc.def.ghi');
    expect(result).not.toContain('raw-token');
    expect(result).not.toContain('raw-key');
    expect(result).not.toContain('raw-secret');
    expect(result).not.toContain('raw-password');
  });

  it('escapes regex metacharacters in supplied sensitive identifiers', () => {
    expect(sanitizeLeaveCleanupError('player A+B[1] failed', ['A+B[1]']))
      .toBe('player [REDACTED] failed');
  });

  it('caps persisted error text to 1000 characters', () => {
    expect(sanitizeLeaveCleanupError('x'.repeat(5000))).toHaveLength(1000);
  });
});
