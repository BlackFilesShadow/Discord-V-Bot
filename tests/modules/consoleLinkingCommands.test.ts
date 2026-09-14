import fs from 'node:fs';
import path from 'node:path';
import {
  linkCommand,
  unlinkCommand,
  linksCommand,
  linkInfoCommand,
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

  it('stellt Unlink, Liste und GUID-Lookup als eigene Funktionen bereit', () => {
    expect(unlinkCommand.data.name).toBe('unlink');
    expect(linksCommand.data.name).toBe('links');
    expect(linkInfoCommand.data.name).toBe('link-info');
    expect(option(linkInfoCommand, 'user')).toBeDefined();
    expect(option(linkInfoCommand, 'id')).toBeDefined();
  });

  it('bietet den persistenten Verknuepfungs-Kanal ausschliesslich ueber das Dashboard an (kein /link-panel mehr)', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/commands/dashboard/linking.ts'),
      'utf8',
    );
    expect(source).not.toContain("linkPanelCommand");
    expect(source).not.toContain(".setName('link-panel')");
    expect(source).not.toContain('publishLinkingInfoEmbed');

    const inventorySource = fs.readFileSync(
      path.resolve(__dirname, '../../src/commands/inventory.ts'),
      'utf8',
    );
    expect(inventorySource).toContain("MOVED_TO_DASHBOARD = new Set<string>([");
    expect(inventorySource.slice(
      inventorySource.indexOf('MOVED_TO_DASHBOARD = new Set<string>(['),
      inventorySource.indexOf('SPEC_KEEP_COMMANDS'),
    )).toContain("'link-panel'");
    expect(inventorySource.slice(
      inventorySource.indexOf('SPEC_KEEP_COMMANDS = new Set<string>(['),
    )).not.toContain("'link-panel'");
  });

  it('bietet den Verknuepfungs-Kanal als eigene Karte im Whitelist-Tab an, mit strikt allen Text-/Ankuendigungskanaelen', () => {
    const ui = fs.readFileSync(
      path.resolve(__dirname, '../../dashboard-ui/src/pages/ServerSlot.tsx'),
      'utf8',
    );

    expect(ui).toContain('function LinkPanelChannelCard(');
    expect(ui).toContain('<WhitelistChannelsCard guildId={guildId} slot={slot} />');
    expect(ui).toContain('<LinkPanelChannelCard guildId={guildId} slot={slot} />');
    expect(ui.indexOf('<WhitelistChannelsCard guildId={guildId} slot={slot} />'))
      .toBeLessThan(ui.indexOf('<LinkPanelChannelCard guildId={guildId} slot={slot} />'));

    const cardSource = ui.slice(ui.indexOf('function LinkPanelChannelCard('), ui.indexOf('function ChannelPicker('));
    expect(cardSource).toContain('/api/v2/guilds/${guildId}/economy-links/channel${qs}');
    expect(cardSource).toContain('/api/v2/guilds/${guildId}/economy-links/channel/repost${qs}');
    // Strikt alle Text-/Ankuendigungskanaele: dieselbe ungefilterte /channels-Quelle
    // wie die Whitelist-Kanal-Integration, NICHT der bot-berechtigungsgefilterte
    // dashboardChannels() aus economyLink.ts.
    expect(cardSource).toContain('/api/v2/guilds/${guildId}/channels');
    expect(cardSource).toContain("filter(c => c.type === 0 || c.type === 5)");
  });

  it('/link-info zeigt ohne Suchwert den eigenen Link und schuetzt Fremdabfragen weiter mit economy.view', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/commands/dashboard/linking.ts'),
      'utf8',
    );

    expect(String(linkInfoCommand.data.description)).toContain('deine Verknüpfung');
    expect(source).toContain("execute: withGuildScope({ acceptSlotOption: true }, async (interaction, scope) => {");
    expect(source).toContain('const selfLookup = !identifier && (!user || user.id === scope.actorDiscordId);');
    expect(source).toContain("if (!selfLookup && !hasCommandPermission(scope, 'economy.view'))");
    expect(source).toContain('? { userDiscordId: scope.actorDiscordId }');
    expect(source).toContain("selfLookup ? '🔗 Deine DayZ-Verknüpfung' : '🔎 Link-Information'");
    expect(source).toContain('Gameserver: **${alias}**');
    expect(source).toContain('Verknüpft seit: ${linkedAt}');
    expect(source).toContain("? `Du bist auf **${alias}** noch nicht mit einer DayZ-Identität verknüpft. Nutze \\`/link\\`, um deine Verbindung einzurichten.`");
  });

  it('persistiert den Link-Kanal ausschliesslich ueber die Dashboard-API', () => {
    const routeSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/dashboard/routes/v2/economyLink.ts'),
      'utf8',
    );
    const prismaSource = fs.readFileSync(
      path.resolve(__dirname, '../../prisma/linking-channel.prisma'),
      'utf8',
    );

    expect(routeSource).toContain('publishLinkingInfoEmbed');
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
