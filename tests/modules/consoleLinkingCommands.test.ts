import fs from 'node:fs';
import path from 'node:path';
import {
  linkCommand,
  unlinkCommand,
  linksCommand,
  linkInfoCommand,
  linkPanelCommand,
} from '../../src/commands/dashboard/linking';
import { forceLinkCommand, forceUnlinkCommand } from '../../src/commands/dashboard/privileged';

function options(command: { data: { toJSON: () => { options?: Array<Record<string, unknown>> } } }) {
  return command.data.toJSON().options ?? [];
}

function option(command: Parameters<typeof options>[0], name: string): Record<string, unknown> | undefined {
  return options(command).find(item => item.name === name);
}

describe('Konsolen-taugliche Account-Verknuepfung', () => {
  it('/link verlangt den exakten Spielernamen und keine Plattformauswahl', () => {
    const json = linkCommand.data.toJSON();
    expect(json.name).toBe('link');
    expect(String(json.description)).toContain('5 Minuten');
    expect(option(linkCommand, 'id')).toEqual(expect.objectContaining({
      name: 'id',
      required: true,
      min_length: 1,
      max_length: 64,
    }));
    expect(option(linkCommand, 'slot')).toEqual(expect.objectContaining({ name: 'slot', required: false }));
    expect(option(linkCommand, 'platform')).toBeUndefined();
  });

  it('stellt Unlink, Liste, GUID-Lookup und persistenten Kanal als eigene Funktionen bereit', () => {
    expect(unlinkCommand.data.name).toBe('unlink');
    expect(linksCommand.data.name).toBe('links');
    expect(linkInfoCommand.data.name).toBe('link-info');
    expect(linkPanelCommand.data.name).toBe('link-panel');
    expect(String(linkPanelCommand.data.description)).toContain('persistenten');
    expect(option(linkInfoCommand, 'user')).toBeDefined();
    expect(option(linkInfoCommand, 'id')).toBeDefined();
    expect(option(linkPanelCommand, 'channel')).toEqual(expect.objectContaining({ required: true }));
  });

  it('persistiert den Link-Kanal und bietet dieselbe Konfiguration ueber die Dashboard-API an', () => {
    const commandSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/commands/dashboard/linking.ts'),
      'utf8',
    );
    const routeSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/dashboard/routes/v2/economyLink.ts'),
      'utf8',
    );
    const prismaSource = fs.readFileSync(
      path.resolve(__dirname, '../../prisma/linking-channel.prisma'),
      'utf8',
    );

    expect(commandSource).toContain('publishLinkingInfoEmbed');
    expect(routeSource).toContain("economyLinkRouter.get('/channel'");
    expect(routeSource).toContain("economyLinkRouter.patch('/channel'");
    expect(routeSource).toContain("economyLinkRouter.post('/channel/repost'");
    expect(prismaSource).toContain('model LinkingChannelConfig');
    expect(prismaSource).toContain('@@unique([guildId, nitradoConnId])');
  });

  it('Force-Link arbeitet mit einem Spielernamen; Force-Unlink bleibt Discord-zentriert', () => {
    const forceId = option(forceLinkCommand, 'id');
    expect(forceId).toEqual(expect.objectContaining({ required: true, min_length: 1, max_length: 64 }));
    expect(String(forceId?.description)).toMatch(/PSN|Xbox|DayZ/i);
    expect(option(forceLinkCommand, 'user')).toEqual(expect.objectContaining({ required: true }));
    expect(option(forceUnlinkCommand, 'user')).toEqual(expect.objectContaining({ required: true }));
  });

  it('enthaelt in der kanonischen Economy-Commanddatei keinen alten Chat-Code-Link mehr', () => {
    const economySource = fs.readFileSync(
      path.resolve(__dirname, '../../src/commands/dashboard/economy.ts'),
      'utf8',
    );
    expect(economySource).not.toContain(".setName('link')");
    expect(economySource).not.toContain('createLinkChallenge');
    expect(economySource).not.toContain('Schreibe den folgenden Code');
  });
});

describe('/help Seitenstruktur', () => {
  it('hat pro Funktion eine Detailseite und links/rechts Navigation', () => {
    const helpSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/commands/user/help.ts'),
      'utf8',
    );
    expect(helpSource).toContain('function detailEmbed(');
    expect(helpSource).toContain(".setCustomId('help_prev')");
    expect(helpSource).toContain(".setCustomId('help_next')");
    expect(helpSource).toContain('Funktion ${index + 1}/${total}');
  });
});
