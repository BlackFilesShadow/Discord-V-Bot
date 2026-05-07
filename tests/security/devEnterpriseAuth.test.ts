/**
 * P0 — Enterprise-Compliance-Tests fuer DEV-Auth.
 *
 * Verifiziert:
 *   - enforceDevMfa: hard ohne 2FA, soft mit Grace-Period, ok mit aktivem 2FA
 *   - enforceDevIpAllowlist: fail-open bei leerer Liste, deny bei IP fehlt,
 *     ok bei IP gelistet
 *   - parseDevScope: typed parsing inkl. guildIdRestrict
 *   - validateStepUpInput: Pflichtfelder + Mindestlaengen
 *
 * Bewusst auf reine Verhaltens-Garantien fokussiert — kein Express-Harness.
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
    // 2099 — weit jenseits 14 Tage Cap
    process.env.DEV_MFA_GRACE_PERIOD_END = '2099-01-01T00:00:00.000Z';
    const r = await enforceDevMfa('u1');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_2fa');
  });
});

describe('enforceDevIpAllowlist', () => {
  const fakeReq = (ip: string | undefined) => ({ ip } as unknown as Parameters<typeof enforceDevIpAllowlist>[0]);

  it('fail-open bei leerer Liste', async () => {
    ipListCount.mockResolvedValue(0);
    const r = await enforceDevIpAllowlist(fakeReq('1.2.3.4'));
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('no_list');
    expect(r.listSize).toBe(0);
    expect(ipListFindFirst).not.toHaveBeenCalled();
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
    // best-effort Promise abwarten
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
