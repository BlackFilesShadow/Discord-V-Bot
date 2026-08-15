process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    xpConfig: { findUnique: jest.fn() },
    levelRole: { findMany: jest.fn() },
  },
}));

jest.mock('../../src/dashboard/clientRegistry', () => ({ tryGetDashboardClient: jest.fn() }));

import express from 'express';
import request from 'supertest';
import { ChannelType } from 'discord.js';
import prisma from '../../src/database/prisma';
import { tryGetDashboardClient } from '../../src/dashboard/clientRegistry';
import { devXpViewRouter } from '../../src/dashboard/routes/v2/devXpView';

const findConfig = prisma.xpConfig.findUnique as jest.Mock;
const findLevelRoles = prisma.levelRole.findMany as jest.Mock;
const clientMock = tryGetDashboardClient as jest.MockedFunction<typeof tryGetDashboardClient>;
const GUILD = '123456789012345678';

function app() {
  const instance = express();
  instance.use((req, _res, next) => {
    req.devSession = {
      id: 'session',
      userDiscordId: '999999999999999999',
      scope: {},
      expiresAt: new Date(Date.now() + 60_000),
      mfa: { ok: true },
    };
    next();
  });
  instance.use(devXpViewRouter);
  return instance;
}

function installDiscord() {
  const guild = {
    id: GUILD,
    roles: { cache: new Map([['223456789012345678', { id: '223456789012345678', name: 'Member', managed: false }]]) },
    channels: { cache: new Map([
      ['323456789012345678', { id: '323456789012345678', name: 'chat', type: ChannelType.GuildText }],
      ['423456789012345678', { id: '423456789012345678', name: 'voice', type: ChannelType.GuildVoice }],
    ]) },
  };
  clientMock.mockReturnValue({
    guilds: {
      cache: new Map([[GUILD, guild]]),
      fetch: jest.fn(async (id: string) => id === GUILD ? guild : null),
    },
  } as never);
}

describe('DEV XP read-only view', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findLevelRoles.mockResolvedValue([]);
    installDiscord();
  });

  it('liefert Prisma-Defaults ohne eine Config-Zeile anzulegen', async () => {
    findConfig.mockResolvedValue(null);
    const res = await request(app()).get(`/xp/${GUILD}`);
    expect(res.status).toBe(200);
    expect(res.body.persisted).toBe(false);
    expect(res.body.config).toMatchObject({
      id: GUILD,
      messageXpMin: 15,
      messageXpMax: 25,
      voiceXpPerMinute: 5,
      levelMultiplier: 1,
      maxLevel: 20,
    });
    expect(findConfig).toHaveBeenCalledWith({ where: { id: GUILD } });
  });

  it('liefert eine vorhandene Config unveraendert als persistiert', async () => {
    findConfig.mockResolvedValue({ id: GUILD, messageXpMin: 20, messageXpMax: 30 });
    const res = await request(app()).get(`/xp/${GUILD}`);
    expect(res.status).toBe(200);
    expect(res.body.persisted).toBe(true);
    expect(res.body.config).toMatchObject({ id: GUILD, messageXpMin: 20, messageXpMax: 30 });
  });

  it('bietet Text- und Voice-Channels an, weil beide XP erhalten koennen', async () => {
    findConfig.mockResolvedValue(null);
    const res = await request(app()).get(`/xp/${GUILD}`);
    expect(res.status).toBe(200);
    expect(res.body.channelOptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'chat', type: ChannelType.GuildText }),
      expect.objectContaining({ name: 'voice', type: ChannelType.GuildVoice }),
    ]));
  });

  it('failt geschlossen wenn die Guild fuer den Bot nicht verfuegbar ist', async () => {
    findConfig.mockResolvedValue(null);
    clientMock.mockReturnValue({ guilds: { cache: new Map(), fetch: jest.fn().mockResolvedValue(null) } } as never);
    const res = await request(app()).get(`/xp/${GUILD}`);
    expect(res.status).toBe(404);
  });
});
