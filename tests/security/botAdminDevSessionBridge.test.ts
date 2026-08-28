/**
 * Regression fuer den DEV -> Bot-Admin-Zugriffsweg.
 *
 * Invariante:
 * - Eine echte BotAdminSession bleibt der primaere Zugriffsweg.
 * - Ohne BotAdminSession darf nur DEVELOPER mit einer gueltigen DevSession
 *   durchfallen.
 * - Der Fallback MUSS requireDev wiederverwenden, damit MFA/IP-Policy und
 *   Session-Lifecycle nicht umgangen werden.
 */
import type { Request, Response } from 'express';

const botAdminFindFirst = jest.fn();
const devSessionFindFirst = jest.fn();
const enforceDevMfa = jest.fn();
const enforceDevIpAllowlist = jest.fn();
const maybeAutoExtendDevSession = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    botAdminSession: { findFirst: (...args: unknown[]) => botAdminFindFirst(...args) },
    devSession: { findFirst: (...args: unknown[]) => devSessionFindFirst(...args) },
  },
}));

jest.mock('../../src/dashboard/clientRegistry', () => ({
  getDashboardClient: jest.fn(),
}));

jest.mock('../../src/modules/permissions/access', () => ({
  resolveDelegatedPermissionContext: jest.fn(),
}));

jest.mock('../../src/utils/logger', () => ({
  logAudit: jest.fn(),
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

jest.mock('../../src/dashboard/middleware/devSecurity', () => ({
  enforceDevMfa: (...args: unknown[]) => enforceDevMfa(...args),
  enforceDevIpAllowlist: (...args: unknown[]) => enforceDevIpAllowlist(...args),
  parseDevScope: (scope: unknown) => scope ?? {},
}));

jest.mock('../../src/dashboard/services/devSessionLifecycle', () => ({
  maybeAutoExtendDevSession: (...args: unknown[]) => maybeAutoExtendDevSession(...args),
}));

import { requireBotAdmin } from '../../src/dashboard/middleware/auth';

const TEST_DISCORD_ID = 'test-discord-user';

function makeReq(role = 'USER'): Request {
  return {
    auth: {
      userId: 'user-1',
      discordId: TEST_DISCORD_ID as any,
      role,
    },
    ip: '203.0.113.10',
    headers: {},
    session: {},
  } as unknown as Request;
}

function makeRes(): { res: Response; status: jest.Mock; json: jest.Mock } {
  const json = jest.fn();
  const res = {} as Response;
  const status = jest.fn().mockReturnValue({ json });
  (res as any).status = status;
  (res as any).json = json;
  return { res, status, json };
}

const devSession = () => ({
  id: 'dev-session-1',
  userDiscordId: TEST_DISCORD_ID,
  scope: { logs: true },
  expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  createdAt: new Date(),
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.DEV_REQUIRE_MFA;
  delete process.env.DEV_REQUIRE_IP_ALLOWLIST;
  botAdminFindFirst.mockResolvedValue(null);
  devSessionFindFirst.mockResolvedValue(devSession());
  enforceDevMfa.mockResolvedValue({ ok: true, reason: undefined, graceUntil: null });
  enforceDevIpAllowlist.mockResolvedValue({ ok: true, reason: undefined, listSize: 1 });
  maybeAutoExtendDevSession.mockResolvedValue({ extended: false });
});

afterEach(() => {
  delete process.env.DEV_REQUIRE_MFA;
  delete process.env.DEV_REQUIRE_IP_ALLOWLIST;
});

describe('requireBotAdmin DEV bridge', () => {
  it('bevorzugt eine vorhandene BotAdminSession und beruehrt DEV nicht', async () => {
    botAdminFindFirst.mockResolvedValue({
      id: 'ba-1',
      userDiscordId: TEST_DISCORD_ID,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const req = makeReq('USER');
    const { res, status } = makeRes();
    const next = jest.fn();

    await requireBotAdmin(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
    expect(req.botAdminSession?.id).toBe('ba-1');
    expect(devSessionFindFirst).not.toHaveBeenCalled();
  });

  it('erlaubt DEVELOPER ohne BotAdminSession ueber die aktive DevSession', async () => {
    const req = makeReq('DEVELOPER');
    const { res, status } = makeRes();
    const next = jest.fn();

    await requireBotAdmin(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
    expect(req.botAdminSession).toBeUndefined();
    expect(req.devSession?.id).toBe('dev-session-1');
    expect(devSessionFindFirst).toHaveBeenCalledTimes(1);
  });

  it('blockiert normale Bot-Admins ohne BotAdminSession weiterhin fail-closed', async () => {
    const req = makeReq('ADMIN');
    const { res, status, json } = makeRes();
    const next = jest.fn();

    await requireBotAdmin(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(devSessionFindFirst).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'BOTADMIN_LOGIN_REQUIRED' }));
  });

  it('verlangt fuer DEVELOPER weiterhin eine aktive DevSession', async () => {
    devSessionFindFirst.mockResolvedValue(null);
    const req = makeReq('DEVELOPER');
    const { res, status, json } = makeRes();
    const next = jest.fn();

    await requireBotAdmin(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'DEV_LOGIN_REQUIRED' }));
  });

  it('umgeht DEV-MFA nicht', async () => {
    process.env.DEV_REQUIRE_MFA = 'true';
    enforceDevMfa.mockResolvedValue({ ok: false, reason: 'missing', graceUntil: null });
    const req = makeReq('DEVELOPER');
    const { res, status, json } = makeRes();
    const next = jest.fn();

    await requireBotAdmin(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(enforceDevMfa).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'DEV_MFA_REQUIRED' }));
  });

  it('umgeht die DEV-IP-Allowlist nicht', async () => {
    process.env.DEV_REQUIRE_IP_ALLOWLIST = 'true';
    enforceDevIpAllowlist.mockResolvedValue({ ok: false, reason: 'not_allowed', listSize: 1 });
    const req = makeReq('DEVELOPER');
    const { res, status, json } = makeRes();
    const next = jest.fn();

    await requireBotAdmin(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(enforceDevIpAllowlist).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'DEV_IP_DENIED' }));
  });
});
