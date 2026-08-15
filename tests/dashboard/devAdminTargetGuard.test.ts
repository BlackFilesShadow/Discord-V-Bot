process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

jest.mock('../../src/dashboard/clientRegistry', () => ({
  tryGetDashboardClient: jest.fn(),
}));

import type { NextFunction, Request, Response } from 'express';
import { tryGetDashboardClient } from '../../src/dashboard/clientRegistry';
import { guardDevAdminTarget } from '../../src/dashboard/middleware/devAdminTargetGuard';

const mockedClient = tryGetDashboardClient as jest.MockedFunction<typeof tryGetDashboardClient>;
const USER_ID = '123456789012345678';

function responseMock() {
  const res = {
    status: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as Response & { status: jest.Mock; json: jest.Mock };
}

function requestMock(path: string, method = 'POST', discordId = USER_ID): Request {
  return {
    path,
    method,
    body: { discordId },
  } as unknown as Request;
}

describe('guardDevAdminTarget', () => {
  beforeEach(() => jest.clearAllMocks());

  it('laesst Nicht-Admin-Add-Routen unveraendert durch', async () => {
    const next = jest.fn() as NextFunction;
    const res = responseMock();
    await guardDevAdminTarget(requestMock('/database/cleanup'), res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('blockiert formal ungueltige Discord-IDs', async () => {
    const next = jest.fn() as NextFunction;
    const res = responseMock();
    await guardDevAdminTarget(requestMock('/admins', 'POST', 'not-a-snowflake'), res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('failt geschlossen wenn der Discord-Client nicht verfuegbar ist', async () => {
    mockedClient.mockReturnValue(null);
    const next = jest.fn() as NextFunction;
    const res = responseMock();
    await guardDevAdminTarget(requestMock('/admins'), res, next);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });

  it('legt keinen Phantom-Admin an wenn Discord den User nicht kennt', async () => {
    mockedClient.mockReturnValue({ users: { fetch: jest.fn().mockRejectedValue(new Error('unknown user')) } } as never);
    const next = jest.fn() as NextFunction;
    const res = responseMock();
    await guardDevAdminTarget(requestMock('/admins'), res, next);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  it('laesst einen real aufloesbaren Discord-User zum bestehenden Handler durch', async () => {
    mockedClient.mockReturnValue({ users: { fetch: jest.fn().mockResolvedValue({ id: USER_ID, username: 'real-user' }) } } as never);
    const next = jest.fn() as NextFunction;
    const res = responseMock();
    await guardDevAdminTarget(requestMock('/admins'), res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
