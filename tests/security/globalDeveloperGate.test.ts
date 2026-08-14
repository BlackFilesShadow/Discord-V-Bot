const findUnique = jest.fn();
const updateMany = jest.fn();
const logAudit = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    user: { findUnique },
    devSession: { updateMany },
  },
}));
jest.mock('../../src/config', () => ({
  config: { discord: { ownerId: '123456789012345678' } },
}));
jest.mock('../../src/utils/logger', () => ({ logAudit }));

import { requireGlobalDeveloperIdentity } from '../../src/dashboard/middleware/globalDeveloperGate';

function request(discordId = '123456789012345678', role = 'DEVELOPER') {
  return {
    auth: { userId: 'user-db-id', discordId, role },
    session: {},
    ip: '203.0.113.5',
  } as any;
}

function response() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

describe('requireGlobalDeveloperIdentity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    updateMany.mockResolvedValue({ count: 1 });
  });

  it('allows only the canonical owner with a current DEVELOPER DB role', async () => {
    findUnique.mockResolvedValue({ role: 'DEVELOPER' });
    const req = request();
    const res = response();
    const next = jest.fn();

    await requireGlobalDeveloperIdentity(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('denies a non-owner even with a current DEVELOPER DB role', async () => {
    findUnique.mockResolvedValue({ role: 'DEVELOPER' });
    const req = request('223456789012345678', 'DEVELOPER');
    const res = response();
    const next = jest.fn();

    await requireGlobalDeveloperIdentity(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it('denies and revokes a stale owner DEVELOPER session when the DB user no longer exists', async () => {
    findUnique.mockResolvedValue(null);
    const req = request('123456789012345678', 'DEVELOPER');
    const res = response();
    const next = jest.fn();

    await requireGlobalDeveloperIdentity(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(
      'DEV_IDENTITY_DENIED',
      'SECURITY',
      expect.objectContaining({ reason: 'DB_USER_MISSING' }),
    );
  });
});
