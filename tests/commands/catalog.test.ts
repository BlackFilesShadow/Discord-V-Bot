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
  commands.set('ping', cmd('ping'));
  commands.set('admin-stats', cmd('admin-stats', { adminOnly: true }));
  commands.set('dev-eval', cmd('dev-eval', { devOnly: true }));
  commands.set('upload', cmd('upload', { manufacturerOnly: true }));
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

describe('central command catalog', () => {
  it('derives metadata from the complete live loader registry for diagnostics', () => {
    const entries = buildCommandCatalog(client());
    expect(entries.map((e) => e.name)).toEqual(['admin-stats', 'dev-eval', 'help', 'ping', 'upload']);
    expect(entries.find((e) => e.name === 'dev-eval')).toMatchObject({ audience: 'developer', category: 'dev', staysInDiscord: false });
    expect(entries.find((e) => e.name === 'admin-stats')).toMatchObject({ audience: 'admin', category: 'admin', staysInDiscord: false });
    expect(entries.find((e) => e.name === 'ping')).toMatchObject({ migrationStatus: 'moved_to_dashboard', staysInDiscord: false });
    expect(entries.find((e) => e.name === 'help')).toMatchObject({ migrationStatus: 'active', staysInDiscord: true });
  });

  it('uses deploy truth to hide migrated and privileged commands from public help', () => {
    const visible = visibleCommandCatalog(client(), { isAdmin: false, isDeveloper: false, isManufacturer: false });
    expect(visible.map((e) => e.name)).toEqual(['help']);
  });

  it('never re-exposes moved admin/dev commands even to privileged viewers', () => {
    const admin = visibleCommandCatalog(client(), { isAdmin: true, isDeveloper: false, isManufacturer: false });
    expect(admin.map((e) => e.name)).toEqual(['help']);

    const dev = visibleCommandCatalog(client(), { isAdmin: true, isDeveloper: true, isManufacturer: true });
    expect(dev.map((e) => e.name)).toEqual(['help', 'upload']);
  });

  it('keeps the explicit manufacturer Discord exception visible to manufacturers', () => {
    const manufacturer = visibleCommandCatalog(client(), { isAdmin: false, isDeveloper: false, isManufacturer: true });
    expect(manufacturer.map((e) => e.name)).toEqual(['help', 'upload']);
  });
});
