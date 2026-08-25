import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

const v2Source = read('src/dashboard/routes/v2.ts');
const routeSource = read('src/dashboard/routes/v2/goodbye.ts');
const emitterSource = read('src/dashboard/socket/emitter.ts');
const wrapperSource = read('dashboard-ui/src/components/WelcomeTab.tsx');
const panelSource = read('dashboard-ui/src/components/GoodbyePanel.tsx');

describe('Goodbye-1 dashboard wiring', () => {
  it('mounts the goodbye router under the authenticated v2 guild scope', () => {
    expect(v2Source).toContain("import { goodbyeRouter } from './v2/goodbye';");
    expect(v2Source).toContain("v2Router.use('/guilds/:guildId/goodbye', goodbyeRouter);");
    expect(v2Source.indexOf('v2Router.use(requireAuth);')).toBeLessThan(v2Source.indexOf("'/guilds/:guildId/goodbye'"));
  });

  it('reuses welcome view/manage permissions and central bot channel validation', () => {
    expect(routeSource).toContain("requireGuildPermission('welcome.view')");
    expect(routeSource).toContain("requireGuildPermission('welcome.manage')");
    expect(routeSource).toContain('validateBotChannelAccess');
    expect(routeSource).toContain('PermissionFlagsBits.ViewChannel');
    expect(routeSource).toContain('PermissionFlagsBits.SendMessages');
  });

  it('registers goodbye.changed in the central typed guild socket contract', () => {
    expect(routeSource).toContain("type: 'goodbye.changed'");
    expect(emitterSource).toContain("| { type: 'goodbye.changed'; payload: { guildId: string } }");
  });

  it('keeps existing Welcome UI isolated and composes Goodbye beside it', () => {
    expect(wrapperSource).toContain("import { WelcomeTab as WelcomeCoreTab } from './WelcomeCoreTab';");
    expect(wrapperSource).toContain("import { GoodbyePanel } from './GoodbyePanel';");
    expect(wrapperSource).toContain('<WelcomeCoreTab {...props} />');
    expect(wrapperSource).toContain('<GoodbyePanel {...props} />');
  });

  it('uses the existing guild channel cache and a real channel dropdown', () => {
    expect(panelSource).toContain("queryKey: ['guild-channels', guildId]");
    expect(panelSource).toContain('`/api/v2/guilds/${guildId}/channels`');
    expect(panelSource).toContain('<Select value={channelId}');
    expect(panelSource).toContain('channel.type === 0 || channel.type === 5');
  });

  it('wires config, test and disable actions and keeps the mention automatic', () => {
    expect(panelSource).toContain('`/api/v2/guilds/${guildId}/goodbye/config`');
    expect(panelSource).toContain('`/api/v2/guilds/${guildId}/goodbye/test`');
    expect(panelSource).toContain('`/api/v2/guilds/${guildId}/goodbye/disable`');
    expect(panelSource).toContain("{ key: '{nickname}'");
    expect(panelSource).toContain("{ key: '{username}'");
    expect(panelSource).not.toContain("{ key: '{mention}'");
    expect(panelSource).toContain('erscheint automatisch anstelle des Namens im Feld „Discord-Name“');
  });
});
