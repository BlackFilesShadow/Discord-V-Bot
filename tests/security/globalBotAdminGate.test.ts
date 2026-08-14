const findUnique = jest.fn();
const updateMany = jest.fn();
const logAudit = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    user: { findUnique },
    botAdminSession: { updateMany },
  },
}));
jest.mock('../../src/config', () => ({
  config: { discord: { ownerId: '123456789012345678' } },
}));
jest.mock('../../src/utils/logger', () => ({ logAudit }));

import { requireGlobalBotAdminIdentity } from '../../src/dashboard/middleware/globalBotAdminGate';

function request(discordId = '223456789012345678', role = 'USER') {
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

describe('requireGlobalBotAdminIdentity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    updateMany.mockResolvedValue({ count: 1 });
  });

  it('denies ordinary users even if they might know the shared password', async () => {
    findUnique.mockResolvedValue({ role: 'USER' });
    const req = request();
    const res = response();
    const next = jest.fn();

    await requireGlobalBotAdminIdentity(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it('allows authenticated global admin roles', async () => {
    findUnique.mockResolvedValue({ role: 'ADMIN' });
    const req = request();
    const res = response();
    const next = jest.fn();

    await requireGlobalBotAdminIdentity(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('allows the canonical owner for recovery without relying on a name', async () => {
    findUnique.mockResolvedValue({ role: 'USER' });
    const req = request('123456789012345678');
    const res = response();
    const next = jest.fn();

    await requireGlobalBotAdminIdentity(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});
