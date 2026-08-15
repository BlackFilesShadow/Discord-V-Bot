/**
 * P0 — Enterprise-Compliance-Tests fuer DEV-Auth.
 *
 * Verifiziert:
 *   - enforceDevMfa: hard ohne 2FA, soft mit Grace-Period, ok mit aktivem 2FA
 *   - enforceDevIpAllowlist: fail-open bei leerer Liste, deny bei IP fehlt,
 *     ok bei IP gelistet
 *   - parseDevScope: typed parsing inkl. guildIdRestrict
 *   - validateStepUpInput: Pflichtfelder + Mindestlaengen
 *   - verifyDevStepUp: echte TOTP-/DEV_PASSWORD-Re-Authentisierung
 *
 * Bewusst auf reine Verhaltens-Garantien fokussiert — kein Express-Harness.
 */

const twoFAFindUnique = jest.fn();
const ipListCount = jest.fn();
const ipListFindFirst = jest.fn();
const securityEventCreate = jest.fn();
const decryptMock = jest.fn();
const verify2FATokenMock = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    twoFactorAuth: { findUnique: (...a: unknown[]) => twoFAFindUnique(...a) },
    ipList: {
      count: (...a: unknown[]) => ipListCount(...a),
      findFirst: (...a: unknown[]) => ipListFindFirst(...a),
    },
    securityEvent: { create: (...a: unknown[]) => securityEventCreate(...a) },
    devSession: { findFirst: jest.fn().mockResolvedValue(null) },
  },
}));

jest.mock('../../src/utils/security', () => {
  const actual = jest.requireActual('../../src/utils/security');
  return {
    ...actual,
    decrypt: (...a: unknown[]) => decryptMock(...a),
    verify2FAToken: (...a: unknown[]) => verify2FATokenMock(...a),
  };
});

import {
  enforceDevMfa,
  enforceDevIpAllowlist,
  recordDevAuthFailure,
  parseDevScope,
  validateStepUpInput,
  verifyDevStepUp,
} from '../../src/dashboard/middleware/devSecurity';

beforeEach(() => {
  twoFAFindUnique.mockReset();
  ipListCount.mockReset();
  ipListFindFirst.mockReset();
  securityEventCreate.mockReset();
  decryptMock.mockReset();
  verify2FATokenMock.mockReset();
  delete process.env.DEV_MFA_GRACE_PERIOD_END;
  delete process.env.DEV_MFA_GRACE_ALLOW;
  delete process.env.DEV_MFA_GRACE_MAX_DAYS;
  delete process.env.DEV_PASSWORD;
});

describe('enforceDevMfa', () => {
  it('ok wenn 2FA aktiv', async () => {
    twoFAFindUnique.mockResolvedValue({ isEnabled: true });
    const r = await enforceDevMfa('u1');
    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  it('hart abgelehnt ohne 2FA und ohne Grace', async () => {
    twoFAFindUnique.mockResolvedValue(null);
    const r = await enforceDevMfa('u1');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_2fa');
  });

  it('soft-allow waehrend Grace-Period (Opt-in via DEV_MFA_GRACE_ALLOW)', async () => {
    twoFAFindUnique.mockResolvedValue(null);
    process.env.DEV_MFA_GRACE_ALLOW = 'true';
    process.env.DEV_MFA_GRACE_PERIOD_END = new Date(Date.now() + 60_000).toISOString();
    const r = await enforceDevMfa('u1');
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('grace_active');
    expect(r.graceUntil).toBeInstanceOf(Date);
  });

  it('hart abgelehnt wenn Grace abgelaufen', async () => {
    twoFAFindUnique.mockResolvedValue({ isEnabled: false });
    process.env.DEV_MFA_GRACE_ALLOW = 'true';
    process.env.DEV_MFA_GRACE_PERIOD_END = new Date(Date.now() - 60_000).toISOString();
    const r = await enforceDevMfa('u1');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_2fa');
  });

  it('Grace ignoriert wenn DEV_MFA_GRACE_ALLOW fehlt (secure-by-default)', async () => {
    twoFAFindUnique.mockResolvedValue(null);
    process.env.DEV_MFA_GRACE_PERIOD_END = new Date(Date.now() + 60_000).toISOString();
    const r = await enforceDevMfa('u1');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_2fa');
  });

  it('Grace per Hard-Cap (DEV_MFA_GRACE_MAX_DAYS) begrenzt', async () => {
    twoFAFindUnique.mockResolvedValue(null);
    process.env.DEV_MFA_GRACE_ALLOW = 'true';
    process.env.DEV_MFA_GRACE_MAX_DAYS = '14';
    process.env.DEV_MFA_GRACE_PERIOD_END = '2099-01-01T00:00:00.000Z';
    const r = await enforceDevMfa('u1');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_2fa');
  });
});

describe('enforceDevIpAllowlist', () => {
  const fakeReq = (ip: string | undefined) => ({ ip } as unknown as Parameters<typeof enforceDevIpAllowlist>[0]);

  it('fail-closed bei leerer Liste (secure-by-default)', async () => {
    delete process.env.DEV_IP_ALLOWLIST_REQUIRED;
    ipListCount.mockResolvedValue(0);
    const r = await enforceDevIpAllowlist(fakeReq('1.2.3.4'));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_list');
    expect(r.listSize).toBe(0);
    expect(ipListFindFirst).not.toHaveBeenCalled();
  });

  it('fail-open bei leerer Liste nur mit explizitem Opt-out', async () => {
    process.env.DEV_IP_ALLOWLIST_REQUIRED = 'false';
    ipListCount.mockResolvedValue(0);
    const r = await enforceDevIpAllowlist(fakeReq('1.2.3.4'));
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('no_list');
    delete process.env.DEV_IP_ALLOWLIST_REQUIRED;
  });

  it('fail-closed wenn Liste vorhanden aber IP fehlt', async () => {
    ipListCount.mockResolvedValue(2);
    const r = await enforceDevIpAllowlist(fakeReq(undefined));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_ip');
  });

  it('ok wenn IP in Liste', async () => {
    ipListCount.mockResolvedValue(2);
    ipListFindFirst.mockResolvedValue({ id: 'ip-1' });
    const r = await enforceDevIpAllowlist(fakeReq('1.2.3.4'));
    expect(r.ok).toBe(true);
    expect(r.listSize).toBe(2);
  });

  it('deny wenn IP nicht in Liste', async () => {
    ipListCount.mockResolvedValue(2);
    ipListFindFirst.mockResolvedValue(null);
    const r = await enforceDevIpAllowlist(fakeReq('5.6.7.8'));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not_listed');
  });
});

describe('recordDevAuthFailure', () => {
  it('schreibt LOGIN_FAILURE bei niedrigem Counter', async () => {
    securityEventCreate.mockResolvedValue({ id: 'sec-1' });
    recordDevAuthFailure({ userId: 'u1', ip: '1.1.1.1', reason: 'bad_password', failureCount: 1 });
    await new Promise(r => setImmediate(r));
    expect(securityEventCreate).toHaveBeenCalledTimes(1);
    const call = securityEventCreate.mock.calls[0][0];
    expect(call.data.eventType).toBe('LOGIN_FAILURE');
    expect(call.data.severity).toBe('MEDIUM');
  });

  it('eskaliert auf BRUTE_FORCE/CRITICAL ab Schwellwert', async () => {
    securityEventCreate.mockResolvedValue({ id: 'sec-2' });
    recordDevAuthFailure({ userId: 'u1', ip: '1.1.1.1', reason: 'bad_password', failureCount: 5 });
    await new Promise(r => setImmediate(r));
    const call = securityEventCreate.mock.calls[0][0];
    expect(call.data.eventType).toBe('BRUTE_FORCE');
    expect(call.data.severity).toBe('CRITICAL');
  });
});

describe('parseDevScope', () => {
  it('liest guildIdRestrict typisiert', () => {
    const s = parseDevScope({ logs: true, guildIdRestrict: 'g1', readOnly: true });
    expect(s.logs).toBe(true);
    expect(s.guildIdRestrict).toBe('g1');
    expect(s.readOnly).toBe(true);
  });

  it('ignoriert leere Strings', () => {
    const s = parseDevScope({ guildIdRestrict: '   ' });
    expect(s.guildIdRestrict).toBeUndefined();
  });

  it('liefert {} fuer null/undef', () => {
    expect(parseDevScope(null)).toEqual({});
    expect(parseDevScope(undefined)).toEqual({});
  });
});

describe('validateStepUpInput', () => {
  it('reason muss vorhanden sein', () => {
    expect(validateStepUpInput({ reAuth: 'abcd' }).error).toBe('reason_missing');
  });
  it('reason muss min. 6 Zeichen haben', () => {
    expect(validateStepUpInput({ reason: 'abc', reAuth: 'abcd' }).error).toBe('reason_too_short');
  });
  it('reAuth muss vorhanden sein', () => {
    expect(validateStepUpInput({ reason: 'valid reason' }).error).toBe('reauth_missing');
  });
  it('reAuth muss min. 4 Zeichen haben', () => {
    expect(validateStepUpInput({ reason: 'valid reason', reAuth: 'ab' }).error).toBe('reauth_invalid');
  });
  it('ok wenn alles korrekt', () => {
    expect(validateStepUpInput({ reason: 'kill switch ai', reAuth: '123456' }).ok).toBe(true);
  });
});

describe('verifyDevStepUp', () => {
  const fakeReq = () => ({
    auth: { userId: 'u1', discordId: '12345678901234567', role: 'DEVELOPER' },
    ip: '127.0.0.1',
    headers: {},
  } as unknown as Parameters<typeof verifyDevStepUp>[0]);

  it('akzeptiert das aktuelle DEV_PASSWORD wenn 2FA nicht aktiv ist', async () => {
    twoFAFindUnique.mockResolvedValue({ isEnabled: false, secretEnc: null });
    process.env.DEV_PASSWORD = 'correct-horse';
    await expect(verifyDevStepUp(fakeReq(), { reason: 'Adminrolle ändern', reAuth: 'correct-horse' })).resolves.toEqual({ ok: true });
  });

  it('weist ein falsches DEV_PASSWORD kryptografisch zurueck', async () => {
    twoFAFindUnique.mockResolvedValue({ isEnabled: false, secretEnc: null });
    process.env.DEV_PASSWORD = 'correct-horse';
    const r = await verifyDevStepUp(fakeReq(), { reason: 'Adminrolle ändern', reAuth: 'wrong-horse' });
    expect(r).toEqual({ ok: false, error: 'reauth_invalid' });
  });

  it('fail-closed wenn ohne 2FA kein DEV_PASSWORD konfiguriert ist', async () => {
    twoFAFindUnique.mockResolvedValue({ isEnabled: false, secretEnc: null });
    const r = await verifyDevStepUp(fakeReq(), { reason: 'Adminrolle ändern', reAuth: 'anything' });
    expect(r).toEqual({ ok: false, error: 'no_credential' });
  });

  it('verlangt bei aktiver 2FA einen gueltigen TOTP statt DEV_PASSWORD', async () => {
    twoFAFindUnique.mockResolvedValue({ isEnabled: true, secretEnc: 'encrypted-secret' });
    decryptMock.mockReturnValue('BASE32SECRET');
    verify2FATokenMock.mockReturnValue(true);
    process.env.DEV_PASSWORD = 'correct-horse';
    const r = await verifyDevStepUp(fakeReq(), { reason: 'Security ändern', reAuth: '123456' });
    expect(r).toEqual({ ok: true });
    expect(decryptMock).toHaveBeenCalledWith('encrypted-secret', expect.any(String));
    expect(verify2FATokenMock).toHaveBeenCalledWith('BASE32SECRET', '123456');
  });

  it('weist einen falschen TOTP bei aktiver 2FA zurueck', async () => {
    twoFAFindUnique.mockResolvedValue({ isEnabled: true, secretEnc: 'encrypted-secret' });
    decryptMock.mockReturnValue('BASE32SECRET');
    verify2FATokenMock.mockReturnValue(false);
    const r = await verifyDevStepUp(fakeReq(), { reason: 'Security ändern', reAuth: '000000' });
    expect(r).toEqual({ ok: false, error: 'reauth_invalid' });
  });
});
