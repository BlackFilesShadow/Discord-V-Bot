/**
 * Enterprise-Compliance-Tests fuer DEV-Auth-Helfer.
 *
 * Die kryptografische Step-Up-Verifikation besitzt einen eigenen Testblock in
 * `devStepUpVerification.test.ts`. Hier pruefen wir bewusst nur MFA/IP,
 * Auth-Forensik, Scope-Parsing und die reine Step-Up-Eingabeform.
 */

const twoFAFindUnique = jest.fn();
const ipListCount = jest.fn();
const ipListFindFirst = jest.fn();
const securityEventCreate = jest.fn();

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

import {
  enforceDevMfa,
  enforceDevIpAllowlist,
  recordDevAuthFailure,
  parseDevScope,
  validateStepUpInput,
} from '../../src/dashboard/middleware/devSecurity';

beforeEach(() => {
  twoFAFindUnique.mockReset();
  ipListCount.mockReset();
  ipListFindFirst.mockReset();
  securityEventCreate.mockReset();
  delete process.env.DEV_MFA_GRACE_PERIOD_END;
  delete process.env.DEV_MFA_GRACE_ALLOW;
  delete process.env.DEV_MFA_GRACE_MAX_DAYS;
  delete process.env.DEV_IP_ALLOWLIST_REQUIRED;
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

  it('soft-allow waehrend explizit freigegebener Grace-Period', async () => {
    twoFAFindUnique.mockResolvedValue(null);
    process.env.DEV_MFA_GRACE_ALLOW = 'true';
    process.env.DEV_MFA_GRACE_PERIOD_END = new Date(Date.now() + 60_000).toISOString();
    const r = await enforceDevMfa('u1');
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('grace_active');
    expect(r.graceUntil).toBeInstanceOf(Date);
  });

  it('hart abgelehnt wenn Grace abgelaufen ist', async () => {
    twoFAFindUnique.mockResolvedValue({ isEnabled: false });
    process.env.DEV_MFA_GRACE_ALLOW = 'true';
    process.env.DEV_MFA_GRACE_PERIOD_END = new Date(Date.now() - 60_000).toISOString();
    const r = await enforceDevMfa('u1');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_2fa');
  });

  it('ignoriert Grace ohne explizites Opt-in', async () => {
    twoFAFindUnique.mockResolvedValue(null);
    process.env.DEV_MFA_GRACE_PERIOD_END = new Date(Date.now() + 60_000).toISOString();
    const r = await enforceDevMfa('u1');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_2fa');
  });

  it('begrenzt die Grace per Hard-Cap', async () => {
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

  it('fail-closed bei leerer Liste', async () => {
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
    const call = securityEventCreate.mock.calls[0][0];
    expect(call.data.eventType).toBe('LOGIN_FAILURE');
    expect(call.data.severity).toBe('MEDIUM');
  });

  it('eskaliert ab Schwellwert auf BRUTE_FORCE/CRITICAL', async () => {
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
    expect(parseDevScope({ guildIdRestrict: '   ' }).guildIdRestrict).toBeUndefined();
  });

  it('liefert leeres Objekt fuer null/undefined', () => {
    expect(parseDevScope(null)).toEqual({});
    expect(parseDevScope(undefined)).toEqual({});
  });
});

describe('validateStepUpInput', () => {
  it('verlangt reason', () => {
    expect(validateStepUpInput({ reAuth: 'abcd' }).error).toBe('reason_missing');
  });
  it('verlangt mindestens sechs Zeichen Begruendung', () => {
    expect(validateStepUpInput({ reason: 'abc', reAuth: 'abcd' }).error).toBe('reason_too_short');
  });
  it('verlangt reAuth', () => {
    expect(validateStepUpInput({ reason: 'valid reason' }).error).toBe('reauth_missing');
  });
  it('verlangt mindestens vier Zeichen reAuth', () => {
    expect(validateStepUpInput({ reason: 'valid reason', reAuth: 'ab' }).error).toBe('reauth_invalid');
  });
  it('akzeptiert formal gueltige Eingabe; kryptografische Pruefung folgt in devStepUp', () => {
    expect(validateStepUpInput({ reason: 'kill switch ai', reAuth: '123456' }).ok).toBe(true);
  });
});
