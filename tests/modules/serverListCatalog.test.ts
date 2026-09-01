import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

describe('server list catalog', () => {
  const catalog = read('src/modules/nitrado/serverListCatalog.ts');
  const runtime = read('src/modules/nitrado/runtime.ts');
  const composite = read('src/events/interactionCreateComposite.ts');
  const whitelistRoute = read('src/dashboard/routes/v2/whitelist.ts');
  const migration = read('prisma/migrations/20260901120000_server_list_catalog_channels/migration.sql');

  it('persists separate whitelist and ban catalog anchors per guild and gameserver', () => {
    expect(migration).toContain('"whitelistCatalogChannelId"');
    expect(migration).toContain('"whitelistCatalogMessageId"');
    expect(migration).toContain('"banCatalogChannelId"');
    expect(migration).toContain('"banCatalogMessageId"');
    expect(catalog).toContain('guildId_nitradoConnId');
    expect(catalog).toContain('whitelistCatalogChannelId');
    expect(catalog).toContain('banCatalogChannelId');
  });

  it('reads the live Nitrado lists and refreshes configured catalog embeds every three minutes', () => {
    expect(catalog).toContain('const SYNC_INTERVAL_MS = 3 * 60_000');
    expect(catalog).toContain('client.getWhitelist');
    expect(catalog).toContain('client.getBanlist');
    expect(catalog).toContain('void syncConfiguredCatalogs(client)');
    expect(runtime).toContain('startServerListCatalogSync(client)');
    expect(runtime).toContain('stopServerListCatalogSync()');
  });

  it('uses paged fixed embeds with arrows, refresh and modal search', () => {
    expect(catalog).toContain('const PAGE_SIZE = 20');
    expect(catalog).toContain("setLabel('◀')");
    expect(catalog).toContain("setLabel('▶')");
    expect(catalog).toContain("setLabel('Suchen')");
    expect(catalog).toContain("setLabel('Aktualisieren')");
    expect(catalog).toContain('new ModalBuilder()');
    expect(catalog).toContain('findIndex');
    expect(composite).toContain("i.customId.startsWith('listcat:')");
    expect(composite).toContain("i.customId.startsWith('listcat_search:')");
  });

  it('exposes independent dashboard configuration without reusing approval channels', () => {
    expect(whitelistRoute).toContain('whitelistCatalogChannelId');
    expect(whitelistRoute).toContain('banCatalogChannelId');
    expect(whitelistRoute).toContain('syncServerListCatalog(client, scope.guildId, connId, kind)');
  });
});
