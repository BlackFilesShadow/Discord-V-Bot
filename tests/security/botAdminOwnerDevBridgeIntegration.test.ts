import type { Request, Response } from 'express';

const TEST_OWNER_ID = '12345678901234567';
const userFindUnique = jest.fn();
const botAdminFindFirst = jest.fn();
const botAdminUpdateMany = jest.fn();
const devSessionFindFirst = jest.fn();
const enforceDevMfa = jest.fn();
const enforceDevIpAllowlist = jest.fn();
const maybeAutoExtendDevSession = jest.fn();

jest.mock('../../src/config', () => ({
  config: {
    discord: { ownerId: TEST_OWNER_ID },
  },
}));

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    user: { findUnique: (...args: unknown[]) => userFindUnique(...args) },
    botAdminSession: {
      findFirst: (...args: unknown[]) => botAdminFindFirst(...args),
      updateMany: (...args: unknown[]) => botAdminUpdateMany(...args),
    },
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

import { requireGlobalBotAdminIdentity } from '../../src/dashboard/middleware/globalBotAdminGate';
import { requireBotAdmin } from '../../src/dashboard/middleware/auth';

function makeReq(discordId = TEST_OWNER_ID, role = 'USER'): Request {
  return {
    auth: {
      userId: 'user-1',
      discordId: discordId as any,
      role,
    },
    ip: '203.0.113.10',
    headers: {},
    session: { role },
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

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.DEV_REQUIRE_MFA;
  delete process.env.DEV_REQUIRE_IP_ALLOWLIST;
  userFindUnique.mockResolvedValue({ role: 'USER' });
  botAdminFindFirst.mockResolvedValue(null);
  botAdminUpdateMany.mockResolvedValue({ count: 0 });
  devSessionFindFirst.mockResolvedValue({
    id: 'dev-session-1',
    userDiscordId: TEST_OWNER_ID,
    scope: { logs: true },
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    createdAt: new Date(),
  });
  enforceDevMfa.mockResolvedValue({ ok: true, reason: undefined, graceUntil: null });
  enforceDevIpAllowlist.mockResolvedValue({ ok: true, reason: undefined, listSize: 1 });
  maybeAutoExtendDevSession.mockResolvedValue({ extended: false });
});

afterEach(() => {
  delete process.env.DEV_REQUIRE_MFA;
  delete process.env.DEV_REQUIRE_IP_ALLOWLIST;
});

describe('Bot-Admin full owner -> DEV-session bridge', () => {
  it('keeps the canonical owner DEV-eligible after the Bot-Admin gate refreshes a non-DEVELOPER DB role', async () => {
    const req = makeReq();
    const { res, status } = makeRes();
    const identityNext = jest.fn();

    await requireGlobalBotAdminIdentity(req, res, identityNext);

    expect(identityNext).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
    expect(req.auth?.role).toBe('DEVELOPER');
    // Persistente DB-Rolle / Session-Snapshot werden durch die Recovery-
    // Normalisierung nicht kuenstlich zu DEVELOPER umgeschrieben.
    expect((req.session as unknown as { role?: string }).role).toBe('USER');

    const accessNext = jest.fn();
    await requireBotAdmin(req, res, accessNext);

    expect(accessNext).toHaveBeenCalledTimes(1);
    expect(devSessionFindFirst).toHaveBeenCalledTimes(1);
    expect(req.devSession?.id).toBe('dev-session-1');
    expect(req.botAdminSession).toBeUndefined();
  });

  it('still requires an actual DevSession when the owner has no BotAdminSession', async () => {
    devSessionFindFirst.mockResolvedValue(null);
    const req = makeReq();
    const { res, status, json } = makeRes();

    await requireGlobalBotAdminIdentity(req, res, jest.fn());
    const accessNext = jest.fn();
    await requireBotAdmin(req, res, accessNext);

    expect(accessNext).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'DEV_LOGIN_REQUIRED' }));
  });

  it('does not turn an unrelated USER into a Bot-Admin through an existing DevSession row', async () => {
    userFindUnique.mockResolvedValue({ role: 'USER' });
    const req = makeReq('22345678901234567', 'USER');
    const { res, status, json } = makeRes();
    const identityNext = jest.fn();

    await requireGlobalBotAdminIdentity(req, res, identityNext);

    expect(identityNext).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'BOTADMIN_IDENTITY_REQUIRED' }));
    expect(devSessionFindFirst).not.toHaveBeenCalled();
  });
});
