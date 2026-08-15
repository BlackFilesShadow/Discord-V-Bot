process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

jest.mock('../../src/dashboard/clientRegistry', () => ({ tryGetDashboardClient: jest.fn() }));

import type { NextFunction, Request, Response } from 'express';
import { tryGetDashboardClient } from '../../src/dashboard/clientRegistry';
import { guardBotAdminGuildReferences } from '../../src/dashboard/middleware/botAdminGuildReferenceGuard';

const clientMock = tryGetDashboardClient as jest.MockedFunction<typeof tryGetDashboardClient>;
const GUILD = '123456789012345678';
const CHANNEL = '223456789012345678';
const ROLE = '323456789012345678';

function responseMock() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as Response & { status: jest.Mock; json: jest.Mock };
}

function requestMock(body: Record<string, unknown> = {}, query: Record<string, unknown> = {}): Request {
  return { body, query } as unknown as Request;
}

function installClient(options?: { guild?: boolean; channel?: boolean; role?: boolean; managedRole?: boolean }) {
  const channel = { id: CHANNEL, name: 'chat' };
  const role = { id: ROLE, name: 'Member', managed: options?.managedRole ?? false };
  const guild = {
    id: GUILD,
    channels: {
      cache: new Map(options?.channel === false ? [] : [[CHANNEL, channel]]),
      fetch: jest.fn(async (id: string) => options?.channel === false || id !== CHANNEL ? null : channel),
    },
    roles: {
      cache: new Map(options?.role === false ? [] : [[ROLE, role]]),
      fetch: jest.fn(async (id: string) => options?.role === false || id !== ROLE ? null : role),
    },
  };
  const hasGuild = options?.guild !== false;
  clientMock.mockReturnValue({
    guilds: {
      cache: new Map(hasGuild ? [[GUILD, guild]] : []),
      fetch: jest.fn(async (id: string) => hasGuild && id === GUILD ? guild : null),
    },
  } as never);
}

describe('guardBotAdminGuildReferences', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    installClient();
  });

  it('laesst globale Bot-Admin-Routen ohne guildId durch', async () => {
    const next = jest.fn() as NextFunction;
    await guardBotAdminGuildReferences(requestMock(), responseMock(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('blockiert syntaktisch gueltige aber fuer den Bot nicht verfuegbare Guilds', async () => {
    installClient({ guild: false });
    const res = responseMock();
    const next = jest.fn() as NextFunction;
    await guardBotAdminGuildReferences(requestMock({ guildId: GUILD }), res, next);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  it('blockiert fremde Channel-IDs bevor sie persistiert werden', async () => {
    installClient({ channel: false });
    const res = responseMock();
    const next = jest.fn() as NextFunction;
    await guardBotAdminGuildReferences(requestMock({ guildId: GUILD, channelId: CHANNEL }), res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('blockiert fremde oder managed Rollen', async () => {
    installClient({ role: false });
    const missing = responseMock();
    await guardBotAdminGuildReferences(requestMock({ guildId: GUILD, roleId: ROLE }), missing, jest.fn());
    expect(missing.status).toHaveBeenCalledWith(400);

    installClient({ managedRole: true });
    const managed = responseMock();
    await guardBotAdminGuildReferences(requestMock({ guildId: GUILD, roleId: ROLE }), managed, jest.fn());
    expect(managed.status).toHaveBeenCalledWith(400);
  });

  it('laesst echte Guild-/Channel-/Role-Referenzen durch', async () => {
    const res = responseMock();
    const next = jest.fn() as NextFunction;
    await guardBotAdminGuildReferences(requestMock({ guildId: GUILD, channelId: CHANNEL, roleId: ROLE }), res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
