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
import { guardDevXpGuildObjects } from '../../src/dashboard/middleware/devXpScopeGuard';

const mockedClient = tryGetDashboardClient as jest.MockedFunction<typeof tryGetDashboardClient>;
const GUILD = '123456789012345678';
const OTHER_GUILD = '223456789012345678';
const ROLE = '323456789012345678';
const CHANNEL = '423456789012345678';

function responseMock() {
  const res = {
    status: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as Response & { status: jest.Mock; json: jest.Mock };
}

function requestMock(path: string, method = 'GET', body: Record<string, unknown> = {}, restrict?: string): Request {
  return {
    path,
    method,
    body,
    devSession: restrict ? { scope: { guildIdRestrict: restrict } } : { scope: {} },
  } as unknown as Request;
}

function guildFixture() {
  const role = { id: ROLE, managed: false };
  const channel = { id: CHANNEL };
  return {
    id: GUILD,
    roles: {
      cache: new Map([[ROLE, role]]),
      fetch: jest.fn(async (id: string) => id === ROLE ? role : null),
    },
    channels: {
      cache: new Map([[CHANNEL, channel]]),
      fetch: jest.fn(async (id: string) => id === CHANNEL ? channel : null),
    },
  };
}

function installClient(guild = guildFixture()) {
  mockedClient.mockReturnValue({
    guilds: {
      cache: new Map([[GUILD, guild]]),
      fetch: jest.fn(async (id: string) => id === GUILD ? guild : null),
    },
  } as never);
}

describe('guardDevXpGuildObjects', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    installClient();
  });

  it('laesst Nicht-XP-Routen unveraendert durch', async () => {
    const next = jest.fn() as NextFunction;
    const res = responseMock();
    await guardDevXpGuildObjects(requestMock('/diagnostics'), res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('blockiert XP fuer Guilds, auf denen der Bot nicht verfuegbar ist', async () => {
    const next = jest.fn() as NextFunction;
    const res = responseMock();
    await guardDevXpGuildObjects(requestMock(`/xp/${OTHER_GUILD}`), res, next);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  it('respektiert eine eingeschraenkte DEV-Session fail-closed', async () => {
    const next = jest.fn() as NextFunction;
    const res = responseMock();
    await guardDevXpGuildObjects(requestMock(`/xp/${GUILD}`, 'GET', {}, OTHER_GUILD), res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('akzeptiert nur Rollen und Channels der ausgewaehlten Guild', async () => {
    const next = jest.fn() as NextFunction;
    const res = responseMock();
    await guardDevXpGuildObjects(requestMock(`/xp/${GUILD}`, 'PATCH', {
      maxLevelRoleId: ROLE,
      allowedRoleIds: [ROLE],
      allowedChannelIds: [CHANNEL],
    }), res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('blockiert fremde Rollen in allowedRoleIds', async () => {
    const next = jest.fn() as NextFunction;
    const res = responseMock();
    await guardDevXpGuildObjects(requestMock(`/xp/${GUILD}`, 'PATCH', {
      allowedRoleIds: ['523456789012345678'],
    }), res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('blockiert fremde Channels in allowedChannelIds', async () => {
    const next = jest.fn() as NextFunction;
    const res = responseMock();
    await guardDevXpGuildObjects(requestMock(`/xp/${GUILD}`, 'PATCH', {
      allowedChannelIds: ['623456789012345678'],
    }), res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('blockiert managed Rollen und @everyone', async () => {
    const managed = { id: ROLE, managed: true };
    const everyone = { id: GUILD, managed: false };
    const guild = guildFixture();
    guild.roles.cache = new Map([[ROLE, managed], [GUILD, everyone]]) as never;
    guild.roles.fetch = jest.fn(async (id: string) => id === ROLE ? managed : id === GUILD ? everyone : null) as never;
    installClient(guild);

    const resManaged = responseMock();
    await guardDevXpGuildObjects(requestMock(`/xp/${GUILD}`, 'PATCH', { maxLevelRoleId: ROLE }), resManaged, jest.fn());
    expect(resManaged.status).toHaveBeenCalledWith(400);

    const resEveryone = responseMock();
    await guardDevXpGuildObjects(requestMock(`/xp/${GUILD}`, 'PATCH', { maxLevelRoleId: GUILD }), resEveryone, jest.fn());
    expect(resEveryone.status).toHaveBeenCalledWith(400);
  });

  it('validiert auch Level-Rollen gegen die echte Guild', async () => {
    const okNext = jest.fn() as NextFunction;
    await guardDevXpGuildObjects(requestMock(`/xp/${GUILD}/level-role/10`, 'PUT', { roleId: ROLE }), responseMock(), okNext);
    expect(okNext).toHaveBeenCalledTimes(1);

    const badNext = jest.fn() as NextFunction;
    const badRes = responseMock();
    await guardDevXpGuildObjects(requestMock(`/xp/${GUILD}/level-role/10`, 'PUT', { roleId: '723456789012345678' }), badRes, badNext);
    expect(badRes.status).toHaveBeenCalledWith(400);
    expect(badNext).not.toHaveBeenCalled();
  });
});
