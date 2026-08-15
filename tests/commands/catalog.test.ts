import { Collection, SlashCommandBuilder } from 'discord.js';
import type { Command, ExtendedClient } from '../../src/types';
import { buildCommandCatalog, visibleCommandCatalog } from '../../src/commands/catalog';

function cmd(name: string, flags: Partial<Pick<Command, 'adminOnly' | 'devOnly' | 'manufacturerOnly'>> = {}): Command {
  return {
    data: new SlashCommandBuilder().setName(name).setDescription(`${name} description`),
    execute: async () => undefined,
    ...flags,
  } as Command;
}

function client(): ExtendedClient {
  const commands = new Collection<string, Command>();
  commands.set('help', cmd('help'));
  commands.set('ai', cmd('ai'));
  commands.set('ping', cmd('ping'));
  commands.set('admin-stats', cmd('admin-stats', { adminOnly: true }));
  commands.set('dev-eval', cmd('dev-eval', { devOnly: true }));
  commands.set('upload', cmd('upload', { manufacturerOnly: true }));
  return {
    commands,
    commandSources: new Map([
      ['help', 'user/help.ts'],
      ['ai', 'user/ai.ts'],
      ['ping', 'user/ping.ts'],
      ['admin-stats', 'admin/adminStats.ts'],
      ['dev-eval', 'developer/devEval.ts'],
      ['upload', 'user/upload.ts'],
    ]),
  } as unknown as ExtendedClient;
}

describe('central command catalog', () => {
  it('derives metadata from the complete live loader registry for diagnostics', () => {
    const entries = buildCommandCatalog(client());
    expect(entries.map(entry => entry.name)).toEqual(['admin-stats', 'ai', 'dev-eval', 'help', 'ping', 'upload']);
    expect(entries.find(entry => entry.name === 'dev-eval')).toMatchObject({ audience: 'developer', category: 'dev', staysInDiscord: false });
    expect(entries.find(entry => entry.name === 'admin-stats')).toMatchObject({ audience: 'admin', category: 'admin', staysInDiscord: false });
    expect(entries.find(entry => entry.name === 'ping')).toMatchObject({ migrationStatus: 'moved_to_dashboard', staysInDiscord: false });
    expect(entries.find(entry => entry.name === 'help')).toMatchObject({ migrationStatus: 'active', staysInDiscord: true });
    expect(entries.find(entry => entry.name === 'ai')).toMatchObject({ migrationStatus: 'active', staysInDiscord: true });
  });

  it('uses deploy truth and product visibility to hide migrated, DEV and /ai from public help', () => {
    const visible = visibleCommandCatalog(client(), { isAdmin: false, isDeveloper: false, isManufacturer: false });
    expect(visible.map(entry => entry.name)).toEqual(['help']);
  });

  it('keeps DEV and /ai invisible even to privileged viewers', () => {
    const admin = visibleCommandCatalog(client(), { isAdmin: true, isDeveloper: false, isManufacturer: false });
    expect(admin.map(entry => entry.name)).toEqual(['help']);

    const dev = visibleCommandCatalog(client(), { isAdmin: true, isDeveloper: true, isManufacturer: true });
    expect(dev.map(entry => entry.name)).toEqual(['help', 'upload']);
  });

  it('keeps the explicit manufacturer Discord exception visible to manufacturers', () => {
    const manufacturer = visibleCommandCatalog(client(), { isAdmin: false, isDeveloper: false, isManufacturer: true });
    expect(manufacturer.map(entry => entry.name)).toEqual(['help', 'upload']);
  });
});
