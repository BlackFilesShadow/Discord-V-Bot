/**
 * Phase 7: GameIdentity-Primitive. Beweise: GUID nie im Klartext (Hash),
 * deterministischer Lookup, korrekte Challenge-Verifikation.
 */
import {
  identityHash, newChallengeCode, redactIdentity, isChallengeValid,
  CHALLENGE_LENGTH, type ChallengeLike,
} from '../../src/modules/linking/identity';

const SECRET = 'test-secret-key';

describe('identityHash', () => {
  it('ist deterministisch und 64 Hex-Zeichen', () => {
    const a = identityHash('76561198000000000', SECRET);
    const b = identityHash('76561198000000000', SECRET);
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('enthaelt NICHT den Klartext-GUID', () => {
    const gid = '76561198000000000';
    expect(identityHash(gid, SECRET)).not.toContain(gid);
  });

  it('unterschiedliche IDs -> unterschiedliche Hashes', () => {
    expect(identityHash('a', SECRET)).not.toBe(identityHash('b', SECRET));
  });

  it('trimmt Whitespace', () => {
    expect(identityHash('  x  ', SECRET)).toBe(identityHash('x', SECRET));
  });

  it('anderes Secret -> anderer Hash', () => {
    expect(identityHash('x', SECRET)).not.toBe(identityHash('x', 'other'));
  });
});

describe('newChallengeCode', () => {
  it('hat die erwartete Laenge und nur erlaubte Zeichen', () => {
    const c = newChallengeCode();
    expect(c).toHaveLength(CHALLENGE_LENGTH);
    expect(c).toMatch(/^[A-Z2-9]+$/);
    expect(c).not.toMatch(/[OI01]/);
  });
});

describe('redactIdentity', () => {
  it('gibt nur ein kurzes Praefix zurueck', () => {
    const h = identityHash('76561198000000000', SECRET);
    const r = redactIdentity(h);
    expect(r).toBe(`id:${h.slice(0, 8)}`);
    expect(r).not.toContain('76561198000000000');
  });
});

describe('isChallengeValid', () => {
  const now = new Date('2026-08-01T12:00:00Z');
  const base: ChallengeLike = {
    status: 'PENDING', challengeCode: 'ABCD2345',
    challengeExpiresAt: new Date('2026-08-01T12:05:00Z'),
  };

  it('gueltig bei richtigem Code + offen + nicht abgelaufen', () => {
    expect(isChallengeValid(base, 'ABCD2345', now)).toBe(true);
    expect(isChallengeValid(base, ' abcd2345 ', now)).toBe(true); // trim + uppercase
  });
  it('ungueltig bei falschem Code', () => {
    expect(isChallengeValid(base, 'WRONG', now)).toBe(false);
  });
  it('ungueltig wenn abgelaufen', () => {
    expect(isChallengeValid(base, 'ABCD2345', new Date('2026-08-01T12:06:00Z'))).toBe(false);
  });
  it('ungueltig wenn nicht PENDING', () => {
    expect(isChallengeValid({ ...base, status: 'VERIFIED' }, 'ABCD2345', now)).toBe(false);
  });
  it('ungueltig ohne Code', () => {
    expect(isChallengeValid({ ...base, challengeCode: null }, 'ABCD2345', now)).toBe(false);
  });
});
