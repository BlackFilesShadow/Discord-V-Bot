process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

import { Collection, SlashCommandBuilder } from 'discord.js';
import type { Command, ExtendedClient } from '../../src/types';
import { splitCommandsByScope } from '../../src/commands/handler';

function command(name: string, flags: Partial<Pick<Command, 'adminOnly' | 'devOnly' | 'manufacturerOnly'>> = {}): Command {
  return {
    data: new SlashCommandBuilder().setName(name).setDescription(`test ${name}`),
    execute: async () => undefined,
    ...flags,
  } as Command;
}

function fakeClient(entries: Array<{ cmd: Command; source: string }>): ExtendedClient {
  const commands = new Collection<string, Command>();
  const sources = new Map<string, string>();
  for (const entry of entries) {
    commands.set(entry.cmd.data.name, entry.cmd);
    sources.set(entry.cmd.data.name, entry.source);
  }
  return { commands, commandSources: sources } as unknown as ExtendedClient;
}

describe('command deploy inventory guard', () => {
  it('deployed keine versehentlich wieder geladene dashboard-migrierte Admin-/DEV-Definition', () => {
    const client = fakeClient([
      { cmd: command('admin-audit', { adminOnly: true }), source: 'admin/adminAudit.ts' },
      { cmd: command('dev-reload', { devOnly: true }), source: 'developer/devReload.ts' },
      { cmd: command('help'), source: 'user/help.ts' },
    ]);

    const split = splitCommandsByScope(client);
    expect(split.global.map(x => x.name)).toEqual([]);
    expect(split.guild.map(x => x.name)).toEqual(['help']);
  });

  it('behaelt die ausdrueckliche Hersteller-Ausnahme global in Discord', () => {
    const client = fakeClient([
      { cmd: command('dev-manufacturer', { devOnly: true, manufacturerOnly: true }), source: 'developer/devManufacturer.ts' },
      { cmd: command('help'), source: 'user/help.ts' },
    ]);

    const split = splitCommandsByScope(client);
    expect(split.global.map(x => x.name)).toEqual(['dev-manufacturer']);
    expect(split.guild.map(x => x.name)).toEqual(['help']);
  });
});
