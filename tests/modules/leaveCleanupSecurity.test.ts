import { sanitizeLeaveCleanupError } from '../../src/modules/moderation/leaveCleanupSecurity';

describe('Leave cleanup error redaction', () => {
  it('removes concrete player identifiers and line breaks before persistence', () => {
    const result = sanitizeLeaveCleanupError(
      new Error('Remote failed for TargetPlayer\nretry later'),
      ['TargetPlayer'],
    );
    expect(result).toBe('Remote failed for [REDACTED] retry later');
    expect(result).not.toContain('TargetPlayer');
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

  it('caps persisted error text to 1000 characters', () => {
    expect(sanitizeLeaveCleanupError('x'.repeat(5000))).toHaveLength(1000);
  });
});
