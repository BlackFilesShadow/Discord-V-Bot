import { generateCsrfToken, generateNonce, generatePKCE } from '../../src/utils/security';

describe('Stage 41 CSRF/PKCE token runtime', () => {
  it('generateCsrfToken yields unique 64-hex high-entropy values', () => {
    const a = generateCsrfToken();
    const b = generateCsrfToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it('generateNonce yields unique base64url values', () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThanOrEqual(16);
    expect(a).not.toBe(b);
  });

  it('generatePKCE binds challenge to verifier via S256 and never reuses pairs', () => {
    const crypto = require('node:crypto') as typeof import('node:crypto');
    const one = generatePKCE();
    const two = generatePKCE();
    expect(one.codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(one.codeVerifier).not.toBe(two.codeVerifier);
    expect(one.codeChallenge).not.toBe(two.codeChallenge);
    const expected = crypto.createHash('sha256').update(one.codeVerifier).digest('base64url');
    expect(one.codeChallenge).toBe(expected);
    // Cross-pair challenge must not validate against foreign verifier.
    const foreign = crypto.createHash('sha256').update(two.codeVerifier).digest('base64url');
    expect(one.codeChallenge).not.toBe(foreign);
  });
});
