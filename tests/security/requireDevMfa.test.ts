/**
 * Verifiziert die neue DEV-MFA-Doktrin in `requireDev`:
 *   - Standard (DEV_REQUIRE_MFA nicht gesetzt): aktive DevSession + DEVELOPER
 *     reicht; 2FA blockiert NICHT, auch wenn der User kein 2FA hat.
 *   - DEV_REQUIRE_MFA=true: 2FA wird wieder erzwungen (403 DEV_MFA_REQUIRED).
 *
 * Andere Sicherheitsmechanismen (Rolle, aktive Session) bleiben Pflicht.
 */
import type { Request, Response } from 'express';

const devSessionFindFirst = jest.fn();
const twoFAFindUnique = jest.fn();
const ipListCount = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    devSession: { findFirst: (...a: unknown[]) => devSessionFindFirst(...a) },
    twoFactorAuth: { findUnique: (...a: unknown[]) => twoFAFindUnique(...a) },
    ipList: { count: (...a: unknown[]) => ipListCount(...a) },
  },
}));

jest.mock('../../src/dashboard/services/devSessionLifecycle', () => ({
  maybeAutoExtendDevSession: jest.fn().mockResolvedValue({ extended: false }),
}));

jest.mock('../../src/dashboard/clientRegistry', () => ({
  getDashboardClient: jest.fn(),
}));

import { requireDev } from '../../src/dashboard/middleware/auth';

function makeReqRes() {
  const req = {
    auth: { userId: 'u1', discordId: '123456789012345678', role: 'DEVELOPER' },
    ip: '203.0.113.5',
    headers: {},
  } as unknown as Request;
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const res = { status, json } as unknown as Response;
  return { req, res, status, json };
}

beforeEach(() => {
  devSessionFindFirst.mockReset();
  twoFAFindUnique.mockReset();
  ipListCount.mockReset();
  delete process.env.DEV_REQUIRE_MFA;
  // IP-Allowlist neutralisieren (separat getestet).
  process.env.DEV_IP_ALLOWLIST_REQUIRED = 'false';
  ipListCount.mockResolvedValue(0);
  devSessionFindFirst.mockResolvedValue({
    id: 's1', userDiscordId: '123456789012345678', scope: {},
    expiresAt: new Date(Date.now() + 3_600_000), createdAt: new Date(),
  });
  twoFAFindUnique.mockResolvedValue(null); // kein 2FA
});

afterEach(() => {
  delete process.env.DEV_IP_ALLOWLIST_REQUIRED;
  delete process.env.DEV_REQUIRE_MFA;
});

describe('requireDev MFA-Gating', () => {
  it('erlaubt Zugriff ohne 2FA, wenn DEV_REQUIRE_MFA nicht true ist', async () => {
    const { req, res, status } = makeReqRes();
    const next = jest.fn();
    await requireDev(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
    expect(req.devSession).toBeDefined();
  });

  it('blockiert mit 403 DEV_MFA_REQUIRED, wenn DEV_REQUIRE_MFA=true und kein 2FA', async () => {
    process.env.DEV_REQUIRE_MFA = 'true';
    const { req, res, status, json } = makeReqRes();
    const next = jest.fn();
    await requireDev(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'DEV_MFA_REQUIRED' }));
  });

  it('verlangt weiterhin eine aktive DevSession', async () => {
    devSessionFindFirst.mockResolvedValue(null);
    const { req, res, status, json } = makeReqRes();
    const next = jest.fn();
    await requireDev(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'DEV_LOGIN_REQUIRED' }));
  });

  it('verlangt DEVELOPER-Rolle', async () => {
    const { req, res, status } = makeReqRes();
    (req.auth as { role: string }).role = 'USER';
    const next = jest.fn();
    await requireDev(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
  });
});
