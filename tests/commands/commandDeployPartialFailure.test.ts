process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

import { Collection, REST, SlashCommandBuilder } from 'discord.js';
import type { Command, ExtendedClient } from '../../src/types';
import { deployCommandsScoped } from '../../src/commands/handler';

function command(name: string): Command {
  return {
    data: new SlashCommandBuilder().setName(name).setDescription(`test ${name}`),
    execute: async () => undefined,
  } as Command;
}

function client(): ExtendedClient {
  const commands = new Collection<string, Command>();
  commands.set('help', command('help'));
  return {
    commands,
    commandSources: new Map([['help', 'user/help.ts']]),
  } as unknown as ExtendedClient;
}

describe('deployCommandsScoped partial failure reporting', () => {
  afterEach(() => jest.restoreAllMocks());

  it('liefert fehlgeschlagene Guilds explizit statt still Erfolg zu melden', async () => {
    const failed = '223456789012345678';
    jest.spyOn(REST.prototype, 'put').mockImplementation(async (route: string) => {
      if (String(route).includes(failed)) throw new Error('Discord rejected guild deploy');
      return {} as never;
    });

    const result = await deployCommandsScoped(
      client(),
      'token',
      'client-id',
      ['123456789012345678', failed],
    );

    expect(result).toMatchObject({ guildsOk: 1, guildsFailed: 1, failedGuildIds: [failed] });
  });

  it('meldet bei vollstaendig erfolgreichem Deploy keine Fehler-Guilds', async () => {
    jest.spyOn(REST.prototype, 'put').mockResolvedValue({} as never);
    const result = await deployCommandsScoped(client(), 'token', 'client-id', ['123456789012345678']);
    expect(result.guildsOk).toBe(1);
    expect(result.guildsFailed).toBe(0);
    expect(result.failedGuildIds).toEqual([]);
  });
});
