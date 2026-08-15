process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

jest.mock('../../src/dashboard/clientRegistry', () => ({
  tryGetDashboardClient: jest.fn(),
}));

import express from 'express';
import request from 'supertest';
import { Collection, SlashCommandBuilder } from 'discord.js';
import type { Command, ExtendedClient } from '../../src/types';
import { tryGetDashboardClient } from '../../src/dashboard/clientRegistry';
import { commandCatalogRouter } from '../../src/dashboard/routes/v2/commandCatalog';

const clientMock = tryGetDashboardClient as jest.MockedFunction<typeof tryGetDashboardClient>;

function command(name: string, flags: Partial<Pick<Command, 'adminOnly' | 'devOnly' | 'manufacturerOnly'>> = {}): Command {
  return {
    data: new SlashCommandBuilder().setName(name).setDescription(`${name} description`),
    execute: async () => undefined,
    ...flags,
  } as Command;
}

function fakeClient(): ExtendedClient {
  const commands = new Collection<string, Command>();
  commands.set('help', command('help'));
  commands.set('ping', command('ping'));
  commands.set('admin-stats', command('admin-stats', { adminOnly: true }));
  commands.set('dev-eval', command('dev-eval', { devOnly: true }));
  commands.set('upload', command('upload', { manufacturerOnly: true }));
  return {
    commands,
    commandSources: new Map([
      ['help', 'user/help.ts'],
      ['ping', 'user/ping.ts'],
      ['admin-stats', 'admin/adminStats.ts'],
      ['dev-eval', 'developer/devEval.ts'],
      ['upload', 'user/upload.ts'],
    ]),
  } as unknown as ExtendedClient;
}

function app() {
  const instance = express();
  instance.use('/command-catalog', commandCatalogRouter);
  return instance;
}

describe('Bot-Admin command catalog route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clientMock.mockReturnValue(fakeClient());
  });

  it('liefert nur Commands, die der Discord-Deploy ebenfalls behalten wuerde', async () => {
    const res = await request(app()).get('/command-catalog');
    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(true);
    expect(res.body.commands.map((entry: { name: string }) => entry.name)).toEqual(['help', 'upload']);
    expect(res.body.commands.every((entry: { staysInDiscord: boolean }) => entry.staysInDiscord)).toBe(true);
    expect(res.body.summary).toMatchObject({ total: 2, manufacturer: 1 });
  });

  it('failt mit 503 statt einen leeren erfolgreichen Katalog zu simulieren wenn der Discord-Client fehlt', async () => {
    clientMock.mockReturnValue(null);
    const res = await request(app()).get('/command-catalog');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ ready: false, commands: [], summary: null });
  });
});
